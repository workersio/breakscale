import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShareUrl, decodeTopology } from '../share';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';
import { buildLink, designTopology, hasReplay, replayTopology } from './replayLink';
import { fetchStored, setEndpointForTests } from './store';

/* ------------------------------------------------------------------ *
 * A replay link, end to end, the way the app builds and opens one.
 *
 * The sender runs a preset with its own ids, breaks it through the same
 * record* calls the fault controls use, and builds the link from the
 * engine's export. The recipient opens it the way App does, setTopology
 * on an engine that was running something else and then reset(), and
 * plays the same frames. The wire gives the recipient's nodes and edges
 * new ids, so the recipient's snapshots are read back under the sender's
 * names before comparing; everything else is compared as the exact JSON.
 * ------------------------------------------------------------------ */

const FRAME = 1000 / 60;
const FRAMES = 600;
const BASE = 'https://breakscale.tech/';

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.topology;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** A snapshot after every frame; `act` runs where a click lands. */
function play(engine: Engine, act?: (frame: number) => void): string[] {
  const out: string[] = [];
  for (let i = 0; i < FRAMES; i++) {
    engine.advance(FRAME);
    act?.(i);
    out.push(JSON.stringify(engine.snapshot()));
  }
  return out;
}

/**
 * Rewrite the recipient's ids to the sender's. Node and edge ids appear as
 * object keys and as string values (edge endpoints, fault targets), so both
 * are mapped. Nodes and edges keep their order across the wire.
 */
function renamer(from: Topology, to: Topology): (json: string) => string {
  const map = new Map<string, string>();
  from.nodes.forEach((n, i) => map.set(n.id, to.nodes[i]?.id ?? n.id));
  from.edges.forEach((e, i) => map.set(e.id, to.edges[i]?.id ?? e.id));
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(swap);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[map.get(k) ?? k] = swap(x);
      return out;
    }
    return v;
  };
  return (json) => JSON.stringify(swap(JSON.parse(json)));
}

/** The sender's side: a run broken by hand, and the replay of it. */
function brokenRun(id: string): { design: Topology; run: string[]; replay: Topology } {
  const design = preset(id);
  const servers = design.nodes.filter((n) => n.kind !== 'client');
  const [a, b] = servers;
  const cable = design.edges.find((e) => e.to === b?.id);
  if (!a || !b || !cable) throw new Error('fixture too small');
  const engine = new Engine(design);
  const run = play(engine, (i) => {
    if (i === 60) engine.recordFailure(a.id, 'crash');
    if (i === 130) engine.recordCutEdge(cable.id);
    if (i === 250) engine.recordClearFailure(a.id);
    if (i === 330) engine.recordRestoreEdge(cable.id);
    if (i === 420) engine.recordFailure(b.id, 'slow', { factor: 5 });
  });
  expect(engine.faultSchedule()).toHaveLength(5);
  return { design, run, replay: replayTopology(design, engine) };
}

/** The recipient's side, as App opens a link. */
function opened(t: Topology): string[] {
  const engine = new Engine(preset('single-server'));
  engine.advance(100);
  engine.setTopology(t);
  engine.reset();
  return play(engine);
}

function expectSameRun(original: string[], replay: string[]): void {
  expect(replay).toHaveLength(original.length);
  // First differing frame rather than the whole array, so a failure says
  // where to look instead of printing megabytes of JSON.
  expect(original.findIndex((s, i) => s !== replay[i])).toBe(-1);
  expect(sha256(replay.join('\n'))).toBe(sha256(original.join('\n')));
}

describe('a replay link', () => {
  afterEach(() => {
    setEndpointForTests(null);
    vi.unstubAllGlobals();
  });

  it('opens the same run through a fragment link', async () => {
    const { design, run, replay } = brokenRun('circuit-breaker');
    const url = new URL(await buildLink(replay, BASE));
    expect(url.hash.startsWith('#d3.')).toBe(true);
    const r = await decodeTopology(url.hash);
    if (r.status !== 'ok') throw new Error(`link did not open: ${r.status}`);
    expect(r.topology.faults).toHaveLength(5);
    // Annotations ride along too; the wire renames them like everything else.
    const text = (t: Topology) =>
      (t.annotations ?? []).map((a) => ('text' in a ? a.text : a.kind));
    expect(text(r.topology)).toEqual(text(design));
    expect(text(design).length).toBeGreaterThan(0);
    expectSameRun(run, opened(r.topology).map(renamer(r.topology, design)));
  });

  it('opens the same run through the short-link store', async () => {
    const { design, run, replay } = brokenRun('load-balanced');
    setEndpointForTests('https://store.test');
    let stored: Uint8Array<ArrayBuffer> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          stored = new Uint8Array(init.body as Uint8Array);
          return new Response(JSON.stringify({ id: 'abcdefghijklmn' }), {
            status: 201,
          });
        }
        return new Response(stored, { status: 200 });
      }),
    );
    const url = new URL(await buildLink(replay, BASE));
    expect(url.searchParams.get('s')).toBe('abcdefghijklmn');
    const r = await fetchStored(url.search, url.hash);
    if (r.status !== 'ok') throw new Error(`link did not open: ${r.status}`);
    expectSameRun(run, opened(r.topology).map(renamer(r.topology, design)));
  });

  it('is not the run the plain design link opens', async () => {
    const { design, run, replay } = brokenRun('circuit-breaker');
    const r = await decodeTopology(
      new URL(await buildLink(designTopology(replay), BASE)).hash,
    );
    if (r.status !== 'ok') throw new Error(`link did not open: ${r.status}`);
    expect(r.topology.faults).toBeUndefined();
    const plain = opened(r.topology).map(renamer(r.topology, design));
    expect(plain.findIndex((s, i) => s !== run[i])).toBeGreaterThan(0);
  });
});

describe('a design link', () => {
  it('is the same link as before for a design with no faults', async () => {
    for (const p of PRESETS) {
      expect(hasReplay(p.topology)).toBe(false);
      expect(designTopology(p.topology)).toBe(p.topology);
      expect(await buildLink(designTopology(p.topology), BASE)).toBe(
        await buildShareUrl(p.topology, BASE),
      );
    }
  });

  it('leaves the schedule out, even an empty one', async () => {
    const t = preset('circuit-breaker');
    const node = t.nodes[1];
    if (!node) throw new Error('fixture too small');
    const withFaults = {
      ...t,
      faults: [{ atMs: 1000, action: 'clear' as const, nodeId: node.id }],
    };
    expect(hasReplay(withFaults)).toBe(true);
    expect(hasReplay({ ...t, faults: [] })).toBe(false);
    const plain = await buildShareUrl(t, BASE);
    expect(await buildLink(designTopology(withFaults), BASE)).toBe(plain);
    expect(await buildLink(designTopology({ ...t, faults: [] }), BASE)).toBe(plain);
  });
});
