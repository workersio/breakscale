import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS, makeNode } from './presets';
import type {
  FailureReason,
  FaultEvent,
  NodeStats,
  SimSnapshot,
  Topology,
} from './types';

/*
 * The tally is what a verdict is graded on, so it has two jobs: see every
 * client request that settles while it runs, and change nothing about the
 * run it watches. The first is checked against the engine's own end-to-end
 * ring, which the snapshot's percentiles are read from, and against the
 * snapshot's lifetime counters. The second against a run with no tally.
 */

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.topology;
}

/** A run with retries, timeouts and a fault, so every root path is taken. */
function stormy(): Topology {
  const faults: FaultEvent[] = [
    { atMs: 3000, action: 'inject', nodeId: 'db', kind: 'slow', opts: { factor: 4 } },
    { atMs: 6000, action: 'clear', nodeId: 'db' },
  ];
  return { ...preset('retry-storm'), faults };
}

function step(engine: Engine, ms: number): void {
  for (let t = 0; t < ms; t += 50) engine.advance(50);
}

/** The engine's end-to-end ring, the only private part these tests reach. */
interface WithRing {
  sysLatency: { add(now: number, v: number): void };
}

/** Every latency the engine hands its end-to-end ring, in order. */
function recordRing(engine: Engine): number[] {
  const seen: number[] = [];
  const ring = (engine as unknown as WithRing).sysLatency;
  const add = ring.add.bind(ring);
  ring.add = (now, v) => {
    seen.push(v);
    add(now, v);
  };
  return seen;
}

function clientCompleted(snap: SimSnapshot, topology: Topology): number {
  let n = 0;
  for (const node of topology.nodes) {
    if (node.kind !== 'client') continue;
    n += (snap.nodes[node.id] as NodeStats | undefined)?.totalCompleted ?? 0;
  }
  return n;
}

describe('the tally', () => {
  it('is null until one is started', () => {
    const engine = new Engine(preset('single-server'), 1);
    step(engine, 1000);
    expect(engine.readTally()).toBeNull();
  });

  it('leaves every snapshot of the run byte for byte as it was', () => {
    const plain = new Engine(stormy(), 3);
    const tallied = new Engine(stormy(), 3);
    for (let s = 0; s < 12; s++) {
      if (s === 2) tallied.startTally();
      if (s === 9) tallied.stopTally();
      step(plain, 1000);
      step(tallied, 1000);
      expect(JSON.stringify(tallied.snapshot())).toBe(JSON.stringify(plain.snapshot()));
    }
  });

  it('holds exactly the latencies of the requests that succeeded inside it', () => {
    const topology = stormy();
    const engine = new Engine(topology, 2);
    step(engine, 2000);
    const before = engine.snapshot();
    const completedBefore = clientCompleted(before, topology);
    const totalBefore = before.system.totalRequests;
    const failedBefore = before.system.totalFailed;
    const reasonsBefore = { ...before.failuresByReason };

    const seen = recordRing(engine);
    engine.startTally();
    step(engine, 8000);
    const tally = engine.readTally();
    const after = engine.snapshot();
    if (tally === null) throw new Error('no tally');

    expect(Array.from(tally.latencies)).toEqual(seen);
    expect(tally.completed).toBe(seen.length);
    expect(tally.completed).toBe(clientCompleted(after, topology) - completedBefore);
    expect(tally.arrived).toBe(after.system.totalRequests - totalBefore);
    expect(tally.failed).toBe(after.system.totalFailed - failedBefore);
    expect(tally.failed).toBeGreaterThan(0);

    const reasons: Partial<Record<FailureReason, number>> = {};
    for (const [reason, n] of Object.entries(after.failuresByReason)) {
      const d = (n ?? 0) - (reasonsBefore[reason as FailureReason] ?? 0);
      if (d > 0) reasons[reason as FailureReason] = d;
    }
    expect(tally.failuresByReason).toEqual(reasons);
    expect(tally.fromMs).toBe(2000);
    expect(tally.toMs).toBe(10000);
  });

  it('grows past its first allocation without losing an entry', () => {
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 3000 };
    const api = { ...makeNode('service', 200, 0), id: 'api' };
    api.config = { ...api.config, capacity: 512, serviceMs: 5 };
    const topology: Topology = {
      nodes: [client, api],
      edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1 }],
    };
    const engine = new Engine(topology, 1);
    const seen = recordRing(engine);
    engine.startTally();
    step(engine, 5000);
    const tally = engine.readTally();
    // 4096 is where the first doubling happens.
    expect(seen.length).toBeGreaterThan(4096 * 2);
    expect(tally && Array.from(tally.latencies)).toEqual(seen);
  });

  it('stops counting when stopped and keeps what it had', () => {
    const engine = new Engine(preset('single-server'), 1);
    engine.startTally();
    step(engine, 3000);
    engine.stopTally();
    const stopped = engine.readTally();
    step(engine, 3000);
    expect(engine.readTally()).toEqual(stopped);
    expect(stopped?.toMs).toBe(3000);
    expect(stopped?.completed).toBeGreaterThan(0);
  });

  it('hands out copies, so reading it cannot change it', () => {
    const engine = new Engine(preset('single-server'), 1);
    engine.startTally();
    step(engine, 2000);
    const first = engine.readTally();
    if (first === null) throw new Error('no tally');
    first.latencies.fill(-1);
    first.failuresByReason.shed = 999;
    const again = engine.readTally();
    expect(again?.latencies.some((v) => v < 0)).toBe(false);
    expect(again?.failuresByReason.shed).toBeUndefined();
  });

  it('starts over when started again, and is gone after a reset', () => {
    const engine = new Engine(preset('single-server'), 1);
    engine.startTally();
    step(engine, 2000);
    engine.startTally();
    expect(engine.readTally()?.completed).toBe(0);
    expect(engine.readTally()?.fromMs).toBe(2000);
    step(engine, 1000);
    engine.reset();
    expect(engine.readTally()).toBeNull();
  });

  it('counts the requests the engine sheds at its own ceiling', () => {
    // The overload test's design: 50k a second into a queue with no limit
    // reaches the 200k live-request ceiling in about four seconds.
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 50_000 };
    const api = { ...makeNode('service', 240, 0), id: 'api' };
    api.config = { ...api.config, queueLimit: Number.MAX_SAFE_INTEGER };
    const topology: Topology = {
      nodes: [client, api],
      edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1 }],
    };
    const engine = new Engine(topology, 7);
    for (let i = 0; i < 4 * 60; i++) engine.advance(1000 / 60);
    // failuresByReason is the engine's live object, so it is copied here.
    const sumOf = (r: Record<string, number | undefined>): number =>
      Object.values(r).reduce<number>((a, n) => a + (n ?? 0), 0);
    const before = engine.snapshot();
    const totalBefore = before.system.totalRequests;
    const reasonsBefore = { ...before.failuresByReason };
    engine.startTally();
    for (let i = 0; i < 60; i++) engine.advance(1000 / 60);
    const after = engine.snapshot();
    const tally = engine.readTally();
    expect(tally?.arrived).toBe(after.system.totalRequests - totalBefore);
    // Against the reasons rather than system.totalFailed, which has never
    // counted a ceiling shed although failuresByReason has.
    expect(tally?.failed).toBe(sumOf(after.failuresByReason) - sumOf(reasonsBefore));
    expect(tally?.failuresByReason.shed).toBe(
      after.failuresByReason.shed - reasonsBefore.shed,
    );
    expect(tally?.failuresByReason.shed ?? 0).toBeGreaterThan(0);
  }, 60000);

  it('counts the saves a write-behind cache acknowledges, and the ones that land', () => {
    // A slow database turns flushes away while it is slow. Nobody upstream
    // hears of it, so only the tally can say how many promises broke.
    const slowed = (): Topology => ({
      ...preset('resilient-delivery'),
      faults: [
        {
          atMs: 3000,
          action: 'inject',
          nodeId: 'db',
          kind: 'slow',
          opts: { factor: 4 },
        },
        { atMs: 8000, action: 'clear', nodeId: 'db' },
      ],
    });
    const plain = new Engine(slowed(), 4);
    const engine = new Engine(slowed(), 4);
    step(plain, 2000);
    step(engine, 2000);
    engine.startTally();
    step(plain, 8000);
    step(engine, 8000);
    engine.stopTally();
    const atStop = engine.readTally();
    step(plain, 3000);
    step(engine, 3000);
    const settled = engine.readTally();
    if (atStop === null || settled === null) throw new Error('no tally');

    expect(atStop.writesAcked).toBeGreaterThan(0);
    // Stopped means no new acks count; the ones already made keep landing.
    expect(settled.writesAcked).toBe(atStop.writesAcked);
    expect(settled.writesLanded).toBeGreaterThan(atStop.writesLanded);
    expect(settled.writesLanded).toBeLessThan(settled.writesAcked);
    expect(JSON.stringify(engine.snapshot())).toBe(JSON.stringify(plain.snapshot()));

    // A healthy database takes every one of them.
    const healthy = new Engine(preset('resilient-delivery'), 4);
    step(healthy, 2000);
    healthy.startTally();
    step(healthy, 5000);
    healthy.stopTally();
    step(healthy, 2000);
    const fine = healthy.readTally();
    expect(fine?.writesAcked).toBeGreaterThan(0);
    expect(fine?.writesLanded).toBe(fine?.writesAcked);
  });

  it('counts the jobs a queue accepted that fail once a worker takes them', () => {
    // A database with one slot and no line turns most of the workers' calls
    // away. The uploads were acked at the queue, so no client hears of it.
    const starved = (): Topology => {
      const t = preset('async-workers');
      return {
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === 'db'
            ? { ...n, config: { ...n.config, capacity: 1, queueLimit: 0 } }
            : n,
        ),
      };
    };
    const plain = new Engine(starved(), 2);
    const engine = new Engine(starved(), 2);
    step(plain, 2000);
    step(engine, 2000);
    engine.startTally();
    step(plain, 5000);
    step(engine, 5000);
    engine.stopTally();
    const atStop = engine.readTally();
    step(plain, 2000);
    step(engine, 2000);
    const settled = engine.readTally();
    if (atStop === null || settled === null) throw new Error('no tally');

    expect(atStop.jobsQueued).toBeGreaterThan(0);
    expect(atStop.failed).toBe(0);
    expect(atStop.jobsFailed).toBeGreaterThan(0);
    // Stopped means no new jobs count; the ones already queued can still fail.
    expect(settled.jobsQueued).toBe(atStop.jobsQueued);
    expect(settled.jobsFailed).toBeGreaterThanOrEqual(atStop.jobsFailed);
    expect(settled.jobsFailed).toBeLessThanOrEqual(settled.jobsQueued);
    expect(JSON.stringify(engine.snapshot())).toBe(JSON.stringify(plain.snapshot()));

    // A database with room fails none of them.
    const healthy = new Engine(preset('async-workers'), 2);
    step(healthy, 2000);
    healthy.startTally();
    step(healthy, 5000);
    healthy.stopTally();
    step(healthy, 2000);
    const fine = healthy.readTally();
    expect(fine?.jobsQueued).toBeGreaterThan(0);
    expect(fine?.jobsFailed).toBe(0);
  });
});
