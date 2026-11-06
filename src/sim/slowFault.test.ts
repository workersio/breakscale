import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { NodeConfig, NodeKind, NodeStats, Topology } from './types';

/**
 * A 'slow' fault on the kinds that time their own work.
 *
 * Stores, replicas, shards, the websocket handshake and lambda run their own
 * slot discipline and hand timing to serveWithin(), which used to draw the
 * service time without looking at the fault. Slow on any of them changed
 * nothing at all, so the inspector's Slow button did nothing for a database.
 *
 * Every service here is set to a fixed time (serviceCv 0), so the median the
 * node reports is that time exactly and the slowdown can be read off it.
 */

const FRAME = 1000 / 60;
const FACTOR = 6;

/** A client sending `rps` straight at one node with id 'n'. */
function leaf(kind: NodeKind, rps: number, tweak: Partial<NodeConfig> = {}): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config.rps = rps;
  client.config.timeoutMs = 0;
  const n = { ...makeNode(kind, 240, 0), id: 'n' };
  Object.assign(n.config, tweak);
  return {
    nodes: [client, n],
    edges: [{ id: 'e', from: 'client', to: 'n', weight: 1 }],
  };
}

/** Advance `ms` at 60fps and read the node. */
function run(engine: Engine, ms: number): NodeStats {
  for (let t = 0; t < ms; t += FRAME) engine.advance(FRAME);
  return engine.snapshot().nodes.n;
}

/**
 * Healthy, slowed and healed medians. Each phase runs long enough for every
 * request still in service from the phase before to finish, and then for a
 * full latency window, so the median reads only that phase's requests.
 */
function medians(t: Topology, settleMs: number) {
  const engine = new Engine(t, 7);
  const healthy = run(engine, settleMs + 6000).p50;
  engine.injectFailure('n', 'slow', { factor: FACTOR });
  const slowed = run(engine, settleMs * FACTOR + 6000).p50;
  engine.clearFailure('n');
  const healed = run(engine, settleMs * FACTOR + 6000).p50;
  return { healthy, slowed, healed };
}

/**
 * Each kind with its fixed per-request time, in ms. Reads only where a kind
 * mixes classes, so every request costs the same; the surcharge kinds keep
 * theirs, because a slow node does all of its own work slowly.
 */
const FIXED: [NodeKind, Partial<NodeConfig>, number][] = [
  ['db', { readFraction: 1, capacity: 1000, queueLimit: 1e6 }, 30],
  ['replica', { readFraction: 1, capacity: 1000, queueLimit: 1e6 }, 20],
  ['shard', { shardCapacity: 1000, queueLimit: 1e6 }, 25],
  ['searchindex', { readFraction: 1, capacity: 1000, queueLimit: 1e6 }, 8],
  // Every query is a range query: 1.5ms base plus the 120ms scan surcharge.
  ['timeseriesdb', { rangeQueryFraction: 1, capacity: 1000, queueLimit: 1e6 }, 121.5],
  // Depth 3 at a mean out-degree of 3: 6ms x 3^2.
  ['graphdb', { traversalDepth: 3, capacity: 1000, queueLimit: 1e6 }, 54],
  ['coldstorage', { capacity: 1000 }, 2800],
  ['websocket', { capacity: 1e6 }, 5],
  // Warm invocations; the cold starts are a few percent and sit above p50.
  ['lambda', { maxConcurrency: 1000 }, 25],
];

describe('slow fault on a kind that times its own work', () => {
  it.each(FIXED)(
    '%s is six times slower per request when slowed, and heals',
    (kind, tweak, ms) => {
      const rps = kind === 'coldstorage' ? 2 : 20;
      const settle = kind === 'coldstorage' ? 3000 : 500;
      const m = medians(leaf(kind, rps, { serviceCv: 0, ...tweak }), settle);
      expect(m.healthy).toBeCloseTo(ms, 6);
      expect(m.slowed).toBeCloseTo(ms * FACTOR, 6);
      expect(m.healed).toBeCloseTo(ms, 6);
    },
  );

  it('vectordb stretches its whole query cost, not just the drawn part', () => {
    // At the default corpus and recall the drawn 0.5ms is 1 percent of the
    // query; the probe cost is the rest. Stretching only the draw would read
    // about 1.05x here.
    const m = medians(
      leaf('vectordb', 20, { serviceCv: 0, capacity: 1000, queueLimit: 1e6 }),
      500,
    );
    expect(m.healthy).toBeGreaterThan(40);
    expect(m.slowed / m.healthy).toBeCloseTo(FACTOR, 6);
    expect(m.healed).toBeCloseTo(m.healthy, 6);
  });

  it('a lock wait is waiting, not work, so it is not stretched', () => {
    /*
     * Every request a write, 10ms of lock wait per write already in service.
     * Slowed, each write is 180ms of work plus 10ms per writer ahead of it.
     * The wait still grows, because slowed writes stay in service longer and
     * more of them overlap, and the readout reports the wait that was really
     * added. Stretching it as well would put 60ms per writer on the median.
     */
    const t = leaf('db', 20, {
      readFraction: 0,
      lockMs: 10,
      serviceCv: 0,
      capacity: 1000,
      queueLimit: 1e6,
    });
    const engine = new Engine(t, 7);
    const healthy = run(engine, 6000);
    engine.injectFailure('n', 'slow', { factor: FACTOR });
    run(engine, 1000);
    let waited = 0;
    let slowed = healthy;
    for (let i = 0; i < 6; i++) {
      slowed = run(engine, 1000);
      waited += slowed.lockWaitMs ?? 0;
    }
    const meanWait = waited / 6;
    const ownWait = slowed.p50 - 30 * FACTOR;
    expect(ownWait % 10).toBe(0);
    expect(ownWait).toBeGreaterThan(healthy.p50 - 30);
    expect(Math.abs(ownWait - meanWait)).toBeLessThan(20);
  });
});

describe('slow fault: what the slowdown does to the line', () => {
  /*
   * Default configs, at a load each handles comfortably. Six times the
   * service time is past every one of these ceilings, so a line builds and
   * overflows. Fixing the node drains it.
   */
  const QUEUED: [NodeKind, number][] = [
    ['db', 100],
    ['replica', 100],
    ['shard', 100],
    ['searchindex', 150],
    ['graphdb', 150],
    ['vectordb', 100],
  ];

  it.each(QUEUED)(
    '%s at %d rps queues and sheds when slowed, and drains when fixed',
    (kind, rps) => {
      const engine = new Engine(leaf(kind, rps), 7);
      const healthy = run(engine, 6000);
      expect(healthy.queued).toBeLessThan(5);
      expect(healthy.errorRate).toBe(0);

      engine.injectFailure('n', 'slow', { factor: FACTOR });
      const slowed = run(engine, 6000);
      expect(slowed.queued).toBeGreaterThan(healthy.queued + 2);
      expect(slowed.p99).toBeGreaterThan(healthy.p99 * 3);
      expect(slowed.utilization).toBeGreaterThan(0.75);

      engine.clearFailure('n');
      const healed = run(engine, 8000);
      expect(healed.queued).toBeLessThan(5);
      expect(healed.errorRate).toBe(0);
      expect(healed.p50).toBeLessThan(healthy.p50 * 1.5);
    },
  );

  it('lambda has no line: it runs out of concurrency and throttles, then recovers', () => {
    // 400 rps of 25ms is about 10 running at once against a cap of 40.
    // Slowed, it needs about 60.
    const engine = new Engine(leaf('lambda', 400), 7);
    const healthy = run(engine, 6000);
    expect(healthy.runningNow).toBeLessThan(20);
    expect(healthy.throttledRate ?? 0).toBe(0);

    engine.injectFailure('n', 'slow', { factor: FACTOR });
    const slowed = run(engine, 6000);
    expect(slowed.runningNow).toBe(40);
    expect(slowed.throttledRate ?? 0).toBeGreaterThan(50);

    engine.clearFailure('n');
    const healed = run(engine, 8000);
    expect(healed.runningNow).toBeLessThan(20);
    expect(healed.throttledRate ?? 0).toBe(0);
  });

  it('cold storage has no line either: it refuses restores past its job quota', () => {
    // 4 restores a second of 2.8s is about 11 jobs against a quota of 24.
    const engine = new Engine(leaf('coldstorage', 4), 7);
    const healthy = run(engine, 10_000);
    expect(healthy.throttledRate ?? 0).toBe(0);

    engine.injectFailure('n', 'slow', { factor: FACTOR });
    const slowed = run(engine, 20_000);
    expect(slowed.inFlight).toBeGreaterThan(20);
    expect(slowed.throttledRate ?? 0).toBeGreaterThan(1);

    engine.clearFailure('n');
    // Restores started while slowed keep their 16.8s; wait them out.
    const healed = run(engine, 25_000);
    expect(healed.throttledRate ?? 0).toBe(0);
    expect(healed.inFlight).toBeLessThan(20);
  });
});
