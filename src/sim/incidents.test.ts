import { describe, expect, it } from 'vitest';
import { applyLoad } from './challenge';
import { challengeById, CHALLENGES } from './challenges';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { captionAt, INCIDENTS, incidentById } from './incidents';
import type { Incident } from './incidents';
import { judge, judgedTopology, playRun, slotBudget, startDesign } from './judge';
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

  it('will not take a router that serves from the second region from the start', () => {
    const t = opened(s3);
    secondRegion({ activeRegion: 1 })(t);
    expect(judgedTopology(s3.brief, t).unjudgeable).toEqual({
      reason: 'standby-first',
      regionId: 'router',
      activeId: 's3b',
      nodeId: 's3',
    });
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

/**
 * The same verdict on seeds 1 to 10, not only the check's own three: a
 * failover that passes on a lucky seed would teach the wrong thing.
 */
function onTenSeeds(i: Incident, edit: Edit): string[] {
  const design = opened(i);
  edit(design);
  const { topology, unjudgeable } = judgedTopology(i.brief, design);
  if (unjudgeable) return [unjudgeable.reason];
  const b = slotBudget(i.brief, topology, startDesign(i.brief));
  if (b && b.used > b.allowed) return ['over-budget'];
  const out: string[] = [];
  for (let seed = 1; seed <= 10; seed++) {
    const run = playRun(i.brief, topology, seed);
    let step = run.next();
    while (!step.done) step = run.next();
    out.push(step.value.outcome);
  }
  return out;
}

const ENGINE = { capacity: 16, serviceMs: 25, serviceCv: 0.5, queueLimit: 128 };

/** A zone switch in front of the engine and a standby of `cap` slots. */
const standby = (cap: number, extra: Partial<NodeConfig> = {}): Edit =>
  all(
    add('switch', 'region', 430, 330, extra),
    add('standby', 'service', 560, 330, { ...ENGINE, capacity: cap }),
    unwire('api', 'engine'),
    wire('api', 'switch'),
    wire('switch', 'engine'),
    wire('switch', 'standby'),
  );

describe('Coinbase, 2026', () => {
  const cb = incident('incident-coinbase-2026');

  it('plays the outage: fine, all down while the engine is, then back', () => {
    const rows = timeline(cb.scene, 60);
    expect(errorsAt(rows, 20)).toEqual([0]);
    for (const s of [25, 35, 50]) expect(errorsAt(rows, s)).toEqual([100]);
    expect(errorsAt(rows, 60)).toEqual([0]);
  });

  it('fails as it starts', () => {
    expect(status(cb, () => {})).toBe('goal-missed');
  });

  it.each([
    ['a standby as big as the engine', standby(16)],
    ['a standby of 12 slots', standby(12)],
    ['the same, with the switch set to instant', standby(16, { failoverMs: 0 })],
  ])('passes on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(cb, edit)).toEqual(Array(10).fill('passed'));
  });

  it.each([
    ['no change', () => {}],
    ['a standby at its default size', standby(8)],
    ['two engine instances', set('engine', { instances: 2 })],
    ['an engine of 32 slots', set('engine', { capacity: 32 })],
    ['retries on the API', set('api', { retries: 3, timeoutMs: 200 })],
    [
      'the API sending to the engine and a second one',
      all(add('standby', 'service', 560, 330, ENGINE), wire('api', 'standby')),
    ],
    [
      'two engines behind a load balancer',
      all(
        add('lb', 'lb', 430, 330, { capacity: 1 }),
        add('standby', 'service', 560, 330, ENGINE),
        unwire('api', 'engine'),
        wire('api', 'lb'),
        wire('lb', 'engine'),
        wire('lb', 'standby'),
      ),
    ],
  ])('fails on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(cb, edit)).toEqual(Array(10).fill('goal-missed'));
  });

  it('will not take a standby bigger than 20 slots', () => {
    expect(status(cb, standby(24))).toBe('over-budget');
  });

  // Serving from the standby before the zone goes dark leaves the engine
  // idle, so the crash lands on nothing and no failover is tested.
  it.each([
    [
      'the switch wired to the standby first',
      all(
        add('switch', 'region', 430, 330),
        add('standby', 'service', 560, 330, ENGINE),
        unwire('api', 'engine'),
        wire('api', 'switch'),
        wire('switch', 'standby'),
        wire('switch', 'engine'),
      ),
    ],
    ['the switch set to serve from the standby', standby(16, { activeRegion: 1 })],
  ])('will not check %s', (_, edit) => {
    expect(onTenSeeds(cb, edit)).toEqual(['standby-first']);
  });
});

/** `kind` put on the line from `from` to `to`. */
const between = (
  from: string,
  to: string,
  id: string,
  kind: NodeKind,
  config: Partial<NodeConfig> = {},
): Edit =>
  all(add(id, kind, 170, 450, config), unwire(from, to), wire(from, id), wire(id, to));

/** `kind` in front of auth, taking both kinds of traffic. */
const forEveryone = (kind: NodeKind, config: Partial<NodeConfig>): Edit =>
  all(
    add('gate', kind, 170, 450, config),
    unwire('signins', 'auth'),
    unwire('typing', 'auth'),
    wire('signins', 'gate'),
    wire('typing', 'gate'),
    wire('gate', 'auth'),
  );

describe('Discord, 2023', () => {
  const dc = incident('incident-discord-2023');

  it('plays the outage: both kinds of traffic fail together, then recover', () => {
    const rows = timeline(dc.scene, 60);
    expect(errorsAt(rows, 20)).toEqual([0, 0]);
    for (const s of [30, 35, 40]) {
      const [signins, typing] = errorsAt(rows, s);
      expect(signins).toBeGreaterThan(5);
      expect(typing).toBeGreaterThan(5);
    }
    expect(errorsAt(rows, 55)).toEqual([0, 0]);
  });

  it('fails as it starts', () => {
    expect(status(dc, () => {})).toBe('goal-missed');
  });

  it.each([
    [
      'a rate limiter on the typing path',
      between('typing', 'auth', 'rl', 'ratelimiter'),
    ],
    [
      'the same, let through at 150 a second',
      between('typing', 'auth', 'rl', 'ratelimiter', { rateLimitRps: 150 }),
    ],
    [
      'the same, nearly shut at 5 a second',
      between('typing', 'auth', 'rl', 'ratelimiter', { rateLimitRps: 5 }),
    ],
    [
      'a load shedder on the typing path at 100 a second',
      between('typing', 'auth', 'rl', 'loadshedder', { rateLimitRps: 100, burst: 100 }),
    ],
  ])('passes on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(dc, edit)).toEqual(Array(10).fill('passed'));
  });

  it.each([
    ['no change', () => {}],
    ['no retries', set('auth', { retries: 0 })],
    ['no retries and a long timeout', set('auth', { retries: 0, timeoutMs: 1000 })],
    ['a short line at the store', set('sessions', { queueLimit: 8 })],
    ['a smaller auth service', set('auth', { capacity: 16 })],
    ['typing sent at 1 a second', set('typing', { rps: 1 })],
    ['a rate limiter for everyone', forEveryone('ratelimiter', { rateLimitRps: 300 })],
    [
      'a load shedder for everyone, half of it low priority',
      forEveryone('loadshedder', { rateLimitRps: 300, lowPriorityShare: 0.5 }),
    ],
    ['a breaker in front of the store', between('auth', 'sessions', 'br', 'breaker')],
    ['a breaker on the typing path', between('typing', 'auth', 'br', 'breaker')],
  ])('fails on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(dc, edit)).toEqual(Array(10).fill('goal-missed'));
  });

  it('will not take a bigger store', () => {
    expect(status(dc, set('sessions', { instances: 4 }))).toBe('over-budget');
  });

  it('will not take typing cut off altogether', () => {
    expect(status(dc, unwire('typing', 'auth'))).toBe('unjudgeable');
  });
});

describe('Coinbase, 2021', () => {
  const cb = incident('incident-coinbase-2021');

  it('plays the outage: fine, failing while Memcached is away, then back', () => {
    const rows = timeline(cb.scene, 45);
    expect(errorsAt(rows, 20)).toEqual([0]);
    for (const s of [25, 30]) expect(errorsAt(rows, s)[0]).toBeGreaterThan(10);
    for (const s of [40, 45]) expect(errorsAt(rows, s)).toEqual([0]);
  });

  it('fails as it starts', () => {
    expect(status(cb, () => {})).toBe('goal-missed');
  });

  it('turns reads away at the app servers while Memcached is away', () => {
    const engine = new Engine(cb.scene, 1);
    while (engine.now < 25_000) engine.advance(1000 / 60);
    const app = engine.snapshot().nodes.app;
    expect(app.shedRate).toBeGreaterThan(0);
    expect(app.timeoutRate).toBe(0);
  });

  it.each([
    ['Redis at 8 slots', set('redis', { capacity: 8 })],
    ['Redis at twice its size', set('redis', { capacity: 4 })],
    ['three Redis copies', set('redis', { instances: 3 })],
  ])('passes on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(cb, edit)).toEqual(Array(10).fill('passed'));
  });

  it.each([
    ['no change', () => {}],
    ['a better hit rate', set('memcached', { hitRate: 0.99 })],
    ['retries on the app', set('app', { retries: 2 })],
    ['a short timeout on the app', set('app', { timeoutMs: 200 })],
    ['a short line at Redis', set('redis', { queueLimit: 16 })],
    [
      'a breaker in front of Redis',
      all(
        add('br', 'breaker', 820, 450),
        unwire('lookup', 'redis'),
        unwire('memcached', 'redis'),
        (t) => t.edges.push({ id: 'lookup->br', from: 'lookup', to: 'br', weight: 0 }),
        wire('memcached', 'br'),
        wire('br', 'redis'),
      ),
    ],
  ])('fails on ten seeds with %s', (_, edit) => {
    expect(onTenSeeds(cb, edit)).toEqual(Array(10).fill('goal-missed'));
  });

  it('will not take a second Memcached', () => {
    const second = all(
      add('mc2', 'cache', 820, 450, { capacity: 4 }),
      wire('lookup', 'mc2'),
    );
    expect(status(cb, second)).toBe('unjudgeable');
  });

  it('will not take more Memcached than the slots allow', () => {
    expect(status(cb, set('memcached', { instances: 2 }))).toBe('over-budget');
  });
});
