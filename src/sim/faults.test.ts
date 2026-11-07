import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { PRESETS } from './presets';
import type { FaultEvent, SimSnapshot, Topology } from './types';

/**
 * The fault schedule: timed, replayable chaos.
 *
 * The property everything here rests on is that a schedule is played from
 * simulated time inside the event loop, so where the frames fall cannot move
 * a fault, and a run broken by hand can be recorded and replayed exactly.
 */

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return structuredClone(p.topology);
}

function withFaults(t: Topology, faults: FaultEvent[]): Topology {
  return { ...t, faults };
}

/**
 * Fields sampled at frame boundaries rather than at events: utilisation is
 * smoothed once per advance() and history rows read the rates at the end of
 * the frame that crosses their tick. They depend on frame size with or
 * without faults, so the chunking comparison leaves them out. Everything else
 * in the snapshot is compared byte for byte.
 */
const FRAME_SAMPLED = new Set([
  'utilization',
  'perInstance',
  'maxShardUtilization',
  'minShardUtilization',
  'shardUtilization',
  'history',
]);

function eventDriven(s: SimSnapshot): string {
  return JSON.stringify(s, (k, v: unknown) => (FRAME_SAMPLED.has(k) ? undefined : v));
}

/**
 * Advance through `windows` windows of 400ms, each split into `plan` chunks,
 * and serialise a snapshot at the end of every window.
 */
function sampled(
  engine: Engine,
  plan: readonly number[],
  windows: number,
  serialise: (s: SimSnapshot) => string = eventDriven,
): string[] {
  const out: string[] = [];
  for (let w = 0; w < windows; w++) {
    for (const step of plan) engine.advance(step);
    out.push(serialise(engine.snapshot()));
  }
  return out;
}

/** Ways to cut 400ms into frames. Integer steps, so the sums are exact. */
const PLANS: Record<string, readonly number[]> = {
  '16ms': Array.from({ length: 25 }, () => 16),
  '50ms': Array.from({ length: 8 }, () => 50),
  '100ms': [100, 100, 100, 100],
  irregular: [7, 33, 100, 60, 100, 100],
};

/** One of every action, at times on, off and between frame boundaries. */
const SCHEDULE: FaultEvent[] = [
  { atMs: 1234.5, action: 'inject', nodeId: 'api2', kind: 'slow', opts: { factor: 4 } },
  { atMs: 1600, action: 'cut', edgeId: 'lb->api1' },
  { atMs: 2000, action: 'inject', nodeId: 'api3', kind: 'crash' },
  { atMs: 2000, action: 'inject', nodeId: 'db', kind: 'errors', opts: { rate: 0.3 } },
  { atMs: 3017, action: 'restore', edgeId: 'lb->api1' },
  { atMs: 3333, action: 'clear', nodeId: 'api3' },
  {
    atMs: 4100,
    action: 'inject',
    nodeId: 'api1',
    kind: 'partition',
    opts: { edgeIds: ['api1->db'] },
  },
  { atMs: 5000, action: 'clear', nodeId: 'api2' },
];

describe('fault schedule: no faults', () => {
  /*
   * Hashes of the 10Hz snapshot sequence over ten seconds at 60fps, seed 7,
   * recorded from the engine before the schedule existed. A topology with no
   * schedule must still produce exactly these bytes. If a preset is retuned
   * on purpose, regenerate them from that commit's engine.
   *
   * event-driven was re-recorded when service, worker and lambda began
   * holding their slot across the calls they make. Its api now waits on the
   * broker and topic acks, which moves the random draws, while everything
   * the preset claims measures the same. The other four were re-recorded
   * once their presets were retuned for that change: their callers got the
   * slots to outlast the wait on what they call, and autoscaling-service's
   * database got faster and its API's own work 2ms shorter, so a slot held
   * across the database call still turns over in about 25ms. All five are
   * the x86-64 hashes, the bytes Linux and Windows CI produce.
   */
  const GOLDEN: Record<string, string> = {
    'single-server': '9491f136831920eeee5f4f461174c811b3d5972d4aa5088c2318079bed1f6277',
    'circuit-breaker':
      '4f855031bfce6b6cb6830abd15c00302b0018f5f30751e376eac5605834217d4',
    'autoscaling-service':
      '278c25c15e0dcd3ff0af8be2a3aa4747759bbc3265f3e4590af74a0d615210c6',
    'event-driven': '88a07c5a2eefdc7ee7de4ef759fd9fd56575a1dcac94ec3fcc445d79bd51d875',
    'multi-region': 'cbfeda1fec110f5cc12c00f2417ddc356f9d7e0aaffc1951d65c61e20d19601c',
  };

  function hash(t: Topology): string {
    const engine = new Engine(t, 7);
    const h = createHash('sha256');
    for (let i = 1; i <= 600; i++) {
      engine.advance(1000 / 60);
      if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
    }
    return h.digest('hex');
  }

  it.each(Object.keys(GOLDEN))('%s runs byte for byte as it did before', (id) => {
    expect(hash(preset(id))).toBe(GOLDEN[id]);
    expect(hash(withFaults(preset(id), []))).toBe(GOLDEN[id]);
  });

  it('a schedule that has not come due yet changes nothing', () => {
    const late = withFaults(preset('circuit-breaker'), [
      { atMs: 60_000, action: 'inject', nodeId: 'payments', kind: 'crash' },
    ]);
    expect(hash(late)).toBe(GOLDEN['circuit-breaker']);
  });
});

describe('fault schedule: each action', () => {
  function at(t: Topology, ms: number): { engine: Engine; snap: SimSnapshot } {
    const engine = new Engine(t, 3);
    for (let i = 0; i < ms / 50; i++) engine.advance(50);
    return { engine, snap: engine.snapshot() };
  }

  it('inject crash fails work at the node from atMs on, and not before', () => {
    const t = withFaults(preset('circuit-breaker'), [
      { atMs: 2010, action: 'inject', nodeId: 'payments', kind: 'crash' },
    ]);
    const before = at(t, 2000).snap;
    expect(before.failuresByReason.crashed).toBe(0);
    expect(before.activeFailures).toEqual([]);

    const after = at(t, 4000).snap;
    expect(after.failuresByReason.crashed).toBeGreaterThan(0);
    expect(after.activeFailures).toEqual([
      { nodeId: 'payments', kind: 'crash', sinceMs: 2010 },
    ]);
  });

  it('inject slow raises the node latency', () => {
    const healthy = at(preset('single-server'), 6000).snap;
    const slow = at(
      withFaults(preset('single-server'), [
        {
          atMs: 1000,
          action: 'inject',
          nodeId: 'api',
          kind: 'slow',
          opts: { factor: 3 },
        },
      ]),
      6000,
    ).snap;
    expect(slow.activeFailures[0]).toEqual({
      nodeId: 'api',
      kind: 'slow',
      sinceMs: 1000,
      factor: 3,
    });
    // The node's p50 includes the database call behind it, which the fault
    // leaves alone, so the whole figure grows by less than the factor.
    expect(slow.nodes.api.p50).toBeGreaterThan(healthy.nodes.api.p50 * 1.5);
  });

  it('inject errors fails the given share of requests at the node', () => {
    const { snap } = at(
      withFaults(preset('single-server'), [
        {
          atMs: 500,
          action: 'inject',
          nodeId: 'api',
          kind: 'errors',
          opts: { rate: 0.5 },
        },
      ]),
      5000,
    );
    expect(snap.activeFailures[0]).toMatchObject({ kind: 'errors', rate: 0.5 });
    expect(snap.nodes.api.errorRate).toBeGreaterThan(0.35);
    expect(snap.nodes.api.errorRate).toBeLessThan(0.65);
  });

  it('inject partition cuts the named edges only', () => {
    const { snap } = at(
      withFaults(preset('load-balanced'), [
        {
          atMs: 500,
          action: 'inject',
          nodeId: 'lb',
          kind: 'partition',
          opts: { edgeIds: ['lb->api2'] },
        },
      ]),
      3000,
    );
    expect(snap.edgeState['lb->api2']).toBe('cut');
    expect(snap.edgeState['lb->api1']).not.toBe('cut');
    expect(snap.edgeFlow['lb->api2']).toBe(0);
  });

  it('cut severs one edge without faulting either end, restore reconnects it', () => {
    const t = withFaults(preset('circuit-breaker'), [
      { atMs: 1000, action: 'cut', edgeId: 'breaker->payments' },
      { atMs: 3000, action: 'restore', edgeId: 'breaker->payments' },
    ]);
    const { engine, snap: cut } = at(t, 2500);
    expect(cut.edgeState['breaker->payments']).toBe('cut');
    expect(cut.activeFailures).toEqual([]);
    expect(engine.activeCuts()).toEqual(['breaker->payments']);
    expect(cut.failuresByReason.partitioned).toBeGreaterThan(0);

    const restored = at(t, 9000);
    expect(restored.snap.edgeState['breaker->payments']).not.toBe('cut');
    expect(restored.engine.activeCuts()).toEqual([]);
    expect(restored.snap.edgeFlow['breaker->payments']).toBeGreaterThan(0);
  });

  it('a cut leaves a fault on the same node in place, unlike a partition', () => {
    const { snap } = at(
      withFaults(preset('load-balanced'), [
        {
          atMs: 500,
          action: 'inject',
          nodeId: 'lb',
          kind: 'slow',
          opts: { factor: 2 },
        },
        { atMs: 600, action: 'cut', edgeId: 'lb->api3' },
      ]),
      2000,
    );
    expect(snap.activeFailures).toEqual([
      { nodeId: 'lb', kind: 'slow', sinceMs: 500, factor: 2 },
    ]);
    expect(snap.edgeState['lb->api3']).toBe('cut');
  });

  it('entries for nodes or edges that do not exist do nothing', () => {
    const t = withFaults(preset('single-server'), [
      { atMs: 100, action: 'inject', nodeId: 'ghost', kind: 'crash' },
      { atMs: 100, action: 'cut', edgeId: 'ghost->api' },
    ]);
    expect(eventDriven(at(t, 2000).snap)).toBe(
      eventDriven(at(preset('single-server'), 2000).snap),
    );
  });
});

describe('fault schedule: clear semantics', () => {
  it('clear heals the node; new work succeeds again', () => {
    const engine = new Engine(
      withFaults(preset('circuit-breaker'), [
        { atMs: 1000, action: 'inject', nodeId: 'payments', kind: 'crash' },
        { atMs: 2000, action: 'clear', nodeId: 'payments' },
      ]),
      3,
    );
    for (let i = 0; i < 40; i++) engine.advance(50);
    const crashedAt2s = engine.snapshot().failuresByReason.crashed;
    expect(crashedAt2s).toBeGreaterThan(0);
    expect(engine.snapshot().activeFailures).toEqual([]);
    for (let i = 0; i < 200; i++) engine.advance(50);
    expect(engine.snapshot().failuresByReason.crashed).toBe(crashedAt2s);
    expect(engine.snapshot().nodes.payments.throughput).toBeGreaterThan(0);
  });

  it('a later inject replaces the earlier fault on the same node', () => {
    const engine = new Engine(
      withFaults(preset('single-server'), [
        { atMs: 100, action: 'inject', nodeId: 'api', kind: 'crash' },
        {
          atMs: 200,
          action: 'inject',
          nodeId: 'api',
          kind: 'slow',
          opts: { factor: 3 },
        },
      ]),
      3,
    );
    for (let i = 0; i < 10; i++) engine.advance(50);
    expect(engine.activeFailures()).toEqual([
      { nodeId: 'api', kind: 'slow', sinceMs: 200, factor: 3 },
    ]);
  });

  it('restore does not heal an edge cut by a partition fault', () => {
    const engine = new Engine(
      withFaults(preset('load-balanced'), [
        { atMs: 100, action: 'inject', nodeId: 'lb', kind: 'partition' },
        { atMs: 200, action: 'cut', edgeId: 'lb->api1' },
        { atMs: 300, action: 'restore', edgeId: 'lb->api1' },
      ]),
      3,
    );
    for (let i = 0; i < 10; i++) engine.advance(50);
    expect(engine.snapshot().edgeState['lb->api1']).toBe('cut');
    expect(engine.isEdgeCut('lb->api1')).toBe(true);
  });

  it('clearing a healthy node and restoring an uncut edge are no-ops, and not recorded', () => {
    const engine = new Engine(preset('single-server'), 3);
    engine.advance(50);
    engine.recordClearFailure('api');
    expect(engine.recordRestoreEdge('client->api')).toBe(false);
    expect(engine.recordCutEdge('nope')).toBe(false);
    expect(engine.faultSchedule()).toEqual([]);
  });
});

describe('fault schedule: determinism', () => {
  it.each(['load-balanced', 'circuit-breaker'])(
    '%s gives identical snapshots however advance() is chunked',
    (id) => {
      const t =
        id === 'load-balanced' ? withFaults(preset(id), SCHEDULE) : circuitSchedule();
      const runs = Object.entries(PLANS).map(
        ([name, plan]) => [name, sampled(new Engine(t, 11), plan, 20)] as const,
      );
      const [, reference] = runs[0];
      // The faults must actually have bitten, or this proves nothing.
      expect(reference.at(-1)).toMatch(/"crashed":[1-9]/);
      for (const [, run] of runs) expect(run).toEqual(reference);
    },
  );

  function circuitSchedule(): Topology {
    return withFaults(preset('circuit-breaker'), [
      { atMs: 777, action: 'inject', nodeId: 'payments', kind: 'crash' },
      { atMs: 2400, action: 'clear', nodeId: 'payments' },
      { atMs: 2400, action: 'cut', edgeId: 'api->breaker' },
      { atMs: 4321, action: 'restore', edgeId: 'api->breaker' },
      {
        atMs: 5600,
        action: 'inject',
        nodeId: 'payments',
        kind: 'slow',
        opts: { factor: 6 },
      },
    ]);
  }

  it('reset() replays the schedule from the start, byte for byte', () => {
    const engine = new Engine(withFaults(preset('load-balanced'), SCHEDULE), 5);
    const first = sampled(engine, PLANS['16ms'], 16, JSON.stringify);
    engine.reset();
    const second = sampled(engine, PLANS['16ms'], 16, JSON.stringify);
    expect(second).toEqual(first);
    expect(engine.faultSchedule()).toEqual(SCHEDULE);
  });

  it('a run broken by hand replays exactly from its export', () => {
    const live = new Engine(preset('load-balanced'), 5);
    const frame = 1000 / 60;
    const liveRun: string[] = [];
    for (let i = 1; i <= 480; i++) {
      live.advance(frame);
      if (i === 70) live.recordFailure('api2', 'crash');
      if (i === 95) live.recordCutEdge('lb->api1');
      if (i === 150) live.recordFailure('db', 'slow', { factor: 3 });
      if (i === 200) live.recordClearFailure('api2');
      if (i === 260) live.recordRestoreEdge('lb->api1');
      if (i % 6 === 0) liveRun.push(JSON.stringify(live.snapshot()));
    }

    const exported = live.exportTopology();
    expect(exported.faults?.map((f) => f.action)).toEqual([
      'inject',
      'cut',
      'inject',
      'clear',
      'restore',
    ]);
    // Recorded at the sim time of the frame boundary, not a wall clock.
    expect(exported.faults?.[0].atMs).toBe(live.faultSchedule()[0].atMs);

    // The export survives the same JSON round trip a saved file takes.
    const replay = new Engine(JSON.parse(JSON.stringify(exported)) as Topology, 5);
    const replayRun: string[] = [];
    for (let i = 1; i <= 480; i++) {
      replay.advance(frame);
      if (i % 6 === 0) replayRun.push(JSON.stringify(replay.snapshot()));
    }
    expect(replayRun).toEqual(liveRun);

    live.reset();
    const afterReset: string[] = [];
    for (let i = 1; i <= 480; i++) {
      live.advance(frame);
      if (i % 6 === 0) afterReset.push(JSON.stringify(live.snapshot()));
    }
    expect(afterReset).toEqual(liveRun);
  });

  it('a recorded fault lands between the authored entries around it', () => {
    const engine = new Engine(
      withFaults(preset('single-server'), [
        {
          atMs: 100,
          action: 'inject',
          nodeId: 'api',
          kind: 'slow',
          opts: { factor: 2 },
        },
        { atMs: 900, action: 'clear', nodeId: 'api' },
      ]),
      1,
    );
    for (let i = 0; i < 10; i++) engine.advance(50);
    engine.recordFailure('api', 'errors', { rate: 0.2 });
    expect(engine.faultSchedule()).toEqual([
      { atMs: 100, action: 'inject', nodeId: 'api', kind: 'slow', opts: { factor: 2 } },
      {
        atMs: 500,
        action: 'inject',
        nodeId: 'api',
        kind: 'errors',
        opts: { rate: 0.2 },
      },
      { atMs: 900, action: 'clear', nodeId: 'api' },
    ]);
  });

  it('exportTopology keeps authored scale, not what a controller grew it to', () => {
    const t = preset('autoscaling-service');
    const authored = JSON.stringify(t.nodes.map((n) => n.config));
    const engine = new Engine(t, 1);
    for (let i = 0; i < 1200; i++) engine.advance(50);
    expect(JSON.stringify(engine.exportTopology().nodes.map((n) => n.config))).toBe(
      authored,
    );
    expect(engine.exportTopology().faults).toBeUndefined();
  });
});

describe('fault schedule: setTopology mid-run', () => {
  const crashAt = (ms: number): FaultEvent => ({
    atMs: ms,
    action: 'inject',
    nodeId: 'payments',
    kind: 'crash',
  });

  it('a topology without `faults` keeps the schedule, recordings included', () => {
    const engine = new Engine(
      withFaults(preset('circuit-breaker'), [crashAt(3000)]),
      1,
    );
    engine.advance(50);
    engine.recordCutEdge('client->api');
    engine.setTopology(preset('circuit-breaker'));
    expect(engine.faultSchedule()).toEqual([
      { atMs: 50, action: 'cut', edgeId: 'client->api' },
      crashAt(3000),
    ]);
    for (let i = 0; i < 80; i++) engine.advance(50);
    expect(engine.activeFailures()).toEqual([
      { nodeId: 'payments', kind: 'crash', sinceMs: 3000 },
    ]);
  });

  it('the same list again does not replay anything', () => {
    const t = withFaults(preset('circuit-breaker'), [
      crashAt(1000),
      { atMs: 1000, action: 'cut', edgeId: 'api->breaker' },
    ]);
    const edited = new Engine(t, 1);
    const untouched = new Engine(t, 1);
    for (let i = 0; i < 100; i++) {
      edited.advance(50);
      untouched.advance(50);
      if (i % 10 === 0) edited.setTopology(t);
    }
    expect(JSON.stringify(edited.snapshot())).toBe(
      JSON.stringify(untouched.snapshot()),
    );
  });

  it('a new list skips entries already in the past and plays the rest', () => {
    const engine = new Engine(preset('circuit-breaker'), 1);
    for (let i = 0; i < 40; i++) engine.advance(50);
    engine.setTopology(
      withFaults(preset('circuit-breaker'), [
        crashAt(500),
        crashAt(2000),
        {
          atMs: 2600,
          action: 'inject',
          nodeId: 'api',
          kind: 'slow',
          opts: { factor: 2 },
        },
      ]),
    );
    expect(engine.activeFailures()).toEqual([]);
    for (let i = 0; i < 20; i++) engine.advance(50);
    expect(engine.activeFailures()).toEqual([
      { nodeId: 'api', kind: 'slow', sinceMs: 2600, factor: 2 },
    ]);
  });

  it('a cut on an edge the edit removed is dropped', () => {
    const engine = new Engine(preset('load-balanced'), 1);
    engine.advance(50);
    engine.cutEdge('lb->api3');
    const t = preset('load-balanced');
    t.edges = t.edges.filter((e) => e.id !== 'lb->api3');
    engine.setTopology(t);
    expect(engine.activeCuts()).toEqual([]);
  });

  /** Where a run ends up: the faults and cuts in force after `frames` more frames. */
  function brokenAfter(engine: Engine, frames: number): string {
    for (let i = 0; i < frames; i++) engine.advance(1000 / 60);
    return JSON.stringify([engine.activeFailures(), engine.activeCuts()]);
  }
  const healthy = JSON.stringify([[], []]);

  it('a recorded cut on an edge deleted and added back stays healed in every replay', () => {
    const live = new Engine(preset('load-balanced'), 1);
    brokenAfter(live, 30);
    expect(live.recordCutEdge('lb->api1')).toBe(true);
    brokenAfter(live, 10);
    const without = preset('load-balanced');
    without.edges = without.edges.filter((e) => e.id !== 'lb->api1');
    live.setTopology(without);
    const removedAt = live.snapshot().system.timeMs;
    brokenAfter(live, 10);
    live.setTopology(preset('load-balanced'));

    expect(live.faultSchedule().map((f) => f.action)).toEqual(['cut', 'restore']);
    expect(live.faultSchedule()[1].atMs).toBe(removedAt);
    expect(brokenAfter(live, 60)).toBe(healthy);
    expect(brokenAfter(new Engine(live.exportTopology(), 1), 120)).toBe(healthy);
    live.reset();
    expect(brokenAfter(live, 120)).toBe(healthy);
  });

  it('a recorded fault on a node deleted and added back stays healed in every replay', () => {
    const live = new Engine(preset('load-balanced'), 1);
    brokenAfter(live, 30);
    live.recordFailure('api2', 'slow', { factor: 3 });
    brokenAfter(live, 10);
    const without = preset('load-balanced');
    without.nodes = without.nodes.filter((n) => n.id !== 'api2');
    without.edges = without.edges.filter((e) => e.from !== 'api2' && e.to !== 'api2');
    live.setTopology(without);
    brokenAfter(live, 10);
    live.setTopology(preset('load-balanced'));

    expect(live.faultSchedule().map((f) => f.action)).toEqual(['inject', 'clear']);
    expect(brokenAfter(live, 60)).toBe(healthy);
    expect(brokenAfter(new Engine(live.exportTopology(), 1), 120)).toBe(healthy);
    live.reset();
    expect(brokenAfter(live, 120)).toBe(healthy);
  });

  it('an edit that removes a fault the schedule never played adds nothing to it', () => {
    const engine = new Engine(preset('load-balanced'), 1);
    engine.advance(50);
    engine.cutEdge('lb->api3');
    engine.injectFailure('api2', 'crash');
    const t = preset('load-balanced');
    t.nodes = t.nodes.filter((n) => n.id !== 'api2');
    t.edges = t.edges.filter(
      (e) => e.id !== 'lb->api3' && e.from !== 'api2' && e.to !== 'api2',
    );
    engine.setTopology(t);
    expect(engine.faultSchedule()).toEqual([]);
  });

  it('a recording made after advance() ran out of events lands after the entries still owed', () => {
    // Enough offered load that one frame needs more events than an advance()
    // may dispatch, so the authored entry inside it is still owed when the
    // student clicks.
    const t = preset('single-server');
    t.nodes.find((n) => n.id === 'client')!.config.rps = 5_000_000;
    const authored: FaultEvent = {
      atMs: 30,
      action: 'inject',
      nodeId: 'api',
      kind: 'slow',
      opts: { factor: 3 },
    };
    const live = new Engine(withFaults(t, [authored]), 1);
    live.advance(1000 / 60);
    live.advance(1000 / 60);
    // Still owed: the frame that crosses 30ms did not get to it.
    expect(live.activeFailures()).toEqual([]);
    live.recordFailure('api', 'crash');

    const times = live.faultSchedule().map((f) => f.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    live.advance(1000 / 60);
    expect(live.activeFailures().map((f) => f.kind)).toEqual(['crash']);
    const replay = new Engine(live.exportTopology(), 1);
    for (let i = 0; i < 3; i++) replay.advance(1000 / 60);
    expect(replay.activeFailures().map((f) => f.kind)).toEqual(['crash']);
  });

  it('an empty list clears the schedule but leaves faults in force', () => {
    const engine = new Engine(withFaults(preset('circuit-breaker'), [crashAt(100)]), 1);
    for (let i = 0; i < 4; i++) engine.advance(50);
    engine.setTopology(withFaults(preset('circuit-breaker'), []));
    expect(engine.faultSchedule()).toEqual([]);
    expect(engine.activeFailures()).toHaveLength(1);
    engine.reset();
    expect(engine.activeFailures()).toEqual([]);
  });
});

describe('sanitizeFaults', () => {
  const t = preset('circuit-breaker');

  it('keeps valid entries in order and strips fields they do not use', () => {
    const input = [
      { atMs: 5, action: 'cut', edgeId: 'api->breaker', nodeId: 'api', extra: 1 },
      {
        atMs: 0,
        action: 'inject',
        nodeId: 'api',
        kind: 'slow',
        opts: { factor: 2, x: 1 },
      },
      { atMs: 1, action: 'clear', nodeId: 'api', kind: 'crash' },
    ];
    expect(sanitizeFaults(input, t)).toEqual([
      { atMs: 5, action: 'cut', edgeId: 'api->breaker' },
      { atMs: 0, action: 'inject', nodeId: 'api', kind: 'slow', opts: { factor: 2 } },
      { atMs: 1, action: 'clear', nodeId: 'api' },
    ]);
  });

  it('drops each kind of bad entry and says why', () => {
    const input: unknown[] = [
      null,
      { atMs: Number.NaN, action: 'clear', nodeId: 'api' },
      { atMs: Number.POSITIVE_INFINITY, action: 'clear', nodeId: 'api' },
      { atMs: -1, action: 'clear', nodeId: 'api' },
      { atMs: '5', action: 'clear', nodeId: 'api' },
      { atMs: 5, action: 'explode', nodeId: 'api' },
      { atMs: 5, action: 'inject', nodeId: 'api', kind: 'meltdown' },
      { atMs: 5, action: 'inject', nodeId: 'ghost', kind: 'crash' },
      { atMs: 5, action: 'clear', nodeId: '' },
      { atMs: 5, action: 'cut', edgeId: 'ghost->api' },
      { atMs: 5, action: 'restore' },
      { atMs: 5, action: 'inject', nodeId: 'api', kind: 'slow', opts: { factor: 'x' } },
      { atMs: 5, action: 'inject', nodeId: 'api', kind: 'errors', opts: 3 },
      {
        atMs: 5,
        action: 'inject',
        nodeId: 'api',
        kind: 'partition',
        opts: { edgeIds: ['api->breaker', 'ghost'] },
      },
    ];
    const dropped: string[] = [];
    expect(sanitizeFaults(input, t, (i, why) => dropped.push(`${i} ${why}`))).toEqual(
      [],
    );
    expect(dropped).toEqual([
      '0 is not an object.',
      '1 has atMs NaN; use a time in milliseconds, 0 or more.',
      '2 has atMs Infinity; use a time in milliseconds, 0 or more.',
      '3 has atMs -1; use a time in milliseconds, 0 or more.',
      '4 has atMs "5"; use a time in milliseconds, 0 or more.',
      '5 has action "explode"; use inject, clear, cut or restore.',
      '6 has kind "meltdown"; use crash, slow, errors, partition.',
      "7 names node 'ghost', but there is no such node.",
      '8 needs `nodeId`.',
      "9 names edge 'ghost->api', but there is no such edge.",
      '10 needs `edgeId`.',
      '11 has opts.factor "x"; use a number.',
      '12 has `opts` that is not an object.',
      "13 cuts edge 'ghost', but there is no such edge.",
    ]);
  });

  it('returns nothing for anything that is not a list', () => {
    expect(sanitizeFaults(undefined, t)).toEqual([]);
    expect(sanitizeFaults({ atMs: 1 }, t)).toEqual([]);
  });

  it('the engine plays only the entries that hold up, without throwing', () => {
    const garbage = withFaults(preset('single-server'), [
      { atMs: Number.NaN, action: 'inject', nodeId: 'api', kind: 'crash' },
      { atMs: 100, action: 'inject', nodeId: 'api', kind: 'nope' },
      { atMs: 200, action: 'inject', nodeId: 'api', kind: 'crash' },
    ] as unknown as FaultEvent[]);
    const engine = new Engine(garbage, 1);
    for (let i = 0; i < 10; i++) engine.advance(50);
    expect(engine.activeFailures()).toEqual([
      { nodeId: 'api', kind: 'crash', sinceMs: 200 },
    ]);
  });
});
