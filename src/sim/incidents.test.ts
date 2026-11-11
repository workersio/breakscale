import { describe, expect, it } from 'vitest';
import { applyLoad } from './challenge';
import { challengeById, CHALLENGES } from './challenges';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { captionAt, INCIDENTS, incidentById } from './incidents';
import type { Incident } from './incidents';
import { judge, startDesign } from './judge';
import { defaultConfig, PRESETS } from './presets';
import type { NodeConfig, NodeKind, RouteStats, Topology } from './types';

/*
 * An incident is three promises: the scene plays the failure the story
 * tells, the brief fails as it starts and passes with the fix the real
 * postmortem points at, and nothing about it leaks into the examples or
 * the existing briefs.
 */

function incident(id: string): Incident {
  const i = incidentById(id);
  if (!i) throw new Error(`no incident ${id}`);
  return i;
}

/** The design a reader starts the brief with. */
function opened(i: Incident): Topology {
  return applyLoad(structuredClone(startDesign(i.brief)), i.brief.loadRps);
}

type Edit = (t: Topology) => void;

const set =
  (id: string, config: Partial<NodeConfig>): Edit =>
  (t) => {
    const n = t.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    Object.assign(n.config, config);
  };

const add =
  (
    id: string,
    kind: NodeKind,
    x: number,
    y: number,
    config: Partial<NodeConfig> = {},
  ): Edit =>
  (t) => {
    t.nodes.push({
      id,
      kind,
      label: id,
      x,
      y,
      config: { ...defaultConfig(kind), ...config },
    });
  };

const wire =
  (from: string, to: string): Edit =>
  (t) => {
    t.edges.push({ id: `${from}->${to}`, from, to, weight: 1 });
  };

const unwire =
  (from: string, to: string): Edit =>
  (t) => {
    t.edges = t.edges.filter((e) => e.id !== `${from}->${to}`);
  };

const all =
  (...edits: Edit[]): Edit =>
  (t) => {
    for (const e of edits) e(t);
  };

function status(i: Incident, edit: Edit): string {
  const design = opened(i);
  edit(design);
  return judge(i.brief, design).status;
}

/** Route readings every five simulated seconds, keyed by the second. */
function timeline(t: Topology, seconds: number): Map<number, readonly RouteStats[]> {
  const engine = new Engine(t, 1);
  const out = new Map<number, readonly RouteStats[]>();
  for (let s = 1; s <= seconds; s++) {
    for (let k = 0; k < 60; k++) engine.advance(1000 / 60);
    if (s % 5 === 0) out.set(s, engine.routes());
  }
  return out;
}

function errorsAt(rows: Map<number, readonly RouteStats[]>, s: number): number[] {
  return (rows.get(s) ?? []).map((r) => Math.round(r.errorRate * 100));
}

/** A second region for the status console, behind a region router. */
const secondRegion = (extra: Partial<NodeConfig> = {}): Edit =>
  all(
    add('router', 'region', 450, 450, extra),
    add('s3b', 'objectstore', 600, 450),
    unwire('console', 's3'),
    wire('console', 'router'),
    wire('router', 's3'),
    wire('router', 's3b'),
  );

/** The edge split into `k` groups of `cap` slots, the rule on the first. */
const groups =
  (k: number, cap: number): Edit =>
  (t) => {
    set('edge', { capacity: cap })(t);
    for (let g = 2; g <= k; g++) {
      add(`edge${g}`, 'service', 560, 190 + g * 130, {
        capacity: cap,
        serviceMs: 4,
        serviceCv: 0.4,
        queueLimit: 256,
      })(t);
      wire('router', `edge${g}`)(t);
      wire(`edge${g}`, 'origin')(t);
    }
  };

describe('the set of incidents', () => {
  it('keeps out of the examples and the briefs', () => {
    for (const i of INCIDENTS) {
      expect(PRESETS.some((p) => p.id === i.id)).toBe(false);
      expect(CHALLENGES.some((c) => c.id === i.brief.id)).toBe(false);
      expect(challengeById(i.brief.id)).toBe(i.brief);
    }
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))('%s is told honestly', (_, i) => {
    expect(i.story.length).toBeGreaterThanOrEqual(4);
    expect(i.story.length).toBeLessThanOrEqual(6);
    expect(new URL(i.source.url).protocol).toBe('https:');
    expect(i.source.title.length).toBeGreaterThan(0);
    expect(i.simNote.length).toBeGreaterThan(0);
    expect(i.captions[0]?.atMs).toBe(0);
    const words = [
      i.name,
      i.tagline,
      i.simNote,
      ...i.story,
      ...i.captions.map((c) => c.text),
      i.brief.brief,
      i.brief.lesson,
      ...i.brief.hints,
    ];
    for (const w of words) expect(w).not.toMatch(/[\u2013\u2014]/);
    const times = i.captions.map((c) => c.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it.each(INCIDENTS.map((i) => [i.id, i] as const))(
    '%s faults name parts that exist',
    (_, i) => {
      const fail = () => {
        throw new Error('dropped');
      };
      expect(sanitizeFaults(i.scene.faults, i.scene, fail)).toHaveLength(
        i.scene.faults?.length ?? 0,
      );
      expect(sanitizeFaults(i.brief.faults, i.scene, fail)).toHaveLength(
        i.brief.faults?.length ?? 0,
      );
    },
  );

  it.each(INCIDENTS.map((i) => [i.id, i] as const))(
    '%s has no overlapping boxes',
    (_, i) => {
      const ns = i.scene.nodes;
      for (let a = 0; a < ns.length; a++) {
        for (let b = a + 1; b < ns.length; b++) {
          const apart =
            Math.abs(ns[a]!.x - ns[b]!.x) >= 184 || Math.abs(ns[a]!.y - ns[b]!.y) >= 88;
          expect(apart).toBe(true);
        }
      }
    },
  );

  it('shows the caption the clock has reached', () => {
    const s3 = incident('incident-s3-2017');
    expect(captionAt(s3, 0)?.atMs).toBe(0);
    expect(captionAt(s3, 19_999)?.atMs).toBe(0);
    expect(captionAt(s3, 20_000)?.atMs).toBe(20_000);
    expect(captionAt(s3, 90_000)?.atMs).toBe(50_000);
  });
});

describe('S3, 2017', () => {
  const s3 = incident('incident-s3-2017');

  it('plays the outage: fine, all down while S3 is, then back', () => {
    const rows = timeline(s3.scene, 55);
    expect(errorsAt(rows, 20)).toEqual([0, 0]);
    for (const s of [25, 30, 40, 50]) expect(errorsAt(rows, s)).toEqual([100, 100]);
    expect(errorsAt(rows, 55)).toEqual([0, 0]);
  });

  it('fails as it starts', () => {
    expect(status(s3, () => {})).toBe('goal-missed');
  });

  it.each([
    ['a second region behind a router', secondRegion()],
    ['the same, with the switch set to instant', secondRegion({ failoverMs: 0 })],
  ])('passes with %s', (_, edit) => {
    expect(status(s3, edit)).toBe('passed');
  });

  it.each([
    ['a bigger S3', set('s3', { capacity: 256 })],
    ['four S3 instances', set('s3', { instances: 4 })],
    ['retries on the console', set('console', { retries: 3, timeoutMs: 500 })],
  ])('fails with %s', (_, edit) => {
    expect(status(s3, edit)).toBe('goal-missed');
  });

  it('will not take a cache in front of S3', () => {
    const v = status(
      s3,
      all(
        add('cache', 'cache', 450, 450, { hitRate: 0.99 }),
        unwire('console', 's3'),
        wire('console', 'cache'),
        wire('cache', 's3'),
      ),
    );
    expect(v).toBe('unjudgeable');
  });
});

describe('Cloudflare, 2019', () => {
  const cf = incident('incident-cloudflare-2019');

  it('plays the outage: fine, all down under the rule, then back', () => {
    const rows = timeline(cf.scene, 55);
    expect(errorsAt(rows, 20)).toEqual([0, 0]);
    for (const s of [25, 35, 45]) expect(errorsAt(rows, s)).toEqual([100, 100]);
    expect(errorsAt(rows, 55)).toEqual([0, 0]);
  });

  it('fails as it starts', () => {
    expect(status(cf, () => {})).toBe('goal-missed');
  });

  it.each([
    ['two groups of 12', groups(2, 12)],
    ['three groups of 8', groups(3, 8)],
    ['four groups of 6', groups(4, 6)],
  ])('passes with %s', (_, edit) => {
    expect(status(cf, edit)).toBe('passed');
  });

  it.each([
    ['the edge at 48 slots', set('edge', { capacity: 48 })],
    ['three instances of 8 in one group', set('edge', { capacity: 8, instances: 3 })],
    ['a short line on the edge', set('edge', { queueLimit: 4 })],
    ['retries on the edge', set('edge', { timeoutMs: 100, retries: 2 })],
  ])('fails with %s', (_, edit) => {
    expect(status(cf, edit)).toBe('goal-missed');
  });

  it('will not take more than 24 slots', () => {
    expect(status(cf, groups(3, 24))).toBe('over-budget');
  });
});

describe('AWS, 2021', () => {
  const aws = incident('incident-aws-2021');

  it('plays the outage: fine, then down long after the slowdown ends', () => {
    const rows = timeline(aws.scene, 70);
    expect(errorsAt(rows, 15)).toEqual([0]);
    for (const s of [20, 40, 70]) expect(errorsAt(rows, s)).toEqual([100]);
  });

  it('fails as it starts', () => {
    expect(status(aws, () => {})).toBe('nothing-completed');
  });

  it.each([
    ['no retries', set('callers', { retries: 0 })],
    ['waiting 1000ms', set('callers', { timeoutMs: 1000 })],
  ])('passes with %s', (_, edit) => {
    expect(status(aws, edit)).toBe('passed');
  });

  it.each([
    ['one retry', set('callers', { retries: 1 })],
    ['waiting 500ms', set('callers', { timeoutMs: 500 })],
    [
      'a short line on the devices, which the brief holds',
      set('devices', { queueLimit: 16 }),
    ],
  ])('fails with %s', (_, edit) => {
    expect(status(aws, edit)).not.toBe('passed');
  });
});
