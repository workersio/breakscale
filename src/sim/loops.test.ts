import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine, MAX_HOP_DEPTH, MAX_LOOP_CALLS } from './engine';
import { defaultConfig } from './presets';
import type {
  NodeConfig,
  NodeKind,
  SimEdge,
  SimNode,
  SimSnapshot,
  Topology,
} from './types';

/**
 * Loops that fan out (#128) and loops through a topic (#129).
 *
 * The hop ceiling bounds how deep a request goes, not how wide it spreads: a
 * loop with two ways back doubled the calls on every lap, all inside one
 * arrival event, and a topic restarted every lap at hop 0. Each case here
 * froze the page before the fix. Calls are counted through `sendChild`, and
 * the count is capped so a regression fails instead of hanging the run.
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

function edges(pairs: readonly (readonly [string, string])[]): SimEdge[] {
  return pairs.map(([from, to], i) => ({ id: `e${i}`, from, to, weight: 1 }));
}

/** Calls past this many in one run mean the loop is not bounded. */
const RUNAWAY = 2_000_000;

let calls = 0;
function countCalls(): void {
  calls = 0;
  const proto = Engine.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const send = proto.sendChild as (...a: unknown[]) => unknown;
  vi.spyOn(proto, 'sendChild').mockImplementation(function (this: unknown, ...a) {
    if (++calls > RUNAWAY) throw new Error(`runaway: over ${RUNAWAY} calls`);
    return send.apply(this, a);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

function run(t: Topology, ms: number): SimSnapshot {
  const engine = new Engine(t, 1);
  for (let i = 0; i < Math.round(ms / (1000 / 60)); i++) engine.advance(1000 / 60);
  return engine.snapshot();
}

function reasonSum(s: SimSnapshot): number {
  return Object.values(s.failuresByReason).reduce((a, b) => a + b, 0);
}

const SELF_TWICE: Topology = {
  nodes: [node('n0', 'client', { rps: 1 })],
  edges: edges([
    ['n0', 'n0'],
    ['n0', 'n0'],
  ]),
};

const DIAMOND: Topology = {
  nodes: [
    node('a', 'client', { rps: 1 }),
    node('b', 'client', { rps: 0 }),
    node('c', 'client', { rps: 0 }),
  ],
  edges: edges([
    ['a', 'b'],
    ['b', 'a'],
    ['a', 'c'],
    ['c', 'a'],
  ]),
};

const FOUR: Topology = {
  nodes: [...DIAMOND.nodes, node('d', 'client', { rps: 0 })],
  edges: edges([
    ['a', 'b'],
    ['b', 'a'],
    ['a', 'c'],
    ['c', 'a'],
    ['a', 'd'],
    ['d', 'a'],
  ]),
};

const TOPIC_LOOP: Topology = {
  nodes: [node('n0', 'client', { rps: 1159 }), node('n1', 'pubsub')],
  edges: edges([
    ['n0', 'n1'],
    ['n1', 'n0'],
  ]),
};

const TOPIC_FANOUT: Topology = {
  nodes: [
    node('n0', 'client', { rps: 1159 }),
    node('n1', 'pubsub'),
    node('n2', 'pubsub'),
  ],
  edges: edges([
    ['n0', 'n1'],
    ['n1', 'n2'],
    ['n2', 'n1'],
    ['n1', 'n1'],
  ]),
};

describe('clients wired in a loop with more than one way back (#128)', () => {
  it.each([
    ['one client with two edges to itself', SELF_TWICE],
    ['three clients, a to b and back, a to c and back', DIAMOND],
    ['four clients, three ways back', FOUR],
  ])('%s fails every request as a loop, in bounded work', (_name, t) => {
    countCalls();
    const s = run(t, 5000);
    const roots = s.system.totalRequests;
    console.log(
      `${_name}: ${roots} requests, ${calls} calls, depth ${s.failuresByReason.depth}, ` +
        `failed ${s.system.totalFailed}, stops ${JSON.stringify(s.loopStops)}`,
    );
    expect(roots).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(roots * (MAX_LOOP_CALLS + 2 * MAX_HOP_DEPTH));
    expect(s.failuresByReason.depth).toBe(roots);
    expect(s.system.totalFailed).toBe(reasonSum(s));
    expect(Object.values(s.loopStops ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(
      0,
    );
  });

  it('gives every request a budget of its own', () => {
    // Every request here walks the same tree, so each makes the same number
    // of calls. A budget leaked from one request into the next would not.
    countCalls();
    const busier: Topology = {
      ...DIAMOND,
      nodes: DIAMOND.nodes.map((n) =>
        n.id === 'a' ? { ...n, config: { ...n.config, rps: 5 } } : n,
      ),
    };
    const engine = new Engine(busier, 1);
    const perRequest: number[] = [];
    let before = 0;
    let seen = 0;
    for (let i = 0; i < 600; i++) {
      engine.advance(1000 / 60);
      const total = engine.snapshot().system.totalRequests;
      if (total > seen) {
        perRequest.push((calls - before) / (total - seen));
        before = calls;
        seen = total;
      }
    }
    console.log(`calls per request: ${perRequest.join(', ')}`);
    expect(perRequest.length).toBeGreaterThanOrEqual(8);
    expect(new Set(perRequest).size).toBe(1);
  });

  it('never charges a part on no loop, however wide it fans out', () => {
    const fan = 400;
    const t: Topology = {
      nodes: [
        node('c', 'client', { rps: 2 }),
        node('api', 'service', { capacity: 1000, serviceMs: 1 }),
        node('db', 'service', { capacity: 1000, serviceMs: 1, errorRate: 0 }),
      ],
      edges: [
        { id: 'in', from: 'c', to: 'api', weight: 1 },
        ...Array.from({ length: fan }, (_, i) => ({
          id: `f${i}`,
          from: 'api',
          to: 'db',
          weight: 1,
        })),
      ],
    };
    const s = run(t, 3000);
    console.log(
      `fan-out ${fan} with no loop: ${s.system.totalRequests} requests, ` +
        `db served ${s.nodes.db?.totalCompleted}, depth ${s.failuresByReason.depth}`,
    );
    expect(fan).toBeGreaterThan(MAX_LOOP_CALLS);
    expect(s.failuresByReason.depth).toBe(0);
    expect(s.loopStops).toBeUndefined();
    expect(s.nodes.db?.totalCompleted).toBe(s.system.totalRequests * fan);
  });
});

describe('a topic wired into a loop (#129)', () => {
  it('stops a republished message after the hop ceiling, and books it at the topic', () => {
    countCalls();
    const s = run(TOPIC_LOOP, 2000);
    const offered = s.system.totalRequests;
    const topic = s.nodes.n1;
    console.log(
      `topic loop: ${offered} requests, ${calls} calls, topic failed ${topic?.totalFailed}, ` +
        `stops ${JSON.stringify(s.loopStops)}`,
    );
    // Each publish laps client and topic, two hops a lap, until the ceiling.
    expect(calls).toBeLessThanOrEqual(offered * (MAX_HOP_DEPTH + 2));
    expect(offered).toBeGreaterThan(2000);
    expect(s.loopStops?.n0 ?? 0).toBeGreaterThan(0);
    expect(topic?.totalFailed ?? 0).toBeGreaterThan(0);
    // The topic answered every publisher, so no client request failed.
    expect(s.system.totalFailed).toBe(reasonSum(s));
  });

  it('keeps a topic that fans out into its own loop from starving the clients', () => {
    countCalls();
    const s = run(TOPIC_FANOUT, 1000);
    console.log(
      `topic fan-out loop: ${s.system.totalRequests} offered in 1s, ${calls} calls, ` +
        `stops ${JSON.stringify(s.loopStops)}`,
    );
    // About 1159 a second, as the client asked; 38 got through before.
    expect(s.system.totalRequests).toBeGreaterThan(1000);
    // Each charged call can lead to at most two refused ones, one per way on.
    expect(calls).toBeLessThanOrEqual(s.system.totalRequests * MAX_LOOP_CALLS * 3);
    expect(s.loopStops?.n1 ?? 0).toBeGreaterThan(0);
  });
});
