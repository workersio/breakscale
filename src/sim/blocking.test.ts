import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { behaviourFor } from './behaviour';
import { Engine } from './engine';
import { PRESETS, defaultConfig } from './presets';
import type {
  FaultEvent,
  NodeConfig,
  NodeKind,
  NodeStats,
  SimEdge,
  SimNode,
  SimSnapshot,
  Topology,
} from './types';

/**
 * Blocking downstream calls.
 *
 * A thread-per-request server keeps its slot from the moment its work starts
 * until the request itself resolves, so a slow dependency fills the caller's
 * slots and the caller queues and sheds while its own work sits idle. Every
 * behaviour test prints the numbers it measured.
 */

function node(id: string, kind: NodeKind, patch: Partial<NodeConfig> = {}): SimNode {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...patch },
  };
}

function edge(from: string, to: string, patch: Partial<SimEdge> = {}): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1, ...patch };
}

/** A plain leaf with fixed timing: the slow dependency every test calls. */
function leaf(id: string, serviceMs: number, patch: Partial<NodeConfig> = {}): SimNode {
  return node(id, 'service', {
    capacity: 64,
    serviceMs,
    serviceCv: 0,
    queueLimit: 4096,
    ...patch,
  });
}

/** A caller with 8 slots and 5ms of fixed work of its own. */
function caller(id: string, patch: Partial<NodeConfig> = {}): SimNode {
  return node(id, 'service', {
    capacity: 8,
    serviceMs: 5,
    serviceCv: 0,
    queueLimit: 64,
    ...patch,
  });
}

function client(rps: number, timeoutMs = 0): SimNode {
  return node('client', 'client', { rps, timeoutMs });
}

/**
 * A snapshot the caller owns. The engine reuses its `nodes` record between
 * snapshots, so one kept across a later snapshot() would read the later run.
 */
function snap(engine: Engine): SimSnapshot {
  return structuredClone(engine.snapshot());
}

function run(engine: Engine, ms: number): SimSnapshot {
  const end = engine.now + ms;
  while (engine.now < end) engine.advance(50);
  return snap(engine);
}

/** Mean of `pick` over `ms`, sampled every 100ms. */
function mean(engine: Engine, ms: number, pick: (s: SimSnapshot) => number): number {
  const end = engine.now + ms;
  let sum = 0;
  let n = 0;
  while (engine.now < end) {
    engine.advance(50);
    engine.advance(50);
    sum += pick(engine.snapshot());
    n++;
  }
  return sum / n;
}

/**
 * Mean slots held at `id` against the mean rate requests arrive there, over
 * the same samples. By Little's law their ratio is how long each request held
 * its slot, which is the number these tests are about.
 */
function holdMs(
  engine: Engine,
  id: string,
  ms: number,
): { held: number; holdMs: number } {
  let held = 0;
  let rate = 0;
  const end = engine.now + ms;
  let n = 0;
  while (engine.now < end) {
    engine.advance(50);
    engine.advance(50);
    const s = engine.snapshot().nodes[id];
    held += s.inFlight + (s.waitingOnDownstream ?? 0);
    rate += s.arrivalRate;
    n++;
  }
  return { held: held / n, holdMs: rate > 0 ? (1000 * held) / rate : 0 };
}

function waiting(s: NodeStats): number {
  return s.waitingOnDownstream ?? 0;
}

/** Stop every client and let everything in flight finish. */
function drain(engine: Engine, t: Topology, ms = 30000): SimSnapshot {
  for (const n of t.nodes) {
    if (n.kind === 'client') engine.updateNodeConfig(n.id, { rps: 0 });
  }
  return run(engine, ms);
}

/**
 * Nothing is held anywhere and every root request was answered once. This is
 * the leak guard: a slot that is never released shows up here as a node that
 * stays occupied after its traffic is gone.
 */
function expectSettled(s: SimSnapshot, label: string): void {
  for (const [id, n] of Object.entries(s.nodes)) {
    expect(n.inFlight, `${label}: ${id} inFlight`).toBe(0);
    expect(waiting(n), `${label}: ${id} waitingOnDownstream`).toBe(0);
    expect(n.queued, `${label}: ${id} queued`).toBe(0);
    expect(n.runningNow ?? 0, `${label}: ${id} runningNow`).toBe(0);
    expect(n.bulkheadInFlight ?? 0, `${label}: ${id} bulkheadInFlight`).toBe(0);
  }
  const c = s.nodes.client;
  expect(c.totalCompleted + c.totalFailed, `${label}: roots answered`).toBe(
    s.system.totalRequests,
  );
}

function f(v: number, digits = 2): string {
  return v.toFixed(digits);
}

describe('blocking: a slow dependency backs up its caller', () => {
  it('fills the caller with parked threads while its work stays idle', () => {
    // 8 threads each held 5ms + 200ms is a ceiling of 39 a second, under the
    // 100 offered, although the caller's own work could serve 1600.
    const t: Topology = {
      nodes: [client(100), caller('api'), leaf('db', 200)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 5000);
    const w = mean(engine, 10000, (s) => waiting(s.nodes.api));
    const work = mean(engine, 10000, (s) => s.nodes.api.inFlight);
    const s = snap(engine);
    const api = s.nodes.api;
    console.log(
      `api: waiting on db ${f(w)}, working ${f(work)}, queued ${api.queued}, ` +
        `shed ${f(api.shedRate, 1)}/s, utilisation ${f(api.utilization, 3)}; ` +
        `db in service ${s.nodes.db.inFlight}`,
    );
    expect(w).toBeGreaterThanOrEqual(7);
    expect(work).toBeLessThanOrEqual(2);
    expect(api.queued).toBeGreaterThan(0);
    expect(api.shedRate).toBeGreaterThan(0);
    expect(api.utilization).toBeLessThan(0.2);
    // The database never sees more than the caller's 8 threads.
    expect(s.nodes.db.inFlight).toBeLessThanOrEqual(8);
  });

  it('turns a 6x slower database into errors at the API, not at the database', () => {
    const p = PRESETS.find((x) => x.id === 'single-server');
    if (!p) throw new Error('no single-server preset');
    const t = structuredClone(p.topology);
    // The preset's API runs a pool far larger than the database's, so pin the
    // 8 threads this test reasons about.
    const api = t.nodes.find((n) => n.id === 'api');
    if (!api) throw new Error('no api node');
    api.config.capacity = 8;
    const healthy = new Engine(t, 7);
    run(healthy, 20000);
    const before = snap(healthy);

    const engine = new Engine(t, 7);
    run(engine, 5000);
    engine.injectFailure('db', 'slow', { factor: 6 });
    run(engine, 10000);
    const w = mean(engine, 10000, (s) => waiting(s.nodes.api));
    const s = snap(engine);
    console.log(
      `single-server healthy: errors ${f(100 * before.system.errorRate)}%, p99 ` +
        `${f(before.system.p99, 0)}ms; db slow x6: errors ${f(100 * s.system.errorRate)}%, ` +
        `p99 ${f(s.system.p99, 0)}ms, api waiting ${f(w)} of 8, api queued ` +
        `${s.nodes.api.queued}, api shed ${f(s.nodes.api.shedRate, 1)}/s, db queued ` +
        `${s.nodes.db.queued}`,
    );
    expect(before.system.errorRate).toBe(0);
    expect(s.system.errorRate).toBeGreaterThan(0);
    // The errors are the API's: it turns work away, the database never does.
    expect(s.nodes.api.shedRate).toBeGreaterThan(0);
    expect(s.nodes.db.shedRate).toBe(0);
    expect(s.nodes.db.totalFailed).toBe(0);
    expect(w).toBeGreaterThanOrEqual(7);
    expect(s.nodes.api.queued).toBeGreaterThan(32);
    // 8 caller threads against 6 database slots: at most 2 can be in line.
    expect(s.nodes.db.queued).toBeLessThanOrEqual(2);
  });
});

describe('blocking: release on every outcome', () => {
  function timeoutTopology(retries: number): Topology {
    return {
      nodes: [client(20), caller('api', { timeoutMs: 50, retries }), leaf('db', 500)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
  }

  it('frees the slot at the deadline and counts it as one timeout', () => {
    const t = timeoutTopology(0);
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const { held, holdMs: ms } = holdMs(engine, 'api', 60000);
    const live = snap(engine);
    const s = drain(engine, t);
    const roots = s.system.totalRequests;
    console.log(
      `timeout 50ms: slots held ${f(held)}, each for ${f(ms, 1)}ms (5ms of work and the ` +
        `50ms deadline), api timeouts ${f(live.nodes.api.timeoutRate, 1)}/s, roots ${roots}, ` +
        `failed ${s.system.totalFailed}, ` +
        `by timeout ${s.failuresByReason.timeout}, api failed ${s.nodes.api.totalFailed}, ` +
        `db served ${s.nodes.db.totalCompleted}`,
    );
    expect(ms).toBeGreaterThan(50);
    expect(ms).toBeLessThan(62);
    expect(s.system.totalFailed).toBe(roots);
    expect(s.failuresByReason.timeout).toBe(roots);
    // Booked once at the join and once at the root, not once per hop.
    expect(s.nodes.api.totalFailed).toBe(roots);
    expect(s.nodes.client.totalFailed).toBe(roots);
    // The callee is not cancelled: every abandoned call still ran.
    expect(s.nodes.db.totalCompleted).toBe(roots);
    expectSettled(s, 'timeout');
  });

  it('holds the slot through retries and their backoff, and books the failure once', () => {
    const t = timeoutTopology(2);
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const { held, holdMs: ms } = holdMs(engine, 'api', 60000);
    const arrivals = mean(engine, 30000, (s) => s.nodes.api.arrivalRate);
    const timeouts = mean(engine, 30000, (s) => s.nodes.api.timeoutRate);
    const s = drain(engine, t);
    const roots = s.system.totalRequests;
    // 5ms of work, three 50ms attempts and a mean backoff of 25 + 50 ms is
    // 230ms. Without the backoff it would be 155ms.
    console.log(
      `timeout 50ms x3: slots held ${f(held)}, each for ${f(ms, 1)}ms, api timeouts ` +
        `${f(timeouts, 1)}/s against ${f(arrivals, 1)} arrivals/s, roots ${roots}, ` +
        `by timeout ${s.failuresByReason.timeout}, api failed ${s.nodes.api.totalFailed}, ` +
        `db served ${s.nodes.db.totalCompleted}`,
    );
    expect(ms).toBeGreaterThan(200);
    expect(ms).toBeLessThan(260);
    // Three attempts per call, each timing out at the caller.
    expect(timeouts / arrivals).toBeGreaterThan(2.6);
    expect(timeouts / arrivals).toBeLessThan(3.4);
    expect(s.failuresByReason.timeout).toBe(roots);
    expect(s.nodes.api.totalFailed).toBe(roots);
    expect(s.nodes.db.totalCompleted).toBe(3 * roots);
    expectSettled(s, 'retries');
  });

  it('releases on success and on the error roll', () => {
    const t: Topology = {
      nodes: [client(50), caller('api', { errorRate: 0.3 }), leaf('db', 20)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 10000);
    const s = drain(engine, t);
    console.log(
      `error roll 0.3: roots ${s.system.totalRequests}, ok ${s.nodes.client.totalCompleted}, ` +
        `error ${s.failuresByReason.error}`,
    );
    expect(s.failuresByReason.error).toBeGreaterThan(0);
    expect(s.nodes.client.totalCompleted).toBeGreaterThan(0);
    expectSettled(s, 'success and error');
  });
});

describe('blocking: fan-out waits for every call', () => {
  function fanOut(fast: Partial<NodeConfig>, api: Partial<NodeConfig> = {}): Topology {
    return {
      nodes: [client(10), caller('api', api), leaf('fast', 5, fast), leaf('slow', 200)],
      edges: [edge('client', 'api'), edge('api', 'fast'), edge('api', 'slow')],
    };
  }

  it('holds the slot until the slowest call answers', () => {
    const engine = new Engine(fanOut({}), 7);
    run(engine, 3000);
    const { held, holdMs: ms } = holdMs(engine, 'api', 10000);
    const s = snap(engine);
    console.log(
      `fan-out: client p50 ${f(s.system.p50, 1)}ms, slots held ${f(held)}, each for ` +
        `${f(ms, 1)}ms (5ms of work, then the 200ms call)`,
    );
    expect(s.system.p50).toBeGreaterThanOrEqual(205);
    expect(ms).toBeGreaterThan(190);
    expect(ms).toBeLessThan(220);
  });

  it('fails with the first failure, but only once the slow call is back', () => {
    const t = fanOut({ errorRate: 1 });
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const { holdMs: ms } = holdMs(engine, 'api', 10000);
    let trace = snap(engine).trace;
    for (let i = 0; i < 40 && (trace === null || trace.ok); i++) {
      engine.advance(50);
      trace = snap(engine).trace;
    }
    const s = drain(engine, t);
    console.log(
      `fan-out, fast call fails: reason ${trace?.reason}, traced total ${f(trace?.totalMs ?? 0, 1)}ms, ` +
        `each slot held ${f(ms, 1)}ms, error ${s.failuresByReason.error} of ${s.system.totalRequests}`,
    );
    expect(trace?.ok).toBe(false);
    expect(trace?.reason).toBe('error');
    expect(trace?.totalMs ?? 0).toBeGreaterThanOrEqual(205);
    expect(ms).toBeGreaterThan(190);
    expect(s.failuresByReason.error).toBe(s.system.totalRequests);
    expectSettled(s, 'fan-out error');
  });

  it('reports a timeout on one call as the reason, with both calls accounted for', () => {
    const t = fanOut({}, { timeoutMs: 100 });
    const engine = new Engine(t, 7);
    run(engine, 5000);
    const s = drain(engine, t);
    const roots = s.system.totalRequests;
    console.log(
      `fan-out, slow call times out: roots ${roots}, by timeout ${s.failuresByReason.timeout}, ` +
        `fast served ${s.nodes.fast.totalCompleted}, slow served ${s.nodes.slow.totalCompleted}`,
    );
    expect(s.failuresByReason.timeout).toBe(roots);
    expect(s.nodes.fast.totalCompleted).toBe(roots);
    expect(s.nodes.slow.totalCompleted).toBe(roots);
    expectSettled(s, 'fan-out timeout');
  });
});

describe('blocking: an asynchronous boundary shields the producer', () => {
  const cases: [string, SimNode[], SimEdge[], (s: SimSnapshot) => number][] = [
    [
      'queue',
      [
        node('q', 'queue'),
        node('w', 'worker', { capacity: 4, serviceMs: 5, serviceCv: 0 }),
      ],
      [edge('api', 'q'), edge('q', 'w'), edge('w', 'store')],
      (s) => s.nodes.q.queued,
    ],
    [
      'streambroker',
      [node('q', 'streambroker'), caller('w')],
      [edge('api', 'q'), edge('q', 'w'), edge('w', 'store')],
      (s) => s.nodes.q.queued,
    ],
    [
      'pubsub',
      [node('q', 'pubsub'), caller('w')],
      [edge('api', 'q'), edge('q', 'w'), edge('w', 'store')],
      (s) => s.nodes.w.queued + s.nodes.w.shedRate,
    ],
    [
      'retryqueue',
      [node('q', 'retryqueue'), caller('w')],
      [edge('api', 'q'), edge('q', 'w'), edge('w', 'store')],
      (s) => s.nodes.w.queued + s.nodes.q.queued,
    ],
    [
      'writebehind',
      [node('q', 'writebehind', { capacity: 16 })],
      [edge('api', 'q'), edge('q', 'store')],
      (s) => s.nodes.q.dirtyWrites ?? 0,
    ],
  ];

  it.each(cases)('%s', (name, middle, edges, backlog) => {
    const t: Topology = {
      nodes: [
        client(50),
        caller('api'),
        ...middle,
        leaf('store', 500, { capacity: 4 }),
      ],
      edges: [edge('client', 'api'), ...edges],
    };
    const engine = new Engine(t, 7);
    run(engine, 5000);
    const held = mean(engine, 5000, (s) => waiting(s.nodes.api));
    const s = snap(engine);
    const consumer = s.nodes.w;
    console.log(
      `${name}: producer p50 ${f(s.nodes.api.p50, 1)}ms, producer waiting ${f(held, 3)}, ` +
        `errors ${f(100 * s.system.errorRate)}%, backlog ${f(backlog(s), 1)}` +
        (consumer
          ? `, consumer waiting ${waiting(consumer)} of ${consumer.inFlight + waiting(consumer)}`
          : ''),
    );
    // The producer waits for an ack, not for the 500ms store behind it.
    expect(s.nodes.api.p50).toBeLessThan(15);
    expect(held).toBeLessThan(0.5);
    expect(s.system.errorRate).toBe(0);
    // And the backlog shows up behind the boundary instead.
    expect(backlog(s)).toBeGreaterThan(0);
  });

  it('a worker blocked on its store drains at its own concurrency', () => {
    const t: Topology = {
      nodes: [
        client(50),
        caller('api'),
        node('q', 'queue'),
        node('w', 'worker', { capacity: 4, serviceMs: 5, serviceCv: 0 }),
        leaf('store', 500),
      ],
      edges: [
        edge('client', 'api'),
        edge('api', 'q'),
        edge('q', 'w'),
        edge('w', 'store'),
      ],
    };
    const engine = new Engine(t, 7);
    run(engine, 5000);
    const w = mean(engine, 5000, (s) => waiting(s.nodes.w));
    const drainRate = mean(engine, 5000, (s) => s.nodes.w.throughput);
    console.log(
      `worker: waiting ${f(w)} of 4, draining ${f(drainRate, 1)}/s (4 / 505ms is 7.9)`,
    );
    expect(w).toBeGreaterThan(3.5);
    expect(drainRate).toBeGreaterThan(6);
    expect(drainRate).toBeLessThan(9.5);
  });
});

describe('blocking: a cache hit answers without the wait', () => {
  function cached(hitRate: number): Topology {
    return {
      nodes: [
        client(20),
        caller('api'),
        node('cache', 'cache', { hitRate, serviceMs: 3, serviceCv: 0 }),
        leaf('db', 300),
      ],
      edges: [edge('client', 'api'), edge('api', 'cache'), edge('cache', 'db')],
    };
  }

  it('a hit never reaches the database and holds the caller for the lookup only', () => {
    const engine = new Engine(cached(1), 7);
    run(engine, 3000);
    const { holdMs: ms } = holdMs(engine, 'api', 10000);
    const s = snap(engine);
    console.log(
      `hit rate 1: db arrivals ${s.nodes.db.arrivalRate}/s, client p50 ${f(s.system.p50, 1)}ms, ` +
        `each api slot held ${f(ms, 1)}ms (5ms of work, 3ms lookup)`,
    );
    expect(s.nodes.db.arrivalRate).toBe(0);
    expect(s.nodes.db.totalCompleted).toBe(0);
    expect(s.system.p50).toBeLessThan(10);
    expect(ms).toBeLessThan(10);
  });

  it('a miss holds the caller for the database, while the cache holds only its lookup', () => {
    const engine = new Engine(cached(0), 7);
    run(engine, 3000);
    const { holdMs: ms } = holdMs(engine, 'api', 10000);
    const cacheBusy = mean(engine, 5000, (s) => s.nodes.cache.inFlight);
    const s = snap(engine);
    console.log(
      `hit rate 0: client p50 ${f(s.system.p50, 1)}ms, each api slot held ${f(ms, 1)}ms ` +
        `(5ms, 3ms, then the 300ms database), cache in service ${f(cacheBusy, 3)}`,
    );
    expect(s.system.p50).toBeGreaterThanOrEqual(308);
    expect(ms).toBeGreaterThan(290);
    expect(cacheBusy).toBeLessThan(0.3);
    expect(s.nodes.cache.waitingOnDownstream).toBeUndefined();
  });
});

describe('blocking: a bulkhead does not hold twice', () => {
  it('its pool is the hold, and the caller parks its own threads', () => {
    const t: Topology = {
      nodes: [
        client(30),
        caller('api', { capacity: 16 }),
        node('bh', 'bulkhead', { bulkheadMax: 4 }),
        leaf('db', 200),
      ],
      edges: [edge('client', 'api'), edge('api', 'bh'), edge('bh', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 3000);
    let pool = 0;
    let dbHeld = 0;
    let apiWaiting = 0;
    let n = 0;
    for (let i = 0; i < 50; i++) {
      engine.advance(100);
      const s = snap(engine);
      pool += s.nodes.bh.bulkheadInFlight ?? 0;
      dbHeld += s.nodes.db.inFlight + s.nodes.db.queued;
      apiWaiting += waiting(s.nodes.api);
      n++;
      // The pool counts exactly the calls outstanding behind it.
      expect(s.nodes.bh.bulkheadInFlight).toBe(s.nodes.db.inFlight + s.nodes.db.queued);
      expect(s.nodes.bh.waitingOnDownstream).toBeUndefined();
      // Every call the pool holds has an API thread parked behind it.
      expect(waiting(s.nodes.api)).toBeGreaterThanOrEqual(
        s.nodes.bh.bulkheadInFlight ?? 0,
      );
    }
    const s = snap(engine);
    console.log(
      `bulkhead 4: pool ${f(pool / n)}, db held ${f(dbHeld / n)}, api waiting ${f(apiWaiting / n)}, ` +
        `rejected ${f(s.nodes.bh.bulkheadRejectedRate ?? 0, 1)}/s`,
    );
    expect(pool / n).toBeLessThanOrEqual(4);
    expect(pool / n).toBeGreaterThan(3);
    expect(apiWaiting / n).toBeGreaterThan(3);
    expect(s.nodes.bh.bulkheadRejectedRate ?? 0).toBeGreaterThan(0);
  });
});

describe('blocking: which kinds hold a slot across a call', () => {
  const EXPECTED: Record<NodeKind, boolean> = {
    client: false,
    lb: false,
    service: true,
    cache: false,
    db: false,
    queue: false,
    worker: true,
    autoscaler: false,
    region: false,
    cdn: false,
    ratelimiter: false,
    breaker: false,
    replica: false,
    shard: false,
    objectstore: false,
    searchindex: false,
    timeseriesdb: false,
    graphdb: false,
    coldstorage: false,
    vectordb: false,
    streambroker: false,
    pubsub: false,
    websocket: false,
    apigateway: false,
    sidecar: false,
    lambda: true,
    cron: false,
    bulkhead: false,
    retryqueue: false,
    transcoder: false,
    edgecompute: false,
    writebehind: false,
    loadshedder: false,
  };

  it.each(Object.entries(EXPECTED))('%s blocks: %s', (kind, blocks) => {
    // Changing one of these is a modelling decision; make it on purpose.
    const b = behaviourFor(kind as NodeKind);
    expect(b.kind).toBe(kind);
    expect(b.blocksOnDownstream).toBe(blocks);
  });

  it.each(['lb', 'apigateway', 'sidecar', 'cdn'] as const)(
    '%s in front of a slow service holds nothing across the call',
    (kind) => {
      // Two slots: a front that held one across the 300ms call would need
      // about six at this load, so it would queue and turn work away.
      const front = node('front', kind, {
        capacity: 2,
        queueLimit: 4,
        ...(kind === 'cdn' ? { hitRate: 0 } : {}),
      });
      const t: Topology = {
        nodes: [client(20), front, caller('api'), leaf('db', 300)],
        edges: [edge('client', 'front'), edge('front', 'api'), edge('api', 'db')],
      };
      const engine = new Engine(t, 7);
      run(engine, 3000);
      const s = snap(engine);
      console.log(
        `${kind}: inFlight ${s.nodes.front.inFlight}, queued ${s.nodes.front.queued}, ` +
          `failed ${s.nodes.front.totalFailed}, api waiting ${waiting(s.nodes.api)}`,
      );
      expect(s.nodes.front.waitingOnDownstream).toBeUndefined();
      expect(s.nodes.front.queued).toBe(0);
      expect(s.nodes.front.totalFailed).toBe(0);
      expect(s.system.totalFailed).toBe(0);
      expect(waiting(s.nodes.api)).toBeGreaterThan(4);
    },
  );

  it('a blocking leaf publishes no waiting count, because it can never wait', () => {
    const t: Topology = {
      nodes: [client(20), caller('api')],
      edges: [edge('client', 'api')],
    };
    const s = run(new Engine(t, 7), 2000);
    expect(s.nodes.api.waitingOnDownstream).toBeUndefined();
  });
});

describe('blocking: no slot outlives its request', () => {
  it('a cut cable mid-wait', () => {
    const t: Topology = {
      nodes: [
        client(40),
        caller('api', { timeoutMs: 400, retries: 1 }),
        leaf('db', 150),
      ],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 3000);
    engine.cutEdge('api->db');
    const cut = run(engine, 2000);
    engine.restoreEdge('api->db');
    run(engine, 3000);
    const s = drain(engine, t);
    console.log(
      `cut: partitioned ${s.failuresByReason.partitioned}, api waiting during the cut ` +
        `${waiting(cut.nodes.api)}`,
    );
    expect(s.failuresByReason.partitioned).toBeGreaterThan(0);
    expectSettled(s, 'cut');
  });

  it('a crash mid-wait fails the parked work as crashed, even when healed before the answer', () => {
    const t: Topology = {
      nodes: [client(40), caller('api'), leaf('db', 400)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const before = snap(engine);
    const parked = waiting(before.nodes.api);
    engine.injectFailure('api', 'crash');
    // The crashed process's threads are gone at once.
    const crashed = snap(engine);
    // Healed long before the 400ms database answers anyone.
    engine.advance(20);
    engine.clearFailure('api');
    const s = drain(engine, t);
    console.log(
      `crash: ${parked} parked at the crash, ${waiting(crashed.nodes.api)} after it, ` +
        `crashed ${s.failuresByReason.crashed}, roots ${s.system.totalRequests}`,
    );
    expect(parked).toBeGreaterThan(4);
    expect(waiting(crashed.nodes.api)).toBe(0);
    // The crash fails what was in line and in service at once; the parked
    // threads fail on top of those, when the database answers them after the
    // heal. Were a lost thread to succeed instead, only the first two would
    // be here. The 20ms of downtime itself turns away at most one arrival.
    const atOnce = before.nodes.api.queued + before.nodes.api.inFlight;
    expect(s.failuresByReason.crashed).toBeGreaterThanOrEqual(atOnce + parked);
    expect(s.failuresByReason.crashed).toBeLessThanOrEqual(atOnce + parked + 1);
    expectSettled(s, 'crash');
  });

  it('a crashed thread inside its retry loop makes no more calls', () => {
    const t: Topology = {
      nodes: [
        client(40),
        caller('api', { timeoutMs: 100, retries: 3 }),
        leaf('db', 400),
      ],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const atCrash = snap(engine);
    const parked = waiting(atCrash.nodes.api);
    // Every call the database has taken so far, finished or not.
    const taken = (n: NodeStats): number => n.totalCompleted + n.inFlight + n.queued;
    const sentBefore = taken(atCrash.nodes.db);
    engine.injectFailure('api', 'crash');
    // Long enough for every lost thread's pending call to time out, but the
    // crash stays, so nothing new is admitted to make calls of its own.
    run(engine, 2000);
    const s = snap(engine);
    engine.clearFailure('api');
    const settled = drain(engine, t);
    // Calls already at the database when it crashed still finish there; a
    // retry from a dead thread would be a new one on top.
    const calls = taken(s.nodes.db) - sentBefore;
    console.log(
      `crash in a retry loop: ${parked} parked at the crash, db calls after it ${calls}, ` +
        `crashed ${settled.failuresByReason.crashed}`,
    );
    expect(parked).toBeGreaterThan(4);
    expect(calls).toBe(0);
    expectSettled(settled, 'crash in retry loop');
  });

  it('a database deleted with work in service, in transit and in its own line', () => {
    const t: Topology = {
      nodes: [
        client(200),
        caller('api', { capacity: 32, queueLimit: 256 }),
        node('db', 'db', { capacity: 2, serviceMs: 80, queueLimit: 64 }),
      ],
      edges: [edge('client', 'api'), edge('api', 'db', { latencyMs: 20 })],
    };
    const engine = new Engine(t, 7);
    run(engine, 2000);
    const live = snap(engine);
    engine.setTopology({
      nodes: t.nodes.filter((n) => n.id !== 'db'),
      edges: t.edges.filter((e) => e.to !== 'db'),
    });
    const after = snap(engine);
    const s = drain(engine, { nodes: t.nodes, edges: [] });
    console.log(
      `delete db: db held ${live.nodes.db.inFlight} in service and ${live.nodes.db.queued} ` +
        `in line, api waiting ${waiting(live.nodes.api)} before, ` +
        `${after.nodes.api.waitingOnDownstream ?? 'none'} after; no-route ${s.failuresByReason['no-route']}`,
    );
    expect(live.nodes.db.inFlight).toBeGreaterThan(0);
    expect(live.nodes.db.queued).toBeGreaterThan(0);
    // More threads wait than the database holds: the rest are on the wire.
    const inTransit =
      waiting(live.nodes.api) - live.nodes.db.inFlight - live.nodes.db.queued;
    expect(inTransit).toBeGreaterThan(0);
    // Every one of them answers its parked caller as no-route.
    expect(s.failuresByReason['no-route']).toBeGreaterThanOrEqual(
      waiting(live.nodes.api),
    );
    expectSettled(s, 'delete');
  });

  it('a queue and the store its workers wait on, deleted together', () => {
    // Failing the store's work frees a worker thread, and a freed worker pulls
    // its next message from the queue. Both are gone in the same edit, so
    // neither may take or start anything on the way out.
    const t: Topology = {
      nodes: [
        client(200),
        node('q', 'queue'),
        node('w', 'worker', { capacity: 4 }),
        leaf('db', 300, { capacity: 2 }),
      ],
      edges: [edge('client', 'q'), edge('q', 'w'), edge('w', 'db')],
    };
    const engine = new Engine(t, 7);
    const live = run(engine, 2000);
    const keep = new Set(['client', 'w']);
    const rest: Topology = {
      nodes: t.nodes.filter((n) => keep.has(n.id)),
      edges: t.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
    engine.setTopology(rest);
    const s = drain(engine, rest);
    console.log(
      `delete queue and store: q depth ${live.nodes.q.queued}, w waiting ` +
        `${waiting(live.nodes.w)}, db queued ${live.nodes.db.queued}`,
    );
    expect(live.nodes.q.queued).toBeGreaterThan(0);
    expect(waiting(live.nodes.w)).toBe(4);
    expect(live.nodes.db.queued).toBeGreaterThan(0);
    expectSettled(s, 'delete queue and store');
  });

  it('a node retyped mid-wait', () => {
    const t: Topology = {
      nodes: [client(40), caller('api'), leaf('db', 300)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 2000);
    const live = snap(engine);
    engine.setTopology({
      nodes: t.nodes.map((n) => (n.id === 'api' ? { ...n, kind: 'lb' as const } : n)),
      edges: t.edges,
    });
    const s = drain(engine, t);
    console.log(
      `retype mid-wait: api waiting ${waiting(live.nodes.api)}, no-route ` +
        `${s.failuresByReason['no-route']}`,
    );
    // The old process's parked threads are gone with it.
    expect(waiting(live.nodes.api)).toBeGreaterThan(4);
    expect(s.failuresByReason['no-route']).toBeGreaterThanOrEqual(
      waiting(live.nodes.api),
    );
    expectSettled(s, 'retype');
  });

  it('a node retyped mid-service', () => {
    // 200ms of the API's own work, so the retype lands with service in
    // progress. That work belonged to the old process: it answers no-route
    // rather than finishing on the new one.
    const t: Topology = {
      nodes: [client(30), caller('api', { serviceMs: 200 }), leaf('db', 20)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 2000);
    const live = snap(engine);
    engine.setTopology({
      nodes: t.nodes.map((n) => (n.id === 'api' ? { ...n, kind: 'lb' as const } : n)),
      edges: t.edges,
    });
    const s = drain(engine, t);
    const lost =
      live.nodes.api.inFlight + waiting(live.nodes.api) + live.nodes.api.queued;
    console.log(
      `retype mid-service: api in service ${live.nodes.api.inFlight}, waiting ` +
        `${waiting(live.nodes.api)}, queued ${live.nodes.api.queued}, no-route ` +
        `${s.failuresByReason['no-route']}`,
    );
    expect(live.nodes.api.inFlight).toBeGreaterThan(2);
    expect(s.failuresByReason['no-route']).toBe(lost);
    expectSettled(s, 'retype mid-service');
  });

  it('a reset', () => {
    const t: Topology = {
      nodes: [client(100), caller('api'), leaf('db', 300)],
      edges: [edge('client', 'api'), edge('api', 'db')],
    };
    const engine = new Engine(t, 7);
    const first = run(engine, 4000);
    engine.reset();
    const again = run(engine, 4000);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expectSettled(drain(engine, t), 'reset');
  });

  it('a lambda waiting on a slow database throttles, then gives every slot back', () => {
    const t: Topology = {
      nodes: [
        client(200),
        node('fn', 'lambda', { maxConcurrency: 10 }),
        leaf('db', 300),
      ],
      edges: [edge('client', 'fn'), edge('fn', 'db')],
    };
    const engine = new Engine(t, 7);
    run(engine, 3000);
    const running = mean(engine, 5000, (s) => s.nodes.fn.runningNow ?? 0);
    const s1 = snap(engine);
    const s = drain(engine, t);
    console.log(
      `lambda: running ${f(running)} of 10, waiting ${waiting(s1.nodes.fn)}, inFlight ` +
        `${s1.nodes.fn.inFlight}, utilisation ${f(s1.nodes.fn.utilization)}, throttled ` +
        `${f(s1.nodes.fn.throttledRate ?? 0, 1)}/s`,
    );
    expect(running).toBeGreaterThan(9);
    expect(s1.nodes.fn.throttledRate ?? 0).toBeGreaterThan(0);
    expect(s1.nodes.fn.inFlight + waiting(s1.nodes.fn)).toBe(s1.nodes.fn.runningNow);
    expect(s1.nodes.fn.utilization).toBeGreaterThan(0.8);
    expectSettled(s, 'lambda');
  });

  it('a cycle between two blocking services fails as depth instead of deadlocking', () => {
    const t: Topology = {
      nodes: [client(50, 2000), caller('a'), caller('b')],
      edges: [edge('client', 'a'), edge('a', 'b'), edge('b', 'a')],
    };
    const engine = new Engine(t, 7);
    const s1 = run(engine, 10000);
    const s = drain(engine, t);
    console.log(
      `cycle: roots ${s.system.totalRequests}, depth ${s.failuresByReason.depth}, ` +
        `timeouts ${s.failuresByReason.timeout}, a queued at 10s ${s1.nodes.a.queued}`,
    );
    expect(s.failuresByReason.depth).toBe(s.system.totalRequests);
    expectSettled(s, 'cycle');
  });

  it.each([100, 400])(
    'a cycle with two ways in drains at %i rps instead of deadlocking',
    (rps) => {
      // A chain that entered at a waits on b's line while one that entered at
      // b waits on a's. Neither chain has been to the other node, so only a
      // guard that knows the whole cycle can see the loop they form.
      const t: Topology = {
        nodes: [client(rps, 1000), caller('a'), caller('b')],
        edges: [
          edge('client', 'a'),
          edge('client', 'b'),
          edge('a', 'b'),
          edge('b', 'a'),
        ],
      };
      const engine = new Engine(t, 7);
      const s1 = run(engine, 20000);
      const s = drain(engine, t, 120000);
      console.log(
        `two-entry cycle at ${rps}: a held ${s1.nodes.a.inFlight + waiting(s1.nodes.a)}, ` +
          `queued ${s1.nodes.a.queued}; depth ${s.failuresByReason.depth}, shed ` +
          `${s.failuresByReason.shed}`,
      );
      expectSettled(s, `two-entry cycle at ${rps}`);
    },
  );

  it('a loop with a way out still succeeds while the node it re-enters has slots', () => {
    // A quarter of the balancer's calls go back into a. With slots free that
    // re-entry is served, as it always was, and the loop ends at b.
    const t: Topology = {
      nodes: [
        client(50),
        caller('a', { capacity: 32 }),
        node('lb', 'lb'),
        caller('b', { capacity: 32 }),
      ],
      edges: [
        edge('client', 'a'),
        edge('a', 'lb'),
        edge('lb', 'a', { weight: 1 }),
        edge('lb', 'b', { weight: 3 }),
      ],
    };
    const engine = new Engine(t, 7);
    const s = run(engine, 20000);
    console.log(
      `lb loop: roots ${s.system.totalRequests}, failed ${s.system.totalFailed}, ` +
        `a waiting ${waiting(s.nodes.a)}`,
    );
    expect(s.system.totalRequests).toBeGreaterThan(900);
    expect(s.system.totalFailed).toBe(0);
    expectSettled(drain(engine, t), 'lb loop');
  });

  it.each(['worker', 'transcoder'] as const)(
    'a call wired straight into a %s is served from its own line',
    (kind) => {
      // No queue in between: the call waits in the consumer's own line, and
      // the caller holds a slot for it until it is served.
      const t: Topology = {
        nodes: [
          client(20),
          caller('api', { capacity: 4 }),
          node('c', kind),
          leaf('db', 20),
        ],
        edges: [edge('client', 'api'), edge('api', 'c'), edge('c', 'db')],
      };
      const engine = new Engine(t, 7);
      const live = run(engine, 20000);
      const s = drain(engine, t, 600000);
      console.log(
        `api -> ${kind}: api waiting ${waiting(live.nodes.api)}, ${kind} queued ` +
          `${live.nodes.c.queued}, ok ${s.nodes.client.totalCompleted} of ${s.system.totalRequests}`,
      );
      expect(s.nodes.client.totalCompleted).toBeGreaterThan(0);
      expectSettled(s, `api -> ${kind}`);
    },
  );
});

describe('blocking: determinism', () => {
  const t: Topology = {
    nodes: [
      client(120, 1500),
      caller('api', { timeoutMs: 300, retries: 2 }),
      node('db', 'db'),
      node('q', 'queue'),
      node('w', 'worker'),
      leaf('store', 120),
    ],
    edges: [
      edge('client', 'api'),
      edge('api', 'db'),
      edge('api', 'q'),
      edge('q', 'w'),
      edge('w', 'store'),
    ],
    faults: [
      {
        atMs: 1234.5,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 6 },
      },
      { atMs: 2000, action: 'inject', nodeId: 'w', kind: 'crash' },
      { atMs: 2400, action: 'cut', edgeId: 'api->q' },
      { atMs: 2600, action: 'clear', nodeId: 'w' },
      { atMs: 3017, action: 'restore', edgeId: 'api->q' },
      { atMs: 3500, action: 'clear', nodeId: 'db' },
    ] satisfies FaultEvent[],
  };

  const FRAME_SAMPLED = new Set([
    'utilization',
    'perInstance',
    'maxShardUtilization',
    'minShardUtilization',
    'shardUtilization',
    'history',
  ]);
  const eventDriven = (s: SimSnapshot): string =>
    JSON.stringify(s, (k, v: unknown) => (FRAME_SAMPLED.has(k) ? undefined : v));

  function sampled(plan: readonly number[], serialise = eventDriven): string[] {
    const engine = new Engine(t, 11);
    const out: string[] = [];
    for (let w = 0; w < 15; w++) {
      for (const step of plan) engine.advance(step);
      out.push(serialise(engine.snapshot()));
    }
    return out;
  }

  it('the same seed gives byte-identical snapshots', () => {
    const plan = Array.from({ length: 25 }, () => 16);
    expect(sampled(plan, JSON.stringify)).toEqual(sampled(plan, JSON.stringify));
  });

  it('a design with no blocking caller runs byte for byte as it did before', () => {
    // Every kind that hands its work on, and a blocking service with nothing
    // to call, so nothing here can park. The hash was recorded on origin/main
    // f3ca2dd, the engine before blocking calls existed, with the same method
    // as the preset goldens in faults.test.ts: the 10Hz snapshots over ten
    // seconds at 60fps. Seed 42 because it reproduces the x86-64 bytes on an
    // arm64 Mac too (see the note on those goldens).
    const plain: Topology = {
      nodes: [
        node('web', 'client', { rps: 300, timeoutMs: 2000 }),
        node('lb', 'lb'),
        node('leaf', 'service'),
        node('cache', 'cache', { hitRate: 0.5 }),
        node('db', 'db'),
        node('mobile', 'client', { rps: 150 }),
        node('gw', 'apigateway'),
        node('breaker', 'breaker'),
        node('pool', 'bulkhead'),
        node('flaky', 'db', { errorRate: 0.1 }),
        node('viewer', 'client', { rps: 200 }),
        node('cdn', 'cdn', { hitRate: 0.3 }),
        node('mesh', 'sidecar'),
        node('copy', 'replica'),
        node('jobs', 'client', { rps: 150 }),
        node('q', 'queue'),
        node('worker', 'worker'),
      ],
      edges: [
        edge('web', 'lb'),
        edge('lb', 'leaf'),
        edge('lb', 'cache'),
        edge('cache', 'db'),
        edge('mobile', 'gw'),
        edge('gw', 'breaker'),
        edge('breaker', 'pool'),
        edge('pool', 'flaky'),
        edge('viewer', 'cdn'),
        edge('cdn', 'mesh'),
        edge('mesh', 'copy'),
        edge('jobs', 'q'),
        edge('q', 'worker'),
      ],
    };
    const engine = new Engine(plain, 42);
    const h = createHash('sha256');
    for (let i = 1; i <= 600; i++) {
      engine.advance(1000 / 60);
      if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
    }
    expect(h.digest('hex')).toBe(
      'eec06221d64feb2417469e6eebf4a4c0b77976608b2edc795f0569821ddcba97',
    );
  });

  it('gives identical snapshots however advance() is chunked', () => {
    const reference = sampled([100, 100, 100, 100]);
    for (const plan of [
      Array.from({ length: 25 }, () => 16),
      Array.from({ length: 8 }, () => 50),
      [7, 33, 100, 60, 100, 100],
    ]) {
      expect(sampled(plan)).toEqual(reference);
    }
  });
});
