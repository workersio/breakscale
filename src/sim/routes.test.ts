import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { PRESETS, makeNode } from './presets';
import type { RouteStats, SimNode, Topology } from './types';

/*
 * Per-route figures: each client's own requests, end to end.
 *
 * The fixture is two kinds of user on separate services that share a
 * database. Slowing the checkout service is a fault only checkout users go
 * through, so the system figures blur it and the routes must not.
 */

const FRAME = 1000 / 60;

function node(kind: SimNode['kind'], id: string, label: string, x: number): SimNode {
  return { ...makeNode(kind, x, 0), id, label };
}

function shop(): Topology {
  const checkout = node('client', 'checkout', 'Checkout users', 0);
  checkout.config = { ...checkout.config, rps: 40, timeoutMs: 300, retries: 0 };
  const browse = node('client', 'browse', 'Browsers', 0);
  browse.config = { ...browse.config, rps: 60, timeoutMs: 300, retries: 0 };
  const pay = node('service', 'pay', 'Payments', 200);
  pay.config = {
    ...pay.config,
    serviceMs: 20,
    serviceCv: 0,
    capacity: 64,
    errorRate: 0,
  };
  const catalog = node('service', 'catalog', 'Catalog', 200);
  catalog.config = {
    ...catalog.config,
    serviceMs: 10,
    serviceCv: 0,
    capacity: 64,
    errorRate: 0,
  };
  const db = node('db', 'db', 'Database', 400);
  db.config = { ...db.config, serviceMs: 5, serviceCv: 0, capacity: 64, errorRate: 0 };
  return {
    nodes: [checkout, browse, pay, catalog, db],
    edges: [
      { id: 'checkout->pay', from: 'checkout', to: 'pay', weight: 1 },
      { id: 'browse->catalog', from: 'browse', to: 'catalog', weight: 1 },
      { id: 'pay->db', from: 'pay', to: 'db', weight: 1 },
      { id: 'catalog->db', from: 'catalog', to: 'db', weight: 1 },
    ],
  };
}

function play(engine: Engine, ms: number): void {
  const end = engine.now + ms;
  while (end - engine.now > 1e-9) engine.advance(Math.min(FRAME, end - engine.now));
}

function byId(routes: RouteStats[]): Record<string, RouteStats> {
  return Object.fromEntries(routes.map((r) => [r.clientId, r]));
}

describe('routes', () => {
  it('splits every client request by the client that sent it, exactly', () => {
    const engine = new Engine(shop(), 4);
    play(engine, 5000);
    engine.injectFailure('pay', 'slow', { factor: 20 });
    play(engine, 10_000);
    const snap = engine.snapshot();
    const routes = engine.routes();
    const r = byId(routes);

    expect(routes.map((x) => x.clientId)).toEqual(['checkout', 'browse']);

    // Lifetime counts add up to the system's, with nothing lost or doubled.
    const sum = (f: (x: RouteStats) => number) => routes.reduce((s, x) => s + f(x), 0);
    expect(sum((x) => x.totalRequests)).toBe(snap.system.totalRequests);
    expect(sum((x) => x.totalFailed)).toBe(snap.system.totalFailed);
    for (const x of routes) {
      expect(x.totalCompleted).toBe(snap.nodes[x.clientId].totalCompleted);
    }

    // 20 x 20ms is 400ms of work behind a 300ms timeout: every checkout
    // request sent after the fault times out, and nothing else fails.
    expect(r.browse.totalFailed).toBe(0);
    expect(r.checkout.failuresByReason).toEqual({ timeout: r.checkout.totalFailed });
    expect(r.checkout.totalFailed).toBeGreaterThan(350);

    // The live window holds only the slowed phase.
    expect(r.checkout.goodputRps).toBe(0);
    expect(r.checkout.errorRate).toBe(1);
    expect(Object.keys(r.checkout.failureRates)).toEqual(['timeout']);
    expect(r.browse.errorRate).toBe(0);
    expect(r.browse.failedRps).toBe(0);
    // Fixed service times with nothing queued: 10ms at the catalog, 5ms at
    // the database, so every browse request takes exactly 15ms.
    expect(r.browse.p50).toBe(15);
    expect(r.browse.p99).toBe(15);

    // The system averages the two and shows neither.
    expect(snap.system.errorRate).toBeGreaterThan(0.3);
    expect(snap.system.errorRate).toBeLessThan(0.5);
  });

  it('pins the counts of a fixed run', () => {
    const engine = new Engine(shop(), 4);
    play(engine, 5000);
    engine.injectFailure('pay', 'slow', { factor: 20 });
    play(engine, 10_000);
    const counts = engine.routes().map((x) => ({
      id: x.clientId,
      sent: x.totalRequests,
      ok: x.totalCompleted,
      failed: x.totalFailed,
    }));
    expect(counts).toMatchInlineSnapshot(`
      [
        {
          "failed": 392,
          "id": "checkout",
          "ok": 183,
          "sent": 590,
        },
        {
          "failed": 0,
          "id": "browse",
          "ok": 869,
          "sent": 871,
        },
      ]
    `);
  });

  it('splits a tally the same way', () => {
    const engine = new Engine(shop(), 2);
    play(engine, 3000);
    engine.startTally();
    engine.injectFailure('pay', 'slow', { factor: 20 });
    play(engine, 6000);
    engine.stopTally();
    const tally = engine.readTally();
    if (tally === null) throw new Error('no tally');
    const { checkout, browse } = tally.byRoute;
    expect(checkout.arrived + browse.arrived).toBe(tally.arrived);
    expect(checkout.completed + browse.completed).toBe(tally.completed);
    expect(checkout.failed + browse.failed).toBe(tally.failed);
    expect(browse.failed).toBe(0);
    expect(checkout.failuresByReason).toEqual({ timeout: checkout.failed });
    // Browsers never wait anywhere near their 300ms timeout.
    expect(Math.max(...browse.latencies)).toBeLessThan(50);
    // Each success is in exactly one route's list.
    const merged = [...checkout.latencies, ...browse.latencies].sort((a, b) => a - b);
    expect(merged).toEqual(Array.from(tally.latencies).sort((a, b) => a - b));
  });

  it('charts the slowed route apart from the healthy one', () => {
    const engine = new Engine(shop(), 4);
    play(engine, 5000);
    engine.injectFailure('pay', 'slow', { factor: 20 });
    play(engine, 10_000);
    const r = byId(engine.routes());
    const last = (x: RouteStats) => x.history[x.history.length - 1];
    expect(r.checkout.history.length).toBe(engine.snapshot().history.length);
    expect(last(r.checkout).errorRate).toBe(1);
    // Nothing succeeded, so there is no p99 to draw, not a p99 of 0.
    expect(last(r.checkout).p99).toBeNaN();
    expect(last(r.browse).errorRate).toBe(0);
    expect(last(r.browse).p99).toBe(15);
    expect(r.checkout.history.map((p) => p.t)).toEqual(
      r.browse.history.map((p) => p.t),
    );
  });

  it('is the same on the same seed', () => {
    const once = () => {
      const engine = new Engine(shop(), 9);
      play(engine, 2000);
      engine.injectFailure('pay', 'slow', { factor: 20 });
      play(engine, 4000);
      return JSON.stringify(engine.routes());
    };
    expect(once()).toBe(once());
  });

  it('leaves every snapshot byte for byte as it was', () => {
    for (const id of ['stripe', 'discord', 'uber', 'single-server']) {
      const topology = PRESETS.find((p) => p.id === id)?.topology;
      if (!topology) throw new Error(`no preset ${id}`);
      const plain = new Engine(topology, 1);
      const watched = new Engine(topology, 1);
      for (let s = 0; s < 8; s++) {
        play(plain, 500);
        play(watched, 500);
        watched.routes();
        expect(JSON.stringify(watched.snapshot()), id).toBe(
          JSON.stringify(plain.snapshot()),
        );
      }
    }
  });

  it('starts over on reset', () => {
    const engine = new Engine(shop(), 1);
    play(engine, 2000);
    engine.reset();
    for (const r of engine.routes()) {
      expect(r.totalRequests).toBe(0);
      expect(r.history).toEqual([]);
    }
  });
});
