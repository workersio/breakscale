import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS, defaultConfig } from './presets';
import type { NodeConfig, SimSnapshot, Topology } from './types';

/**
 * Edge lossRate: a lossy link drops a share of the requests sent across it.
 *
 * The drop is a draw from the seeded RNG, so the measured share has to land
 * near the configured one, the same seed has to drop the same requests, and
 * a link with no loss has to draw nothing at all, or every existing design
 * would quietly become a different run.
 */

const RPS = 1000;
const SECONDS = 20;

function pair(
  lossRate: number | undefined,
  client: Partial<NodeConfig> = {},
): Topology {
  return {
    nodes: [
      {
        id: 'client',
        kind: 'client',
        label: 'Client',
        x: 0,
        y: 0,
        config: { ...defaultConfig('client'), rps: RPS, ...client },
      },
      {
        id: 'api',
        kind: 'service',
        label: 'API',
        x: 200,
        y: 0,
        // Far more slots than the load needs, so the link is the only thing
        // that can fail a request.
        config: {
          ...defaultConfig('service'),
          capacity: 1000,
          serviceMs: 2,
          serviceCv: 0,
          queueLimit: 10_000,
          errorRate: 0,
        },
      },
    ],
    edges: [
      {
        id: 'client->api',
        from: 'client',
        to: 'api',
        weight: 1,
        ...(lossRate !== undefined ? { lossRate } : {}),
      },
    ],
  };
}

function run(t: Topology, seed: number, seconds = SECONDS): SimSnapshot {
  const engine = new Engine(t, seed);
  for (let i = 0; i < 60 * seconds; i++) engine.advance(1000 / 60);
  return engine.snapshot();
}

/** Four standard deviations of a sampled proportion, the test's tolerance. */
function tolerance(p: number, n: number): number {
  return 4 * Math.sqrt((p * (1 - p)) / n);
}

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return structuredClone(p.topology);
}

function withLoss(t: Topology, lossRate: number): Topology {
  return { ...t, edges: t.edges.map((e) => ({ ...e, lossRate })) };
}

describe('link loss: measured rate', () => {
  it.each([0.01, 0.1, 0.3, 0.5])('drops about %s of crossings', (p) => {
    const snap = run(pair(p), 11);
    const n = snap.system.totalRequests;
    const lost = snap.failuresByReason['packet-loss'] ?? 0;
    const measured = lost / n;
    const tol = tolerance(p, n);
    console.log(
      `lossRate ${p}: ${lost} of ${n} lost, ${measured.toFixed(4)}, ` +
        `off by ${(measured - p).toFixed(4)}, tolerance ${tol.toFixed(4)}`,
    );
    expect(Math.abs(measured - p)).toBeLessThan(tol);
    // Every failure is the link's: the API never failed anything itself.
    expect(snap.system.totalFailed).toBe(lost);
    expect(snap.nodes.api!.totalFailed).toBe(0);
    // The target never sees a dropped request, so it completes the rest.
    // Up to a frame of requests can still be in flight at the end.
    const delivered = snap.nodes.api!.totalCompleted;
    expect(n - lost - delivered).toBeGreaterThanOrEqual(0);
    expect(n - lost - delivered).toBeLessThan(RPS / 50);
  });

  it('drops everything at 1, and the target sees nothing', () => {
    const snap = run(pair(1), 3, 5);
    expect(snap.failuresByReason['packet-loss']).toBe(snap.system.totalRequests);
    expect(snap.nodes.api!.totalCompleted).toBe(0);
    expect(snap.nodes.api!.arrivalRate).toBe(0);
    expect(snap.edgeFlow['client->api']).toBe(0);
  });

  it('treats a rate above 1 as 1, and a negative or NaN rate as no loss', () => {
    const over = run(pair(2), 3, 5);
    expect(over.failuresByReason['packet-loss']).toBe(over.system.totalRequests);
    for (const bad of [-0.5, Number.NaN]) {
      const snap = run(pair(bad), 3, 5);
      expect(snap.failuresByReason['packet-loss']).toBeUndefined();
      expect(JSON.stringify(snap)).toBe(JSON.stringify(run(pair(undefined), 3, 5)));
    }
  });
});

describe('link loss: retries', () => {
  // Each retry is a fresh crossing and a fresh draw, so a request with two
  // retries only fails when all three tries are lost: p cubed.
  it.each([0.1, 0.3, 0.5])('two retries at %s fail about p^3 of requests', (p) => {
    const snap = run(pair(p, { retries: 2 }), 5);
    const n = snap.system.totalRequests;
    const lost = snap.failuresByReason['packet-loss'] ?? 0;
    const expected = p ** 3;
    const measured = lost / n;
    const tol = tolerance(expected, n);
    // What the retries cost: every lost try is sent again, so the API is
    // offered about n * (1 + p + p^2) tries, of which n * (1 - p^3) arrive.
    const delivered = snap.nodes.api!.totalCompleted;
    // The client books each lost try once, and each request that ran out of
    // tries once more.
    const lostTries = snap.nodes.client!.totalFailed - lost;
    const tries = delivered + lostTries;
    const expectedTries = n * (1 + p + p * p);
    console.log(
      `retries 2, lossRate ${p}: ${lost} of ${n} failed, ${measured.toFixed(4)}, ` +
        `expected ${expected.toFixed(4)}, tolerance ${tol.toFixed(4)}; ` +
        `API completed ${delivered}, expected about ${Math.round(n * (1 - expected))}; ` +
        `${tries} tries sent, expected about ${Math.round(expectedTries)}`,
    );
    expect(Math.abs(tries / expectedTries - 1)).toBeLessThan(0.02);
    expect(Math.abs(measured - expected)).toBeLessThan(tol);
    expect(Math.abs(delivered / n - (1 - expected))).toBeLessThan(
      tolerance(expected, n) + RPS / 50 / n,
    );
  });

  it('a retry crosses the same lossy link again rather than going around it', () => {
    // With loss 1 nothing ever gets through, however many retries there are.
    // The requests not counted yet are still waiting out a retry backoff.
    const snap = run(pair(1, { retries: 3 }), 5, 5);
    expect(snap.system.totalFailed).toBe(snap.failuresByReason['packet-loss']);
    expect(snap.system.totalFailed / snap.system.totalRequests).toBeGreaterThan(0.95);
    expect(snap.nodes.api!.totalCompleted).toBe(0);
  });
});

describe('link loss: determinism', () => {
  it('the same seed drops the same requests, byte for byte', () => {
    const t = withLoss(preset('circuit-breaker'), 0.2);
    expect(JSON.stringify(run(t, 9, 10))).toBe(JSON.stringify(run(t, 9, 10)));
  });

  it('reset() replays the same drops', () => {
    const t = withLoss(preset('load-balanced'), 0.15);
    const engine = new Engine(t, 4);
    const frames = (): string => {
      for (let i = 0; i < 300; i++) engine.advance(1000 / 60);
      return JSON.stringify(engine.snapshot());
    };
    const first = frames();
    engine.reset();
    expect(frames()).toBe(first);
  });

  it('a different seed drops different requests', () => {
    const a = run(pair(0.3), 1, 5);
    const b = run(pair(0.3), 2, 5);
    expect(a.failuresByReason['packet-loss']).not.toBe(
      b.failuresByReason['packet-loss'],
    );
  });
});

describe('link loss: none', () => {
  /*
   * Copied from faults.test.ts, where they were recorded from the engine
   * before the fault schedule existed. A lossless design must still produce
   * exactly these bytes, which also proves the snapshot has no new key.
   */
  const GOLDEN: Record<string, string> = {
    'single-server': '49bcdb3e01f324691f7e7d302a0d14a99ba1fa76f3224fe8b4998a05927483bf',
    'circuit-breaker':
      '3eddc5220fd2f72b29003953b9b1c912ab57d865e1a38d29236042426b338203',
    'multi-region': '4ecca465ea59ec9afb7c502f258fc9c34fe9e04fd64ce073742b580d6dce9ffa',
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

  it.each(Object.keys(GOLDEN))(
    '%s with lossRate 0 on every edge is unchanged',
    (id) => {
      expect(hash(withLoss(preset(id), 0))).toBe(GOLDEN[id]);
    },
  );

  it('every preset runs the same with lossRate 0 as with none', () => {
    for (const p of PRESETS) {
      const plain = run(structuredClone(p.topology), 7, 3);
      const zero = run(withLoss(structuredClone(p.topology), 0), 7, 3);
      expect(JSON.stringify(zero), p.id).toBe(JSON.stringify(plain));
      expect(plain.failuresByReason['packet-loss'], p.id).toBeUndefined();
    }
  });
});

describe('link loss: edits and other failures', () => {
  it('a lossRate set mid-run applies from then on', () => {
    const engine = new Engine(pair(undefined), 6);
    for (let i = 0; i < 120; i++) engine.advance(1000 / 60);
    expect(engine.snapshot().failuresByReason['packet-loss']).toBeUndefined();
    engine.setTopology(pair(0.5));
    for (let i = 0; i < 120; i++) engine.advance(1000 / 60);
    expect(engine.snapshot().failuresByReason['packet-loss']).toBeGreaterThan(0);
  });

  it('a cut link fails as partitioned and draws no loss', () => {
    const engine = new Engine(pair(0.5), 6);
    engine.cutEdge('client->api');
    for (let i = 0; i < 120; i++) engine.advance(1000 / 60);
    const snap = engine.snapshot();
    expect(snap.failuresByReason['packet-loss']).toBeUndefined();
    expect(snap.failuresByReason.partitioned).toBe(snap.system.totalRequests);
  });

  it('only the lossy backend loses traffic behind a load balancer', () => {
    const t = preset('load-balanced');
    const lb = t.nodes.find((n) => n.kind === 'lb');
    if (!lb) throw new Error('load-balanced has no lb');
    const out = t.edges.filter((e) => e.from === lb.id);
    expect(out.length).toBeGreaterThan(1);
    const lossy = out[0]!.id;
    t.edges = t.edges.map((e) => (e.id === lossy ? { ...e, lossRate: 0.4 } : e));
    const snap = run(t, 8, 10);
    expect(snap.failuresByReason['packet-loss']).toBeGreaterThan(0);
    for (const e of out.slice(1)) expect(snap.edgeFlow[e.id]).toBeGreaterThan(0);
  });
});
