import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import {
  BREAK_END_MS,
  BREAK_FRAME_MS,
  BREAK_WARMUP_MS,
  DEFAULT_OPTIONS,
  measureSeed,
  runSearch,
} from './breakit';
import type { SearchProgress } from './breakit';
import { Engine } from './engine';
import { PRESETS, defaultConfig } from './presets';
import type { NodeKind, Topology } from './types';
import { verify, verifySteps } from './verify';
import type { Verdict, VerifyGoal } from './verify';

const preset = (id: string): Topology => {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p.topology;
};

function node(
  id: string,
  kind: NodeKind,
  config: Partial<Topology['nodes'][0]['config']>,
) {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...config },
  };
}

/** A client and one roomy server: slowing it 20x still answers in 100ms. */
const ROOMY: Topology = {
  nodes: [
    node('client', 'client', { rps: 20, timeoutMs: 2000 }),
    node('api', 'service', {
      capacity: 64,
      serviceMs: 5,
      serviceCv: 0,
      queueLimit: 64,
    }),
  ],
  edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1 }],
};

const UP: VerifyGoal = { metric: 'errorRate', max: 1 };

function drain(it: Generator<SearchProgress, Verdict, void>): Verdict {
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}

/** Play a topology as a link would, counting the search's window. */
function play(topo: Topology) {
  const e = new Engine(topo, topo.seed);
  const snaps: string[] = [];
  while (e.now < BREAK_END_MS - 1e-9) {
    if (Math.abs(e.now - BREAK_WARMUP_MS) < 1e-9) e.startTally();
    e.advance(BREAK_FRAME_MS);
    snaps.push(JSON.stringify(e.snapshot()));
  }
  e.stopTally();
  const tally = e.readTally();
  if (!tally) throw new Error('no tally');
  return { snaps, tally };
}

describe('verify: broken', () => {
  const v = verify(preset('single-server'), UP);

  it('finds the smallest schedule the panel finds', () => {
    expect(v.status).toBe('broken');
    if (v.status !== 'broken') return;
    expect(v.schedule).toEqual([
      { kind: 'slow', target: 'db', factor: 5, atMs: 10_000, forMs: 5000 },
    ]);
    expect(v.minimal).toBe(true);
    expect(v.faults).toEqual([
      {
        atMs: 10_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 5 },
      },
      { atMs: 15_000, action: 'clear', nodeId: 'db' },
    ]);
    expect(v.measured.actual).toBeGreaterThan(UP.max * 1.1);
    expect(v.withoutFaults.actual).toBeLessThanOrEqual(UP.max);
    expect(v.measured.seed).toBe(v.withoutFaults.seed);
    const panel = runSearch(preset('single-server'), UP, DEFAULT_OPTIONS);
    expect(panel.status === 'broke' && panel.run).toEqual(v.measured);
    expect(panel.status === 'broke' && panel.tried).toBe(v.tried);
  });

  it('replays the violation byte for byte, through a link too', () => {
    // With the ids the wire mints, so a run of the replay and a run of its
    // link name the same nodes in their snapshots.
    const wired = unpackTopology(packTopology(preset('single-server')));
    if (!wired) throw new Error('single-server did not survive the wire');
    const v = verify(wired, UP);
    if (v.status !== 'broken') throw new Error('should break');
    expect(v.replay.faults).toEqual(v.faults);
    expect(v.replay.seed).toBe(v.measured.seed);
    const back = unpackTopology(packTopology(v.replay));
    if (!back) throw new Error('did not decode');
    const a = play(v.replay);
    const b = play(back);
    expect(b.snaps.length).toBe(a.snaps.length);
    for (let i = 0; i < a.snaps.length; i++) {
      if (a.snaps[i] !== b.snaps[i]) throw new Error(`snapshot ${i} differs`);
    }
    expect(measureSeed(UP, a.tally, v.measured.seed)).toEqual(v.measured);
    expect(measureSeed(UP, b.tally, v.measured.seed)).toEqual(v.measured);
  });
});

describe('verify: held', () => {
  it('says what it tried', () => {
    const v = verify(ROOMY, { metric: 'p99', max: 300 });
    expect(v.status).toBe('held');
    if (v.status !== 'held') return;
    expect(v.tried).toBeGreaterThan(0);
    expect(v.bySize.reduce((a, b) => a + b, 0)).toBe(v.tried);
    expect(v.stoppedBy).not.toBe('simSeconds');
    expect(v.closest?.schedule).toEqual([
      { kind: 'slow', target: 'api', factor: 20, atMs: 10_000, forMs: null },
    ]);
    expect(v.simSeconds).toBeGreaterThan(0);
  });

  it('stops at the simulated-time limit, the same way every time', () => {
    const goal: VerifyGoal = { metric: 'p99', max: 300 };
    const a = verify(preset('netflix'), goal, { maxSimSeconds: 200, budget: 50 });
    const b = verify(preset('netflix'), goal, { maxSimSeconds: 200, budget: 50 });
    expect(b).toEqual(a);
    expect(a.status).toBe('held');
    if (a.status !== 'held') return;
    expect(a.stoppedBy).toBe('simSeconds');
    expect(a.tried).toBeLessThan(50);
    expect(a.simSeconds).toBeGreaterThanOrEqual(200);
    // At most one schedule, three seeds of 35s, past the line.
    expect(a.simSeconds).toBeLessThan(200 + 3 * 35 + 1e-9);
  }, 60_000);

  it("counts one fault's share of the budget as the budget, not as nothing left", () => {
    // One fault gets 40% of the budget: 4 of 10, with far more singles to draw.
    const v = verify(
      preset('netflix'),
      { metric: 'p99', max: 100_000 },
      { maxFaults: 1, budget: 10 },
    );
    expect(v.status === 'held' && [v.tried, v.stoppedBy]).toEqual([4, 'budget']);
  }, 60_000);

  it('runs out of budget when the budget is what ends it', () => {
    const v = verify(
      preset('async-workers'),
      { metric: 'errorRate', max: 5 },
      { budget: 20 },
    );
    expect(v.status === 'held' && v.stoppedBy).toBe('budget');
    expect(v.status === 'held' && v.tried).toBe(20);
  });
});

describe('verify: determinism', () => {
  it('gives the same verdict twice, stepped or whole', () => {
    const goal: VerifyGoal = { metric: 'p99', max: 300 };
    const a = verify(preset('cache-aside'), goal, { budget: 60 });
    const b = verify(preset('cache-aside'), goal, { budget: 60 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(drain(verifySteps(preset('cache-aside'), goal, { budget: 60 }))).toEqual(a);
  });

  it('treats a seed option as the design seed', () => {
    const t = preset('single-server');
    const a = verify(t, UP, { seed: 7, budget: 60 });
    const b = verify({ ...t, seed: 7 }, UP, { budget: 60 });
    expect(b).toEqual(a);
    expect(a.status === 'broken' && a.replay.seed).toBe(
      a.status === 'broken' ? a.measured.seed : -1,
    );
    expect(a.status === 'broken' && a.measured.seed).not.toBe(1);
  });

  it('gives the panel the answer it gave before', () => {
    const goal: VerifyGoal = { metric: 'errorRate', max: 1 };
    const v = verify(preset('full-stack'), goal);
    const r = runSearch(preset('full-stack'), goal, DEFAULT_OPTIONS);
    expect(v.status).toBe('broken');
    expect(v.status === 'broken' && v.schedule).toEqual(
      r.status === 'broke' && r.attacks,
    );
  }, 60_000);
});

describe('verify: invalid requests', () => {
  const t = preset('single-server');
  const errors = (goal: VerifyGoal, opts = {}) => {
    const v = verify(t, goal, opts);
    return v.status === 'invalid' ? v.errors : [];
  };

  it('turns down a metric it cannot search', () => {
    const goal = { metric: 'queueDepth', max: 10 } as unknown as VerifyGoal;
    expect(errors(goal)).toHaveLength(1);
  });

  it('turns down a route that is not a client', () => {
    expect(errors({ metric: 'errorRate', max: 1, route: 'db' })[0]).toContain(
      'not a client',
    );
  });

  it('turns down a route on a system-wide count', () => {
    const client = t.nodes.find((n) => n.kind === 'client');
    if (!client) throw new Error('no client');
    expect(errors({ metric: 'lostWrites', max: 0, route: client.id })[0]).toContain(
      'whole system',
    );
  });

  it('turns down bad options and a design with no client', () => {
    expect(errors(UP, { budget: -1, maxSimSeconds: 0, seed: 1.5 })).toHaveLength(3);
    const v = verify({ nodes: [], edges: [] }, UP);
    expect(v.status).toBe('invalid');
  });

  it('accepts a route that is a client', () => {
    const t2 = preset('netflix');
    const client = t2.nodes.find((n) => n.kind === 'client');
    if (!client) throw new Error('no client');
    expect(
      verify(t2, { metric: 'errorRate', max: 1, route: client.id }, { budget: 1 })
        .status,
    ).not.toBe('invalid');
  });
});
