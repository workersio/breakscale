import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import { Engine } from './engine';
import { makeNode, PRESETS } from './presets';
import { Rng } from './random';
import type { NodeConfig, Topology } from './types';
import { burstBatch, nextHerdMs } from './workload';

/**
 * Bursty traffic and the thundering herd: the two arrival shapes that change
 * how requests are grouped rather than how fast they come.
 *
 * Worth pinning: bursty keeps the average and only moves the tail; a herd is
 * exactly N real requests at the cycle boundary; jitter spreads them over the
 * window it states; and the same seed replays both.
 */

/** client -> a service wide enough that it never queues, so this measures arrivals. */
function wideTopology(patch: Partial<NodeConfig>): Topology {
  const client = { ...makeNode('client', 0, 0, 'Client'), id: 'client' };
  const service = { ...makeNode('service', 240, 0, 'Service'), id: 'service' };
  Object.assign(client.config, patch);
  service.config.capacity = 10_000;
  service.config.serviceMs = 1;
  service.config.queueLimit = 100_000;
  return {
    nodes: [client, service],
    edges: [{ id: 'c->s', from: client.id, to: service.id, weight: 1 }],
  };
}

/** advance() takes at most 100ms a call, so longer stretches go in steps. */
function advanceBy(engine: Engine, ms: number): void {
  for (let left = ms; left > 0; left -= 100) engine.advance(Math.min(100, left));
}

/** Requests offered in each `stepMs` slice, for `totalMs`. */
function arrivalsPerStep(
  t: Topology,
  stepMs: number,
  totalMs: number,
  seed = 42,
): number[] {
  const engine = new Engine(t, seed);
  const out: number[] = [];
  let seen = 0;
  for (let ms = 0; ms < totalMs; ms += stepMs) {
    advanceBy(engine, stepMs);
    const total = engine.snapshot().system.totalRequests;
    out.push(total - seen);
    seen = total;
  }
  return out;
}

function presetWith(id: string, patch: Partial<NodeConfig>): Topology {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  const t = structuredClone(preset.topology);
  for (const n of t.nodes) if (n.kind === 'client') Object.assign(n.config, patch);
  return t;
}

function runFor(t: Topology, seconds: number, seed = 42) {
  const engine = new Engine(t, seed);
  for (let i = 0; i < seconds * 10; i++) engine.advance(100);
  const s = engine.snapshot().system;
  return {
    perSecond: s.totalRequests / seconds,
    p99: s.p99,
    failed: s.totalFailed / s.totalRequests,
  };
}

describe('burst batch', () => {
  it('averages the size it was given', () => {
    const rng = new Rng(1);
    for (const mean of [2, 5, 10, 20]) {
      let sum = 0;
      const n = 50_000;
      for (let i = 0; i < n; i++) sum += burstBatch(rng.next(), mean);
      expect(sum / n).toBeGreaterThan(mean * 0.95);
      expect(sum / n).toBeLessThan(mean * 1.05);
    }
  });

  it('is one request at a mean of 1, and never more than its cap', () => {
    expect(burstBatch(0.999999, 1)).toBe(1);
    expect(burstBatch(0.9999999999, 10)).toBeLessThanOrEqual(200);
  });
});

describe('bursty traffic', () => {
  it('keeps the average rate over a long run', () => {
    const arrivals = arrivalsPerStep(
      wideTopology({ rps: 100, traffic: 'bursty', burstSize: 10 }),
      1000,
      300_000,
    );
    const mean = arrivals.reduce((a, b) => a + b, 0) / arrivals.length;
    expect(mean).toBeGreaterThan(95);
    expect(mean).toBeLessThan(105);
  });

  it('clumps: some seconds carry far more than others', () => {
    const steady = arrivalsPerStep(wideTopology({ rps: 100 }), 100, 60_000);
    const bursty = arrivalsPerStep(
      wideTopology({ rps: 100, traffic: 'bursty', burstSize: 20 }),
      100,
      60_000,
    );
    // Same average, so the busiest tenth of a second is the difference.
    expect(Math.max(...bursty)).toBeGreaterThan(Math.max(...steady) * 2);
  });

  it('hurts the tail of a single server at the same average', () => {
    // Measured, seed 42, 60s: plain arrivals p99 122ms and 0% failed;
    // clumps of 20 p99 388ms and 2.9% failed.
    const plain = runFor(presetWith('single-server', {}), 60);
    const bursty = runFor(
      presetWith('single-server', { traffic: 'bursty', burstSize: 20 }),
      60,
    );
    expect(bursty.perSecond).toBeGreaterThan(plain.perSecond * 0.9);
    expect(bursty.perSecond).toBeLessThan(plain.perSecond * 1.1);
    expect(bursty.p99).toBeGreaterThan(plain.p99 * 2);
    expect(plain.failed).toBe(0);
    expect(bursty.failed).toBeGreaterThan(0.01);
  });
});

describe('thundering herd', () => {
  it('fires the whole herd in one tick at each cycle boundary', () => {
    const t = wideTopology({
      rps: 1,
      traffic: 'herd',
      herdSize: 200,
      trafficPeriodS: 5,
    });
    const ticks = arrivalsPerStep(t, 10, 16_000);
    // Steps of 10ms: the boundary at 5000ms closes the 500th step.
    for (const boundary of [5000, 10_000, 15_000]) {
      const step = ticks[boundary / 10 - 1] ?? 0;
      expect(step).toBeGreaterThanOrEqual(200);
      expect(step).toBeLessThan(205);
    }
    const herds = ticks.filter((n) => n >= 200).length;
    expect(herds).toBe(3);
  });

  it('counts every caller as a real request that can fail', () => {
    // Measured, seed 42, 60s with a herd of 500 every 20s: 27.3% failed at
    // once, 9.2% with the herd spread over 2 seconds.
    const once = runFor(
      presetWith('single-server', {
        traffic: 'herd',
        herdSize: 500,
        trafficPeriodS: 20,
      }),
      60,
    );
    const spread = runFor(
      presetWith('single-server', {
        traffic: 'herd',
        herdSize: 500,
        herdSpreadMs: 2000,
        trafficPeriodS: 20,
      }),
      60,
    );
    expect(once.failed).toBeGreaterThan(0.15);
    expect(spread.failed).toBeLessThan(once.failed / 2);
  });

  it('spreads the herd over the window it states', () => {
    const t = wideTopology({
      rps: 1,
      traffic: 'herd',
      herdSize: 200,
      herdSpreadMs: 1000,
      trafficPeriodS: 5,
    });
    const ticks = arrivalsPerStep(t, 10, 7000);
    const sum = (from: number, to: number) =>
      ticks.slice(from / 10, to / 10).reduce((a, b) => a + b, 0);
    // Nothing early, all of it inside the window, none of it in one tick.
    expect(sum(4900, 5000)).toBeLessThan(3);
    expect(sum(5000, 6000)).toBeGreaterThanOrEqual(200);
    expect(sum(5000, 6000)).toBeLessThan(205);
    expect(Math.max(...ticks.slice(500, 600))).toBeLessThan(20);
    expect(sum(6000, 7000)).toBeLessThan(5);
  });

  it('starts when a running client is switched to herd', () => {
    const engine = new Engine(wideTopology({ rps: 1, trafficPeriodS: 5 }), 42);
    advanceBy(engine, 2000);
    engine.updateNodeConfig('client', { traffic: 'herd', herdSize: 100 });
    advanceBy(engine, 2900);
    const before = engine.snapshot().system.totalRequests;
    advanceBy(engine, 200);
    expect(engine.snapshot().system.totalRequests - before).toBeGreaterThanOrEqual(100);
  });

  it('follows a cycle edited while a herd is pending', () => {
    // Herd chosen at the default 60s cycle, then shortened to 5s: the next
    // herd lands at 5s, not a minute in.
    const engine = new Engine(
      wideTopology({ rps: 1, traffic: 'herd', herdSize: 100 }),
      42,
    );
    advanceBy(engine, 1000);
    engine.updateNodeConfig('client', { trafficPeriodS: 5 });
    advanceBy(engine, 3900);
    const before = engine.snapshot().system.totalRequests;
    advanceBy(engine, 200);
    expect(engine.snapshot().system.totalRequests - before).toBeGreaterThanOrEqual(100);
  });

  it('stops when the client is switched away', () => {
    const engine = new Engine(
      wideTopology({ rps: 1, traffic: 'herd', herdSize: 100, trafficPeriodS: 5 }),
      42,
    );
    advanceBy(engine, 1000);
    engine.updateNodeConfig('client', { traffic: 'steady' });
    advanceBy(engine, 10_000);
    expect(engine.snapshot().system.totalRequests).toBeLessThan(40);
  });

  it('lands on whole multiples of the cycle', () => {
    expect(nextHerdMs(0, 5000)).toBe(5000);
    expect(nextHerdMs(4999, 5000)).toBe(5000);
    expect(nextHerdMs(5000, 5000)).toBe(10_000);
  });
});

describe('ramp', () => {
  // 100/s for 60s cycles, read as requests per 2s slice.
  const ramp = { rps: 100, traffic: 'ramp' as const, trafficPeriodS: 20 };

  it('climbs from when it is picked, not from the start of the run', () => {
    const engine = new Engine(wideTopology({ rps: 100 }), 42);
    advanceBy(engine, 64_000);
    engine.updateNodeConfig('client', { traffic: 'ramp', trafficPeriodS: 20 });
    const slice = () => {
      const before = engine.snapshot().system.totalRequests;
      advanceBy(engine, 2000);
      return engine.snapshot().system.totalRequests - before;
    };
    const first = slice();
    advanceBy(engine, 16_000);
    const last = slice();
    advanceBy(engine, 4000);
    const held = slice();
    // Starts near nothing (about 10 expected in the first 2s), ends near
    // the full 200, and holds there.
    expect(first).toBeLessThan(40);
    expect(last).toBeGreaterThan(140);
    expect(held).toBeGreaterThan(160);
  });

  it('a ramp from the start of the run is the same run as before', () => {
    // The climb is measured from 0 for a client that starts on ramp, so
    // its arrivals match a fresh engine on the same seed draw for draw.
    const a = arrivalsPerStep(wideTopology(ramp), 1000, 30_000);
    const b = arrivalsPerStep(wideTopology(ramp), 1000, 30_000);
    expect(a).toEqual(b);
    expect(a[0]).toBeLessThan(15);
    expect(a[25]).toBeGreaterThan(70);
  });
});

describe('replay', () => {
  it('the same seed gives the same arrivals for both shapes', () => {
    for (const patch of [
      { traffic: 'bursty', burstSize: 8 },
      { traffic: 'herd', herdSize: 50, herdSpreadMs: 300, trafficPeriodS: 3 },
    ] as const) {
      const a = arrivalsPerStep(wideTopology({ rps: 80, ...patch }), 50, 10_000, 9);
      const b = arrivalsPerStep(wideTopology({ rps: 80, ...patch }), 50, 10_000, 9);
      expect(b).toEqual(a);
    }
  });

  it('shape fields on a steady client change nothing', () => {
    const plain = arrivalsPerStep(wideTopology({ rps: 80 }), 50, 10_000);
    const carried = arrivalsPerStep(
      wideTopology({ rps: 80, burstSize: 30, herdSize: 900, herdSpreadMs: 500 }),
      50,
      10_000,
    );
    expect(carried).toEqual(plain);
  });

  it('a share link carries the shape and its settings', () => {
    const t = wideTopology({
      rps: 80,
      traffic: 'herd',
      herdSize: 750,
      herdSpreadMs: 1500,
      trafficPeriodS: 30,
    });
    t.nodes[1]!.config.burstSize = 12;
    const back = unpackTopology(packTopology(t));
    if (back === null) throw new Error('did not decode');
    const client = back.nodes.find((n) => n.kind === 'client')!;
    expect(client.config.traffic).toBe('herd');
    expect(client.config.herdSize).toBe(750);
    expect(client.config.herdSpreadMs).toBe(1500);
    expect(client.config.trafficPeriodS).toBe(30);
    const bursty = unpackTopology(
      packTopology(wideTopology({ rps: 80, traffic: 'bursty', burstSize: 7 })),
    );
    expect(bursty?.nodes.find((n) => n.kind === 'client')!.config.burstSize).toBe(7);
  });
});
