import { describe, expect, it } from 'vitest';
import { applyLoad, splitLoad } from './challenge';
import type { Challenge } from './challenge';
import { CHALLENGES } from './challenges';
import { Engine } from './engine';
import {
  CHECK_SEEDS,
  checkDesign,
  designKey,
  extraSlots,
  judge,
  judgedTopology,
  nearestRank,
  playRun,
  slotBudget,
  slotsOf,
  startDesign,
  withLoad,
} from './judge';
import type { RunResult, Unjudgeable, Verdict } from './judge';
import { PRESETS, makeNode } from './presets';
import type {
  FaultEvent,
  NodeConfig,
  NodeKind,
  RunTally,
  SimNode,
  Topology,
} from './types';

/*
 * The check is the only thing that hands out a pass, so it has to give the
 * same answer every time and has to be judging the brief rather than
 * whatever the reader changed around it. These tests hold it to both.
 */

function brief(id: string): Challenge {
  const c = CHALLENGES.find((x) => x.id === id);
  if (!c) throw new Error(`no challenge ${id}`);
  return c;
}

/** The design a reader starts a brief with. */
function opened(c: Challenge): Topology {
  return applyLoad(structuredClone(startDesign(c)), c.loadRps);
}

function node(t: Topology, id: string): SimNode {
  const n = t.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

function runsOf(v: Verdict): RunResult[] {
  return 'runs' in v ? v.runs : [];
}

/** The start design of hold the line, with the database given room. */
function heldLine(): Topology {
  const t = opened(brief('hold-the-line'));
  node(t, 'db').config.capacity = 10;
  return t;
}

/** Retry storm with a slowdown in the brief, the shape of the fault briefs. */
const STORM: Challenge = brief('five-seconds');

/** A step generator from 3 to 50ms, the same sequence every time. */
function jitter(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return 3 + (s / 0x100000000) * 47;
  };
}

/** Play a replay in jittered steps and tally the brief's window. */
function replayTally(c: Challenge, run: RunResult, seed: number): RunTally {
  const engine = new Engine(run.replay);
  const next = jitter(seed);
  const warmupMs = (c.warmupS ?? 15) * 1000;
  const endMs = warmupMs + (c.windowS ?? 45) * 1000;
  const to = (ms: number) => {
    while (ms - engine.now > 1e-9) engine.advance(Math.min(next(), ms - engine.now));
  };
  to(warmupMs);
  engine.startTally();
  to(endMs);
  engine.stopTally();
  const tally = engine.readTally();
  if (tally === null) throw new Error('no tally');
  return tally;
}

describe('the check is deterministic', () => {
  it('gives deep-equal verdicts for the same design', () => {
    const a = judge(brief('hold-the-line'), heldLine());
    const b = judge(brief('hold-the-line'), heldLine());
    expect(a.status).toBe('passed');
    expect(runsOf(a)).toHaveLength(CHECK_SEEDS.length);
    expect(b).toEqual(a);
  });

  it('counts the same window when its replay is played in jittered steps', () => {
    // A fault brief, so the schedule has to land at the same simulated
    // moment however the frames fall, and the window has to start and stop
    // on the same millisecond.
    const design = opened(STORM);
    node(design, 'api').config.retries = 0;
    const v = judge(STORM, design);
    const runs = runsOf(v);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const tally = replayTally(STORM, run, run.seed * 7919);
      expect(tally.arrived).toBe(run.arrived);
      expect(tally.completed).toBe(run.completed);
      expect(tally.failed).toBe(run.failed);
      expect(tally.failuresByReason).toEqual(run.failuresByReason);
      expect(nearestRank(tally.latencies.slice().sort(), 0.99)).toBe(run.p99);
    }
  });

  it('can be played in slices and dropped halfway', () => {
    const it = checkDesign(brief('hold-the-line'), heldLine());
    let last = -1;
    for (let i = 0; i < 50; i++) {
      const step = it.next();
      if (step.done) throw new Error('finished too soon');
      expect(step.value.done).toBeGreaterThanOrEqual(last);
      expect(step.value.done).toBeLessThanOrEqual(1);
      last = step.value.done;
    }
    expect(it.return(undefined as never).done).toBe(true);
  });
});

describe('withLoad', () => {
  /** Seven clients at awkward rates, so every share has a remainder. */
  function seven(): Topology {
    const rates = [13, 7, 0.5, 101, 3, 3, 60];
    return {
      nodes: rates.map((rps, i) => {
        const n = makeNode('client', i * 100, 0);
        return { ...n, id: `c${i}`, config: { ...n.config, rps, traffic: 'spike' } };
      }),
      edges: [],
    };
  }

  it('adds up to the load exactly, in the mix the clients had', () => {
    const t = seven();
    const weights = t.nodes.map((n) => n.config.rps);
    const sum = weights.reduce((a, b) => a + b, 0);
    for (const load of [1, 7, 100, 333, 1000, 12345]) {
      const out = withLoad(t, load).nodes.map((n) => n.config.rps);
      expect(
        out.reduce((a, b) => a + b, 0),
        `load ${load}`,
      ).toBe(load);
      out.forEach((rps, i) => {
        expect(Number.isInteger(rps)).toBe(true);
        expect(Math.abs(rps - (load * weights[i]) / sum)).toBeLessThan(1);
      });
    }
  });

  it('makes every client steady and leaves its input alone', () => {
    const t = seven();
    const before = structuredClone(t);
    const out = withLoad(t, 500);
    expect(t).toEqual(before);
    for (const n of out.nodes) expect(n.config.traffic).toBe('steady');
  });

  it('splits evenly when no client has a rate', () => {
    expect(splitLoad(10, [0, 0, 0])).toEqual([4, 3, 3]);
    expect(splitLoad(200, [1, 1, 1])).toEqual([67, 67, 66]);
  });
});

describe('what the check holds still', () => {
  const c = brief('five-seconds');

  it('puts the work back: a 1ms database is judged as the brief database', () => {
    const cheat = opened(c);
    node(cheat, 'db').config.serviceMs = 1;
    const judged = judgedTopology(c, cheat).topology;
    expect(node(judged, 'db').config.serviceMs).toBe(40);
    expect(designKey(c, judged)).toBe(
      designKey(c, judgedTopology(c, opened(c)).topology),
    );
    expect(judge(c, cheat).status).not.toBe('passed');
  });

  it('puts the work back on a database deleted and added again', () => {
    const t = opened(c);
    const fresh = makeNode('db', 400, 0);
    const replaced: Topology = {
      nodes: [
        ...t.nodes.filter((n) => n.id !== 'db'),
        {
          ...fresh,
          id: 'db2',
          config: { ...fresh.config, capacity: 4, serviceMs: 1, lockMs: 0 },
        },
      ],
      edges: [
        ...t.edges.filter((e) => e.to !== 'db'),
        { id: 'api->db2', from: 'api', to: 'db2', weight: 1 },
      ],
    };
    const judged = node(judgedTopology(c, replaced).topology, 'db2').config;
    expect(judged.serviceMs).toBe(40);
    expect(judged.lockMs).toBe(15);
    expect(judge(c, replaced).status).not.toBe('passed');
  });

  it('gives a kind the brief never had its defaults', () => {
    const t = opened(c);
    const cache = makeNode('cache', 0, 0);
    t.nodes.push({
      ...cache,
      id: 'mine',
      config: { ...cache.config, serviceMs: 0.01 },
    });
    const judged = node(judgedTopology(c, t).topology, 'mine').config;
    expect(judged.serviceMs).toBe(makeNode('cache', 0, 0).config.serviceMs);
  });

  it('runs the client at the brief load, whatever the reader set', () => {
    const t = opened(c);
    const client: Partial<NodeConfig> = { rps: 20, timeoutMs: 150, retries: 5 };
    Object.assign(node(t, 'client').config, client);
    const judged = node(judgedTopology(c, t).topology, 'client').config;
    expect(judged.rps).toBe(c.loadRps);
    expect(judged.timeoutMs).toBe(3000);
    expect(judged.retries).toBe(0);
  });

  it('keeps the design decisions the reader made', () => {
    const t = opened(c);
    Object.assign(node(t, 'api').config, { retries: 0, timeoutMs: 1000, capacity: 9 });
    const judged = node(judgedTopology(c, t).topology, 'api').config;
    expect(judged).toMatchObject({ retries: 0, timeoutMs: 1000, capacity: 9 });
  });

  it("drops the reader's faults and seed and schedules the brief's", () => {
    const t: Topology = {
      ...opened(STORM),
      seed: 99,
      faults: [{ atMs: 1000, action: 'inject', nodeId: 'api', kind: 'crash' }],
    };
    const judged = judgedTopology(STORM, t).topology;
    expect(judged.seed).toBeUndefined();
    expect(judged.faults).toEqual(STORM.faults);
  });
});

describe('the design key', () => {
  const c = brief('hold-the-line');
  const key = (t: Topology, ch: Challenge = c) =>
    designKey(ch, judgedTopology(ch, t).topology);

  it('ignores what the check does not measure', () => {
    const base = key(opened(c));
    const moved = opened(c);
    node(moved, 'db').x += 300;
    node(moved, 'db').label = 'Postgres';
    expect(key(moved)).toBe(base);
    expect(key({ ...opened(c), seed: 7, annotations: [] })).toBe(base);
    expect(
      key({
        ...opened(c),
        faults: [{ atMs: 0, action: 'inject', nodeId: 'db', kind: 'crash' }],
      }),
    ).toBe(base);
  });

  it('changes with the design and with the brief version', () => {
    const base = key(opened(c));
    expect(key(heldLine())).not.toBe(base);
    expect(key(opened(c), { ...c, version: c.version + 1 })).not.toBe(base);
    expect(base.startsWith(`${c.id}@${c.version}:`)).toBe(true);
  });

  it('does not depend on the order fields were set in', () => {
    const a = heldLine();
    const b = heldLine();
    const db = node(b, 'db');
    const { capacity, ...rest } = db.config;
    db.config = { ...rest, capacity } as NodeConfig;
    expect(key(b)).toBe(key(a));
  });
});

describe('the slot budget', () => {
  const c: Challenge = { ...brief('hold-the-line'), budget: 4 };

  it('counts capacity times instances added over the start, node by node', () => {
    const t = opened(c);
    node(t, 'db').config.capacity = 10;
    expect(slotBudget(c, t)).toEqual({ used: 4, allowed: 4 });
    node(t, 'db').config.instances = 2;
    expect(slotBudget(c, t)?.used).toBe(14);
  });

  it('does not refund slots taken from somewhere else', () => {
    const t = opened(c);
    node(t, 'db').config.capacity = 10;
    node(t, 'api').config.capacity = 8;
    expect(slotBudget(c, t)?.used).toBe(4);
  });

  it('fails over budget before running anything', () => {
    const t = opened(c);
    node(t, 'db').config.capacity = 11;
    const v = judge(c, t);
    expect(v.status).toBe('over-budget');
    expect(v.budget).toEqual({ used: 5, allowed: 4 });
    expect('runs' in v).toBe(false);
  });

  it('is reported on a verdict that ran, and absent when the brief has none', () => {
    expect(judge(c, heldLine()).budget).toEqual({ used: 4, allowed: 4 });
    const open: Challenge = { ...brief('hold-the-line'), budget: undefined };
    expect(judge(open, heldLine()).budget).toBeNull();
  });

  it('counts a new node in full and an autoscaled one at its ceiling', () => {
    const start = opened(c);
    const t = opened(c);
    const worker = makeNode('service', 0, 0);
    t.nodes.push({ ...worker, id: 'extra', config: { ...worker.config, capacity: 3 } });
    expect(extraSlots(t, start)).toBe(3);

    const scaler = makeNode('autoscaler', 0, 0);
    const scaled = opened(c);
    scaled.nodes.push({
      ...scaler,
      id: 'as',
      config: { ...scaler.config, maxCapacity: 3 },
    });
    scaled.edges.push({ id: 'as->db', from: 'as', to: 'db', weight: 1, control: true });
    expect(extraSlots(scaled, start)).toBe(6 * 2);

    const inverted = opened(c);
    inverted.nodes.push({
      ...scaler,
      id: 'as',
      config: { ...scaler.config, minCapacity: 4, maxCapacity: 1 },
    });
    inverted.edges.push({
      id: 'as->db',
      from: 'as',
      to: 'db',
      weight: 1,
      control: true,
    });
    // The controller runs a floor set above its ceiling at the floor.
    expect(extraSlots(inverted, start)).toBe(6 * 3);
  });

  it('counts a shard by its partitions and a replica set with its primary', () => {
    const shard = makeNode('shard', 0, 0);
    shard.config = { ...shard.config, shardCount: 4, shardCapacity: 5 };
    expect(slotsOf(shard)).toBe(20);
    const replica = makeNode('replica', 0, 0);
    replica.config = { ...replica.config, capacity: 3, replicaCount: 2 };
    expect(slotsOf(replica)).toBe(9);
    expect(slotsOf(makeNode('client', 0, 0))).toBe(0);
  });
});

describe('a design the brief cannot be put to', () => {
  const crashy: Challenge = {
    ...brief('hold-the-line'),
    id: 'crash-fixture',
    faults: [{ atMs: 20_000, action: 'inject', nodeId: 'db', kind: 'crash-instance' }],
  };

  it('is unjudgeable when the fault target is gone', () => {
    const t = opened(crashy);
    t.nodes = t.nodes.filter((n) => n.id !== 'db');
    t.edges = t.edges.filter((e) => e.to !== 'db');
    const v = judge(crashy, t);
    expect(v.status).toBe('unjudgeable');
    if (v.status !== 'unjudgeable') return;
    expect(v.why).toMatchObject({ reason: 'fault-target-missing', target: 'db' });
  });

  it('is unjudgeable when the target can no longer take the fault', () => {
    const t = opened(crashy);
    node(t, 'db').kind = 'websocket';
    const v = judge(crashy, t);
    expect(v.status).toBe('unjudgeable');
  });

  it('is unjudgeable with no traffic source', () => {
    const t = opened(crashy);
    t.nodes = t.nodes.filter((n) => n.kind !== 'client');
    const v = judge(brief('hold-the-line'), t);
    expect(v.status === 'unjudgeable' && v.why.reason).toBe('no-traffic');
  });
});

describe('the verdict', () => {
  it('fails a dead system as nothing completed, with why the requests failed', () => {
    const v = judge(brief('five-seconds'), opened(brief('five-seconds')));
    expect(v.status).toBe('nothing-completed');
    if (v.status !== 'nothing-completed') return;
    expect(v.deciding.seed).toBe(CHECK_SEEDS[0]);
    expect(v.deciding.p99).toBeNull();
    for (const g of v.deciding.goals) expect(g.met, g.goal.metric).toBe(false);
    expect(v.deciding.failed).toBeGreaterThan(0);
    expect(Object.keys(v.deciding.failuresByReason).length).toBeGreaterThan(0);
  });

  it('stops at the first seed that misses a goal and names the goal', () => {
    const v = judge(brief('hold-the-line'), opened(brief('hold-the-line')));
    expect(v.status).toBe('goal-missed');
    const runs = runsOf(v);
    expect(runs).toHaveLength(1);
    expect(runs[0].goals.find((g) => g.goal.metric === 'p99')?.met).toBe(false);
  });

  it('fails a design that cannot keep up, even with goals it would meet', () => {
    // One slot, a line that never fills and no timeouts anywhere: requests
    // wait longer and longer and none of them fails, so only the share that
    // settles can tell this design is drowning.
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 200, timeoutMs: 0, retries: 0 };
    const db = { ...makeNode('db', 200, 0), id: 'db' };
    db.config = {
      ...db.config,
      capacity: 1,
      serviceMs: 10,
      serviceCv: 0,
      queueLimit: 1_000_000,
      lockMs: 0,
    };
    const start: Topology = {
      nodes: [client, db],
      edges: [{ id: 'client->db', from: 'client', to: 'db', weight: 1 }],
    };
    const loose: Challenge = {
      ...brief('hold-the-line'),
      id: 'loose-fixture',
      loadRps: 200,
      goals: [
        { metric: 'p99', max: 1e9 },
        { metric: 'errorRate', max: 100 },
      ],
      warmupS: 2,
      windowS: 10,
    };
    const v = judge(loose, start, { start });
    expect(v.status).toBe('falling-behind');
    if (v.status !== 'falling-behind') return;
    expect(v.deciding.keptUp).toBeLessThan(0.98);
  });
});

describe('nearestRank', () => {
  it('is the exact nearest-rank percentile', () => {
    const ms = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    expect(nearestRank(ms, 0.99)).toBe(99);
    expect(nearestRank(ms, 0.95)).toBe(95);
    expect(nearestRank(Float64Array.of(42), 0.99)).toBe(42);
    expect(nearestRank(new Float64Array(0), 0.99)).toBeNull();
  });
});

describe('the start design', () => {
  it("is the preset with the brief's own changes applied", () => {
    const c = brief('nothing-looks-busy');
    const start = startDesign(c);
    expect(node(start, 'api').config.capacity).toBe(14);
    expect(node(start, 'db').config.capacity).toBe(16);
    const preset = PRESETS.find((p) => p.id === c.presetId);
    expect(preset && node(preset.topology, 'api').config.capacity).toBe(64);
    expect(startDesign(c)).toBe(start);
  });

  it('is what the budget counts from', () => {
    const c = brief('nothing-looks-busy');
    expect(slotBudget(c, opened(c))).toEqual({ used: 0, allowed: c.budget });
  });

  it('refuses a change to a node the preset does not have', () => {
    const c: Challenge = {
      ...brief('hold-the-line'),
      id: 'typo-fixture',
      startOverrides: { dbb: { capacity: 9 } },
    };
    expect(() => startDesign(c)).toThrow(/no node dbb/);
  });
});

describe('what the design has to keep', () => {
  const c = brief('hold-the-line');
  const why = (edit: Edit, ch: Challenge = c): Unjudgeable | null => {
    const t = opened(ch);
    edit(t);
    return judgedTopology(ch, t).unjudgeable;
  };

  it('names each way a design stops being the system in the brief', () => {
    expect(why(decoyClient)).toEqual({ reason: 'traffic-added' });
    expect(why(remove('db'))).toEqual({ reason: 'component-missing', kind: 'db' });
    expect(why(all(cut('api', 'db'), connect('client', 'db')))).toEqual({
      reason: 'connection-cut',
      from: 'api',
      to: 'db',
    });
    expect(why(connect('client', 'db'))).toEqual({
      reason: 'connection-added',
      from: 'client',
      to: 'db',
    });
    expect(why(between('api', 'db', 'cache', { capacity: 1 }))).toEqual({
      reason: 'shortcut-added',
      kind: 'cache',
      allowed: 0,
    });
    const sink: Edit = (t) => {
      unwire(t, 'api', 'db');
      add('lb', 'lb', { capacity: 1 }, ['api'], ['db'])(t);
      add('service', 'sink', { capacity: 6 }, ['lb'], [])(t);
    };
    expect(why(sink)).toEqual({
      reason: 'dead-end-added',
      nodeId: 'sink',
      kind: 'service',
    });
  });

  it('lets new components go in between, and a brief allow one it would refuse', () => {
    expect(why(between('api', 'db', 'bulkhead'))).toBeNull();
    expect(why(between('api', 'db', 'breaker'))).toBeNull();
    expect(
      why(between('api', 'db', 'cache', { capacity: 4 }), brief('lose-a-machine')),
    ).toBeNull();
  });

  it('lets in one of a kind the brief allows, not a row of them', () => {
    const two = inARow('api', 'db', 'cache', 2, { capacity: 3 });
    expect(why(two, brief('lose-a-machine'))).toEqual({
      reason: 'shortcut-added',
      kind: 'cache',
      allowed: 1,
    });
  });

  it('can check every brief as it starts', () => {
    for (const ch of CHALLENGES) {
      expect(judgedTopology(ch, opened(ch)).unjudgeable, ch.id).toBeNull();
    }
  });
});

describe('the goals no client sees', () => {
  it('counts saves acknowledged and never written, past the end of the window', () => {
    const c = brief('saved-then-lost');
    const v = judge(c, opened(c));
    expect(v.status).toBe('goal-missed');
    if (v.status !== 'goal-missed') return;
    const byMetric = new Map(v.deciding.goals.map((g) => [g.goal.metric, g]));
    expect(byMetric.get('p99')?.met).toBe(true);
    expect(byMetric.get('errorRate')?.met).toBe(true);
    expect(byMetric.get('lostWrites')?.met).toBe(false);
    expect(v.deciding.lostWrites).toBeGreaterThan(100);
  });

  it('measures the line left in the queue at the end of the window', () => {
    const c = brief('loud-and-quiet');
    const t = opened(c);
    set('shards', { shardCapacity: 3 })(t);
    const v = judge(c, t);
    expect(v.status).toBe('goal-missed');
    if (v.status !== 'goal-missed') return;
    const unmet = v.deciding.goals.filter((g) => !g.met).map((g) => g.goal.metric);
    expect(unmet).toEqual(['queueDepth']);
    expect(v.deciding.queueDepth).toBeGreaterThan(1000);
    expect(v.deciding.lostWrites).toBeNull();
  });
});

describe('the set of briefs', () => {
  it('is listed by tier, and every brief has one', () => {
    const tiers = CHALLENGES.map((ch) => ch.tier);
    for (const t of tiers) expect(t).toBeTypeOf('number');
    expect(tiers).toEqual([...tiers].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it('gives every brief a goal on lost requests and a unique id', () => {
    for (const ch of CHALLENGES) {
      expect(
        ch.goals.some((g) => g.metric === 'errorRate'),
        ch.id,
      ).toBe(true);
    }
    expect(new Set(CHALLENGES.map((ch) => ch.id)).size).toBe(CHALLENGES.length);
  });

  it('has fixtures for every brief', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(CHALLENGES.map((ch) => ch.id).sort());
  });
});

/* ---------------- design edits for the brief fixtures ---------------- */

/** A change to a design, as a reader would make it on the canvas. */
type Edit = (t: Topology) => void;

function nodeIn(t: Topology, id: string): SimNode {
  const n = t.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
}

/** Set fields on a node. */
const set =
  (id: string, config: Partial<NodeConfig>): Edit =>
  (t) => {
    Object.assign(nodeIn(t, id).config, config);
  };

/** Several edits, in order. */
const all =
  (...edits: Edit[]): Edit =>
  (t) => {
    for (const e of edits) e(t);
  };

function fresh(kind: NodeKind, id: string, config: Partial<NodeConfig>): SimNode {
  const n = makeNode(kind, 0, 0);
  return { ...n, id, config: { ...n.config, ...config } };
}

function wire(t: Topology, from: string, to: string, weight = 1): void {
  t.edges.push({ id: `${from}->${to}`, from, to, weight });
}

function unwire(t: Topology, from: string, to: string): void {
  const before = t.edges.length;
  t.edges = t.edges.filter((e) => !(e.from === from && e.to === to));
  if (t.edges.length === before) throw new Error(`no edge ${from}->${to}`);
}

/** A new component on the connection from `from` to `to`. */
const between =
  (from: string, to: string, kind: NodeKind, config: Partial<NodeConfig> = {}): Edit =>
  (t) => {
    const id = `new-${kind}-${t.nodes.length}`;
    unwire(t, from, to);
    t.nodes.push(fresh(kind, id, config));
    wire(t, from, id);
    wire(t, id, to);
  };

/** `count` new components in a row on the connection from `from` to `to`. */
const inARow =
  (
    from: string,
    to: string,
    kind: NodeKind,
    count: number,
    config: Partial<NodeConfig> = {},
  ): Edit =>
  (t) => {
    unwire(t, from, to);
    let prev = from;
    for (let i = 0; i < count; i++) {
      const id = `row-${kind}-${i}`;
      t.nodes.push(fresh(kind, id, config));
      wire(t, prev, id);
      prev = id;
    }
    wire(t, prev, to);
  };

/** A new component taking over everything the client sends. */
const afterClient =
  (kind: NodeKind, config: Partial<NodeConfig> = {}): Edit =>
  (t) => {
    const out = t.edges.find((e) => e.from === 'client');
    if (!out) throw new Error('client sends nowhere');
    between('client', out.to, kind, config)(t);
  };

/** Add a node wired from and to existing ones. */
const add =
  (
    kind: NodeKind,
    id: string,
    config: Partial<NodeConfig>,
    from: readonly string[],
    to: readonly string[],
  ): Edit =>
  (t) => {
    t.nodes.push(fresh(kind, id, config));
    for (const f of from) wire(t, f, id);
    for (const x of to) wire(t, id, x);
  };

const remove =
  (id: string): Edit =>
  (t) => {
    nodeIn(t, id);
    t.nodes = t.nodes.filter((n) => n.id !== id);
    t.edges = t.edges.filter((e) => e.from !== id && e.to !== id);
  };

const cut =
  (from: string, to: string): Edit =>
  (t) => {
    unwire(t, from, to);
  };

const connect =
  (from: string, to: string): Edit =>
  (t) => {
    wire(t, from, to);
  };

const retype =
  (id: string, kind: NodeKind): Edit =>
  (t) => {
    nodeIn(t, id).kind = kind;
  };

/** An autoscaler driving `target`, its floor set above its ceiling. */
const floorAboveCeiling =
  (target: string, min: number): Edit =>
  (t) => {
    t.nodes.push(fresh('autoscaler', 'as', { minCapacity: min, maxCapacity: 1 }));
    t.edges.push({
      id: `as->${target}`,
      from: 'as',
      to: target,
      weight: 1,
      control: true,
    });
  };

/** Every node but the clients deleted. */
const onlyClients: Edit = (t) => {
  t.nodes = t.nodes.filter((n) => n.kind === 'client');
  t.edges = [];
};

/** A second client, wired to nothing, to soak up half the load. */
const decoyClient: Edit = (t) => {
  t.nodes.push(fresh('client', 'decoy', { rps: 1_000_000 }));
};

/** The work made fast and even everywhere: locked, so put back. */
const fastWork: Edit = (t) => {
  for (const n of t.nodes) Object.assign(n.config, { serviceMs: 1, serviceCv: 0 });
};

/** Clients that send little and give up fast: locked, so put back. */
const politeClients: Edit = (t) => {
  for (const n of t.nodes) {
    if (n.kind === 'client')
      Object.assign(n.config, { rps: 20, timeoutMs: 150, retries: 3 });
  }
};

/** A fault the reader scheduled: the check drops it. */
const userFault =
  (event: FaultEvent): Edit =>
  (t) => {
    t.faults = [...(t.faults ?? []), event];
  };

interface Fixture {
  name: string;
  edit: Edit;
}
const fx = (name: string, edit: Edit): Fixture => ({ name, edit });

interface BriefFixtures {
  /** Each passes the check and every one of seeds 1 to 10. */
  answers: Fixture[];
  /** Fixes a reader might try that do not work. Each fails the check. */
  wrong: Fixture[];
  /** Ways round the question. Each fails the check, or cannot be checked. */
  exploits: Fixture[];
}

/** The ways round that apply to every brief. */
function aroundEveryBrief(): Fixture[] {
  return [
    fx('clients that send 20 a second and give up at 150ms', politeClients),
    fx('every component working in 1ms', fastWork),
    fx('a second client wired to nothing', decoyClient),
    fx(
      'a queue with a line of a million after the client',
      afterClient('queue', { queueLimit: 1_000_000 }),
    ),
    fx('a pub/sub topic after the client', afterClient('pubsub')),
    fx('every component but the clients deleted', onlyClients),
  ];
}

const FIXTURES: Record<string, BriefFixtures> = {
  'hold-the-line': {
    answers: [
      fx('db capacity 9', set('db', { capacity: 9 })),
      fx('db capacity 12', set('db', { capacity: 12 })),
      fx('db instances 2', set('db', { instances: 2 })),
    ],
    wrong: [
      fx('db capacity 8, one short', set('db', { capacity: 8 })),
      fx('api capacity 70, the wrong part', set('api', { capacity: 70 })),
      fx('a shorter db line', set('db', { queueLimit: 12 })),
      fx('a deeper db line', set('db', { queueLimit: 200 })),
      fx(
        'the budget split, db 8 and api 68',
        all(set('db', { capacity: 8 }), set('api', { capacity: 68 })),
      ),
      fx('api gives up at 150ms', set('api', { timeoutMs: 150 })),
      fx('api capacity 128, over budget', set('api', { capacity: 128 })),
      fx('api instances 2, over budget', set('api', { instances: 2 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('db shedding with a line of 2', set('db', { queueLimit: 2 })),
      fx('db line of 5000', set('db', { queueLimit: 5000 })),
      fx(
        'a crash on db scheduled by the reader',
        userFault({ atMs: 1000, action: 'inject', nodeId: 'db', kind: 'crash' }),
      ),
      fx('db deleted', remove('db')),
      fx('api to db cut', cut('api', 'db')),
      fx(
        'db retyped to a cache',
        all(retype('db', 'cache'), set('db', { hitRate: 0.99 })),
      ),
      fx(
        'a cache hitting 0.99 in front of db',
        between('api', 'db', 'cache', { capacity: 1, hitRate: 0.99 }),
      ),
      fx(
        'a queue and a worker in front of db',
        all(between('api', 'db', 'queue', { queueLimit: 1_000_000 }), (t) => {
          const q = t.nodes[t.nodes.length - 1].id;
          unwire(t, q, 'db');
          add('worker', 'w', { capacity: 1 }, [q], ['db'])(t);
        }),
      ),
    ],
  },

  'keep-it-warm': {
    answers: [
      fx('cache hit rate 0.95', set('cache', { hitRate: 0.95 })),
      fx('cache hit rate 0.94', set('cache', { hitRate: 0.94 })),
      fx('cache hit rate 0.97', set('cache', { hitRate: 0.97 })),
      fx(
        'hit rate 0.93 and db capacity 6',
        all(set('cache', { hitRate: 0.93 }), set('db', { capacity: 6 })),
      ),
    ],
    wrong: [
      fx('db capacity 6, the whole budget', set('db', { capacity: 6 })),
      fx(
        'cache capacity 66, cache slots taken for cache size',
        set('cache', { capacity: 66 }),
      ),
      fx('api capacity 66', set('api', { capacity: 66 })),
      fx('hit rate 0.90', set('cache', { hitRate: 0.9 })),
      fx('hit rate 0.92', set('cache', { hitRate: 0.92 })),
      fx('a shorter db line', set('db', { queueLimit: 8 })),
      fx('a deeper db line', set('db', { queueLimit: 200 })),
      fx('cache capacity 256, over budget', set('cache', { capacity: 256 })),
      fx('cache instances 2, over budget', set('cache', { instances: 2 })),
      fx('db instances 2, over budget', set('db', { instances: 2 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('db shedding with a line of 2', set('db', { queueLimit: 2 })),
      fx('db line of 5000', set('db', { queueLimit: 5000 })),
      fx('cache gives up at 100ms', set('cache', { timeoutMs: 100 })),
      fx('db deleted', remove('db')),
      fx('cache to db cut', cut('cache', 'db')),
      fx('db retyped to a cache', retype('db', 'cache')),
      fx(
        'a second cache hitting 0.99 in front of db',
        between('cache', 'db', 'cache', { capacity: 1, hitRate: 0.99 }),
      ),
      fx(
        'a queue and a worker in front of db',
        all(between('cache', 'db', 'queue', { queueLimit: 1_000_000 }), (t) => {
          const q = t.nodes[t.nodes.length - 1].id;
          unwire(t, q, 'db');
          add('worker', 'w', { capacity: 1 }, [q], ['db'])(t);
        }),
      ),
    ],
  },
  'nothing-looks-busy': {
    answers: [
      fx('api capacity 16', set('api', { capacity: 16 })),
      fx('api capacity 18', set('api', { capacity: 18 })),
      fx('api capacity 20', set('api', { capacity: 20 })),
      fx('api capacity 24', set('api', { capacity: 24 })),
      fx('api capacity 30', set('api', { capacity: 30 })),
      fx('api instances 2', set('api', { instances: 2 })),
      fx(
        'api 22 and db 24',
        all(set('api', { capacity: 22 }), set('db', { capacity: 24 })),
      ),
    ],
    wrong: [
      fx('api capacity 15, one short', set('api', { capacity: 15 })),
      fx('db capacity 32, blaming the database', set('db', { capacity: 32 })),
      fx('db instances 2', set('db', { instances: 2 })),
      fx('a deeper api line', set('api', { queueLimit: 256 })),
      fx('a shorter api line', set('api', { queueLimit: 16 })),
      fx('api gives up on the database at 50ms', set('api', { timeoutMs: 50 })),
      fx(
        'the budget split, api 15 and db 31',
        all(set('api', { capacity: 15 }), set('db', { capacity: 31 })),
      ),
      fx('a shorter db line', set('db', { queueLimit: 8 })),
      fx('api instances 3, over budget', set('api', { instances: 3 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx(
        'an autoscaler on api, never below 3 and never above 1',
        floorAboveCeiling('api', 3),
      ),
      fx('api shedding with a line of 4', set('api', { queueLimit: 4 })),
      fx('api line of 5000', set('api', { queueLimit: 5000 })),
      fx('api gives up at 100ms', set('api', { timeoutMs: 100 })),
      fx('db deleted', remove('db')),
      fx('api to db cut', cut('api', 'db')),
      fx('db retyped to a cache', retype('db', 'cache')),
      fx(
        'a cache hitting 0.99 in front of db',
        between('api', 'db', 'cache', { capacity: 1, hitRate: 0.99 }),
      ),
    ],
  },
  'five-seconds': {
    answers: [
      fx('api does not retry', set('api', { retries: 0 })),
      fx('api waits 1000ms', set('api', { timeoutMs: 1000 })),
      fx('api waits as long as it takes', set('api', { timeoutMs: 0 })),
      fx('db line of 8', set('db', { queueLimit: 8 })),
      fx('db line of 16', set('db', { queueLimit: 16 })),
      fx(
        'a bulkhead of 12 in front of db',
        between('api', 'db', 'bulkhead', { bulkheadMax: 12 }),
      ),
    ],
    wrong: [
      fx('api retries once', set('api', { retries: 1 })),
      fx('api waits 500ms', set('api', { timeoutMs: 500 })),
      fx('db line of 1', set('db', { queueLimit: 1 })),
      fx('db line of 4, close', set('db', { queueLimit: 4 })),
      fx(
        'a bulkhead of 8, close',
        between('api', 'db', 'bulkhead', { bulkheadMax: 8 }),
      ),
      fx('api capacity 16', set('api', { capacity: 16 })),
      fx(
        'a rate limiter at 90 after the client',
        afterClient('ratelimiter', { rateLimitRps: 90, burst: 90 }),
      ),
      fx(
        'a rate limiter at 100 in front of db',
        between('api', 'db', 'ratelimiter', { rateLimitRps: 100, burst: 100 }),
      ),
      fx('db capacity 8, over budget', set('db', { capacity: 8 })),
      fx('db capacity 6, over budget', set('db', { capacity: 6 })),
      fx('api capacity 256, over budget', set('api', { capacity: 256 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx(
        'an autoscaler on db, never below 4 and never above 1',
        floorAboveCeiling('db', 4),
      ),
      fx('no line anywhere', (t) => {
        for (const n of t.nodes) n.config.queueLimit = 0;
      }),
      fx(
        'the slowdown cleared by the reader',
        userFault({ atMs: 10_001, action: 'clear', nodeId: 'db' }),
      ),
      fx(
        'a queue with a line of a million in front of db',
        between('api', 'db', 'queue', { queueLimit: 1_000_000 }),
      ),
      fx(
        'a cache in front of the api',
        afterClient('cache', { capacity: 1, hitRate: 1 }),
      ),
      fx(
        'api deleted, client straight to db',
        all(remove('api'), connect('client', 'db')),
      ),
      fx('db cut off', cut('api', 'db')),
      fx('db retyped to a service', retype('db', 'service')),
      fx('db deleted', remove('db')),
    ],
  },
  'not-everyones-problem': {
    answers: [
      fx(
        'a bulkhead of 8 in front of db',
        between('cache', 'db', 'bulkhead', { bulkheadMax: 8 }),
      ),
      fx(
        'a bulkhead of 6 in front of db',
        between('cache', 'db', 'bulkhead', { bulkheadMax: 6 }),
      ),
      fx(
        'a bulkhead of 12 in front of db',
        between('cache', 'db', 'bulkhead', { bulkheadMax: 12 }),
      ),
      fx('db line of 4', set('db', { queueLimit: 4 })),
      fx('db line of 8', set('db', { queueLimit: 8 })),
      fx(
        'api waits 300ms and db line of 8',
        all(set('api', { timeoutMs: 300 }), set('db', { queueLimit: 8 })),
      ),
      fx(
        'api waits 300ms and a bulkhead of 8',
        all(
          set('api', { timeoutMs: 300 }),
          between('cache', 'db', 'bulkhead', { bulkheadMax: 8 }),
        ),
      ),
    ],
    wrong: [
      fx('api waits 200ms', set('api', { timeoutMs: 200 })),
      fx('api waits 150ms', set('api', { timeoutMs: 150 })),
      fx('api waits 500ms', set('api', { timeoutMs: 500 })),
      fx(
        'a bulkhead of 4, too tight',
        between('cache', 'db', 'bulkhead', { bulkheadMax: 4 }),
      ),
      fx(
        'a bulkhead of 8 in front of the cache',
        between('api', 'cache', 'bulkhead', { bulkheadMax: 8 }),
      ),
      fx(
        'a bulkhead of 8 that waits',
        between('cache', 'db', 'bulkhead', { bulkheadMax: 8, bulkheadMode: 'wait' }),
      ),
      fx('a circuit breaker in front of db', between('cache', 'db', 'breaker')),
      fx('a shorter api line', set('api', { queueLimit: 8 })),
      fx('a deeper api line', set('api', { queueLimit: 512 })),
      fx('api retries twice', set('api', { retries: 2 })),
      fx(
        'a rate limiter at 300 after the client',
        afterClient('ratelimiter', { rateLimitRps: 300, burst: 300 }),
      ),
      fx('api capacity 64, over budget', set('api', { capacity: 64 })),
      fx('api instances 2, over budget', set('api', { instances: 2 })),
      fx('db capacity 8, over budget', set('db', { capacity: 8 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('cache hit rate 0.99', set('cache', { hitRate: 0.99 })),
      fx(
        'the slowdown cleared by the reader',
        userFault({ atMs: 20_001, action: 'clear', nodeId: 'db' }),
      ),
      fx('db cut off', cut('cache', 'db')),
      fx('db retyped to a cache', retype('db', 'cache')),
      fx('db retyped to a service', retype('db', 'service')),
      fx('db deleted', remove('db')),
    ],
  },
  'say-no-fast': {
    answers: [
      fx('limiter at 220', set('limiter', { rateLimitRps: 220, burst: 220 })),
      fx(
        'limiter at 230 with a burst of 20',
        set('limiter', { rateLimitRps: 230, burst: 20 }),
      ),
      fx('api line of 4', set('api', { queueLimit: 4 })),
      fx('api line of 8', set('api', { queueLimit: 8 })),
      fx('api line of 16', set('api', { queueLimit: 16 })),
      fx(
        'a load shedder at 230 after the client',
        afterClient('loadshedder', { rateLimitRps: 230, burst: 230 }),
      ),
    ],
    wrong: [
      fx('limiter at 240', set('limiter', { rateLimitRps: 240, burst: 240 })),
      fx('limiter at 250', set('limiter', { rateLimitRps: 250, burst: 250 })),
      fx('limiter at 260', set('limiter', { rateLimitRps: 260, burst: 260 })),
      fx('limiter at 300', set('limiter', { rateLimitRps: 300, burst: 300 })),
      fx(
        'limiter at 230 with a burst of 230',
        set('limiter', { rateLimitRps: 230, burst: 230 }),
      ),
      fx(
        'limiter at 230 with a burst of 2000',
        set('limiter', { rateLimitRps: 230, burst: 2000 }),
      ),
      fx('limiter at 200', set('limiter', { rateLimitRps: 200, burst: 200 })),
      fx('limiter at 100', set('limiter', { rateLimitRps: 100, burst: 100 })),
      fx('no api line', set('api', { queueLimit: 0 })),
      fx('api line of 32', set('api', { queueLimit: 32 })),
      fx('api line of 48, as the preset ships', set('api', { queueLimit: 48 })),
      fx('api gives up at 100ms', set('api', { timeoutMs: 100 })),
      fx('db line of 2', set('db', { queueLimit: 2 })),
      fx(
        'a bulkhead of 6 in front of db',
        between('api', 'db', 'bulkhead', { bulkheadMax: 6 }),
      ),
      fx('api capacity 12, over budget', set('api', { capacity: 12 })),
      fx('api instances 2, over budget', set('api', { instances: 2 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx(
        'limiter at 10, turning nearly everyone away',
        set('limiter', { rateLimitRps: 10, burst: 10 }),
      ),
      fx('limiter deleted', all(remove('limiter'), connect('client', 'api'))),
      fx('api deleted', all(remove('api'), connect('limiter', 'db'))),
      fx('api cut off', cut('limiter', 'api')),
      fx('api retyped to a cache', retype('api', 'cache')),
      fx('a cache after the client', afterClient('cache', { capacity: 1, hitRate: 1 })),
    ],
  },
  'buying-time': {
    answers: [
      fx('worker instances 2', set('worker', { instances: 2 })),
      fx('worker capacity 20', set('worker', { capacity: 20 })),
      fx('worker capacity 16', set('worker', { capacity: 16 })),
      fx(
        'a second pool of 10 workers on the queue',
        add('worker', 'worker2', { capacity: 10 }, ['queue'], ['db']),
      ),
    ],
    wrong: [
      fx('worker capacity 14', set('worker', { capacity: 14 })),
      fx('db capacity 18', set('db', { capacity: 18 })),
      fx('db instances 2', set('db', { instances: 2 })),
      fx('api capacity 34', set('api', { capacity: 34 })),
      fx('no db line', set('db', { queueLimit: 0 })),
      fx(
        'a rate limiter at 200 in front of the api',
        afterClient('ratelimiter', { rateLimitRps: 200, burst: 200 }),
      ),
      fx('worker instances 3, over budget', set('worker', { instances: 3 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('a queue of 100,000', set('queue', { queueLimit: 100_000 })),
      fx('workers that give up at 1ms', set('worker', { timeoutMs: 1 })),
      fx(
        'db capacity 1 with no line, failing the jobs',
        set('db', { capacity: 1, queueLimit: 0 }),
      ),
      fx(
        'a rate limiter of 1 a second in front of db, failing the jobs',
        between('worker', 'db', 'ratelimiter', { rateLimitRps: 1, burst: 1 }),
      ),
      fx(
        'a cache answering every upload',
        afterClient('cache', { capacity: 1, hitRate: 1 }),
      ),
      fx('workers deleted', remove('worker')),
      fx('db deleted', remove('db')),
      fx('api deleted', all(remove('api'), connect('client', 'queue'))),
    ],
  },
  'lose-a-machine': {
    answers: [
      fx('db as 4 machines of 3', set('db', { capacity: 3, instances: 4 })),
      fx('db as 3 machines of 4', set('db', { capacity: 4, instances: 3 })),
      fx('db as 6 machines of 2', set('db', { capacity: 2, instances: 6 })),
      fx('db as 4 machines of 4', set('db', { capacity: 4, instances: 4 })),
      fx('db as 3 machines of 5', set('db', { capacity: 5, instances: 3 })),
      fx('db as 5 machines of 3', set('db', { capacity: 3, instances: 5 })),
      fx('db as 3 machines of 6', set('db', { capacity: 6, instances: 3 })),
      fx(
        'db as 2 machines of 9, each enough alone',
        set('db', { capacity: 9, instances: 2 }),
      ),
      fx(
        'a cache of 4 in front of db as 2 machines of 6',
        all(
          set('db', { capacity: 6, instances: 2 }),
          between('api', 'db', 'cache', { capacity: 4 }),
        ),
      ),
    ],
    wrong: [
      fx('db scaled up to 18 on one machine', set('db', { capacity: 18 })),
      fx('db as 2 machines of 6, two halves', set('db', { capacity: 6, instances: 2 })),
      fx('a deeper db line', set('db', { queueLimit: 400 })),
      fx('a shorter db line', set('db', { queueLimit: 4 })),
      fx('api retries 3 times', set('api', { retries: 3 })),
      fx('api retries 3 times after 300ms', set('api', { retries: 3, timeoutMs: 300 })),
      fx(
        'a cache of 4 in front of the one machine',
        between('api', 'db', 'cache', { capacity: 4 }),
      ),
      fx('a load balancer and a second db beside the first', (t) => {
        unwire(t, 'api', 'db');
        add('lb', 'lb', { capacity: 2 }, ['api'], ['db'])(t);
        add('db', 'db2', { capacity: 4 }, ['lb'], [])(t);
      }),
      fx(
        'db as 2 machines of 12, over budget',
        set('db', { capacity: 12, instances: 2 }),
      ),
      fx('api capacity 128, over budget', set('api', { capacity: 128 })),
      fx('api instances 3, over budget', set('api', { instances: 3 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx(
        'an autoscaler on db, never below 3 and never above 1',
        floorAboveCeiling('db', 3),
      ),
      fx(
        'three caches of 2 in a row in front of db',
        inARow('api', 'db', 'cache', 3, { capacity: 2 }),
      ),
      fx(
        'a cache hitting 0.99 in front of db',
        between('api', 'db', 'cache', { capacity: 4, hitRate: 0.99 }),
      ),
      fx(
        'the dead machine cleared by the reader',
        userFault({ atMs: 25_001, action: 'clear', nodeId: 'db' }),
      ),
      fx('db deleted', remove('db')),
      fx(
        'db replaced under a new id',
        all(remove('db'), add('db', 'db2', { capacity: 3, instances: 6 }, ['api'], [])),
      ),
      fx('api to db cut', cut('api', 'db')),
    ],
  },
  'lose-a-region': {
    answers: [
      fx(
        'Europe sized to 15 and 5',
        all(set('eu-api', { capacity: 15 }), set('eu-db', { capacity: 5 })),
      ),
      fx(
        'Europe sized to 12 and 5',
        all(set('eu-api', { capacity: 12 }), set('eu-db', { capacity: 5 })),
      ),
      fx(
        'Europe sized to 14 and 4',
        all(set('eu-api', { capacity: 14 }), set('eu-db', { capacity: 4 })),
      ),
      fx(
        'Europe sized to 15 and 4',
        all(set('eu-api', { capacity: 15 }), set('eu-db', { capacity: 4 })),
      ),
      fx(
        'Europe API as 2 machines of 6, db 5',
        all(set('eu-api', { instances: 2 }), set('eu-db', { capacity: 5 })),
      ),
    ],
    wrong: [
      fx('the US made bigger', set('us-api', { capacity: 27 })),
      fx('the US as 3 machines of 6', set('us-api', { capacity: 6, instances: 3 })),
      fx("only Europe's API", set('eu-api', { capacity: 18 })),
      fx("only Europe's database", set('eu-db', { capacity: 14 })),
      fx(
        'too little in both, 11 and 3',
        all(set('eu-api', { capacity: 11 }), set('eu-db', { capacity: 3 })),
      ),
      fx(
        'slots moved from the US to Europe',
        all(
          set('us-api', { capacity: 6 }),
          set('eu-api', { capacity: 15 }),
          set('eu-db', { capacity: 5 }),
        ),
      ),
      fx(
        'long lines in Europe',
        all(set('eu-api', { queueLimit: 1000 }), set('eu-db', { queueLimit: 1000 })),
      ),
      fx(
        'short lines in Europe',
        all(set('eu-api', { queueLimit: 4 }), set('eu-db', { queueLimit: 4 })),
      ),
      fx(
        'both APIs retry twice after 300ms',
        all(
          set('us-api', { retries: 2, timeoutMs: 300 }),
          set('eu-api', { retries: 2, timeoutMs: 300 }),
        ),
      ),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('a router that switches at once', set('router', { failoverMs: 0 })),
      fx('a router that starts in Europe', set('router', { activeRegion: 1 })),
      fx(
        'the outage cleared by the reader',
        userFault({ atMs: 25_001, action: 'clear', nodeId: 'us-api' }),
      ),
      fx('us-api deleted', remove('us-api')),
      fx(
        'a load balancer in place of the router',
        all(
          set('eu-api', { capacity: 12 }),
          set('eu-db', { capacity: 4 }),
          retype('router', 'lb'),
          set('router', { capacity: 2 }),
        ),
      ),
      fx(
        'the US cut off, Europe sized',
        all(
          cut('router', 'us-api'),
          set('eu-api', { capacity: 15 }),
          set('eu-db', { capacity: 5 }),
        ),
      ),
    ],
  },
  'checkout-rush': {
    answers: [
      fx('3 copies of 5', set('replicas', { capacity: 5, replicaCount: 3 })),
      fx('2 copies of 6', set('replicas', { capacity: 6, replicaCount: 2 })),
      fx('2 copies of 5', set('replicas', { capacity: 5, replicaCount: 2 })),
      fx('1 copy of 10', set('replicas', { capacity: 10, replicaCount: 1 })),
    ],
    wrong: [
      fx('5 smaller copies of 3', set('replicas', { capacity: 3, replicaCount: 5 })),
      fx('no replication lag', set('replicas', { replicationLagMs: 0 })),
      fx('a deeper line', set('replicas', { queueLimit: 1000 })),
      fx('a shorter line', set('replicas', { queueLimit: 8 })),
      fx('api retries twice after 200ms', set('api', { retries: 2, timeoutMs: 200 })),
      fx('a fifth copy, over budget', set('replicas', { replicaCount: 5 })),
      fx('eight copies, over budget', set('replicas', { replicaCount: 8 })),
      fx('api capacity 400, over budget', set('api', { capacity: 400 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('reads raised to 95 in 100', set('replicas', { readFraction: 0.95 })),
      fx(
        'a cache in front of the replicas',
        between('api', 'replicas', 'cache', { capacity: 4 }),
      ),
      fx('replica set deleted', remove('replicas')),
      fx('api to replicas cut', cut('api', 'replicas')),
    ],
  },
  'one-hot-key': {
    answers: [
      fx(
        'a cache of 2 in front of the store',
        between('api', 'shards', 'cache', { capacity: 2 }),
      ),
      fx(
        'a cache of 4 in front of the store',
        between('api', 'shards', 'cache', { capacity: 4 }),
      ),
      fx(
        'a cache of 8 in front of the store',
        between('api', 'shards', 'cache', { capacity: 8 }),
      ),
      fx(
        'a cache hitting 0.99, put back to 0.8',
        between('api', 'shards', 'cache', { capacity: 8, hitRate: 0.99 }),
      ),
    ],
    wrong: [
      fx('a cache of 1, too small', between('api', 'shards', 'cache', { capacity: 1 })),
      fx('every shard 6 deep', set('shards', { shardCapacity: 6 })),
      fx('six shards', set('shards', { shardCount: 6 })),
      fx('a deeper shard line', set('shards', { queueLimit: 256 })),
      fx(
        'shards 6 deep with a line of 8',
        set('shards', { shardCapacity: 6, queueLimit: 8 }),
      ),
      fx(
        'shards 5 deep with a line of 64',
        set('shards', { shardCapacity: 5, queueLimit: 64 }),
      ),
      fx('api capacity 200', set('api', { capacity: 200 })),
      fx('api retries twice after 100ms', set('api', { retries: 2, timeoutMs: 100 })),
      fx('a second store behind a load balancer', (t) => {
        unwire(t, 'api', 'shards');
        add('lb', 'lb', { capacity: 1 }, ['api'], ['shards'])(t);
        add('shard', 'shards2', { shardCount: 1, shardCapacity: 4 }, ['lb'], [])(t);
      }),
      fx('every shard 7 deep, over budget', set('shards', { shardCapacity: 7 })),
      fx('a cache at its default size, over budget', between('api', 'shards', 'cache')),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('no hot key', set('shards', { hotKeyFraction: 0 })),
      fx(
        'two caches of 1 in a row in front of the store',
        inARow('api', 'shards', 'cache', 2, { capacity: 1 }),
      ),
      fx('shards shedding with a line of 2', set('shards', { queueLimit: 2 })),
      fx('store deleted', remove('shards')),
      fx(
        'store replaced with a database',
        all(remove('shards'), add('db', 'db', { capacity: 8 }, ['api'], [])),
      ),
      fx('a load balancer sending 9 in 10 to a cache with nothing behind it', (t) => {
        unwire(t, 'api', 'shards');
        add('lb', 'lb', { capacity: 1 }, ['api'], [])(t);
        t.edges.push({ id: 'lb->shards', from: 'lb', to: 'shards', weight: 1 });
        add('cache', 'c', { capacity: 2 }, [], [])(t);
        t.edges.push({ id: 'lb->c', from: 'lb', to: 'c', weight: 9 });
      }),
    ],
  },
  'saved-then-lost': {
    answers: [
      fx('db line of 750', set('db', { queueLimit: 750 })),
      fx('db line of 1000', set('db', { queueLimit: 1000 })),
      fx('db line of 2000', set('db', { queueLimit: 2000 })),
      fx('db line of 4000', set('db', { queueLimit: 4000 })),
      fx('db line of 100,000', set('db', { queueLimit: 100_000 })),
    ],
    wrong: [
      fx('flushed at once', set('writebuf', { flushDelayMs: 0 })),
      fx('flushed after 500ms', set('writebuf', { flushDelayMs: 500 })),
      fx('flushed after 1000ms', set('writebuf', { flushDelayMs: 1000 })),
      fx('flushed after 2000ms', set('writebuf', { flushDelayMs: 2000 })),
      fx('a deeper write-behind line', set('writebuf', { queueLimit: 4000 })),
      fx(
        'a bigger write-behind cache',
        set('writebuf', { capacity: 128, queueLimit: 2000 }),
      ),
      fx(
        'write-behind retries 3 times',
        set('writebuf', { retries: 3, timeoutMs: 2000 }),
      ),
      fx(
        'write-behind retries 5 times',
        set('writebuf', { retries: 5, timeoutMs: 5000 }),
      ),
      fx('write-behind retries 8 times', set('writebuf', { retries: 8 })),
      fx('db capacity 13, over budget', set('db', { capacity: 13 })),
      fx('db instances 2, over budget', set('db', { instances: 2 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('shedding at the front', set('shedder', { rateLimitRps: 190, burst: 190 })),
      fx(
        'a bigger low-priority share at 150',
        set('shedder', { rateLimitRps: 150, burst: 150, lowPriorityShare: 0.5 }),
      ),
      fx('a write-behind line of 1', set('writebuf', { queueLimit: 1, capacity: 32 })),
      fx('api line of 2', set('api', { queueLimit: 2 })),
      fx('db deleted', remove('db')),
      fx(
        'write-behind pointed at recs',
        all(cut('writebuf', 'db'), connect('writebuf', 'recs')),
      ),
      fx(
        'write-behind pointed at a service with nothing behind it',
        all(
          cut('writebuf', 'db'),
          add('service', 'sink', { capacity: 1 }, ['writebuf'], []),
        ),
      ),
      fx(
        'a queue nobody drains in front of db',
        between('writebuf', 'db', 'queue', { queueLimit: 1_000_000 }),
      ),
      fx(
        'write-behind taken out, api straight to db',
        all(remove('writebuf'), connect('api', 'db')),
      ),
    ],
  },
  'loud-and-quiet': {
    answers: [
      fx(
        'shards 3 deep and 8 workers',
        all(set('shards', { shardCapacity: 3 }), set('workers', { capacity: 8 })),
      ),
      fx(
        'a small cache in front of the store and 8 workers',
        all(
          between('cache', 'shards', 'cache', { capacity: 2 }),
          set('workers', { capacity: 8 }),
        ),
      ),
      fx(
        'shards 3 deep and a second pool of 2 workers',
        all(
          set('shards', { shardCapacity: 3 }),
          add('worker', 'workers2', { capacity: 2 }, ['queue'], []),
        ),
      ),
      fx(
        'shards 3 deep, 8 workers and a queue of 300',
        all(
          set('shards', { shardCapacity: 3 }),
          set('workers', { capacity: 8 }),
          set('queue', { queueLimit: 300 }),
        ),
      ),
    ],
    wrong: [
      fx('shards 3 deep only', set('shards', { shardCapacity: 3 })),
      fx('8 workers only', set('workers', { capacity: 8 })),
      fx(
        'shards 3 deep and 7 workers',
        all(set('shards', { shardCapacity: 3 }), set('workers', { capacity: 7 })),
      ),
      fx(
        'a small cache and 7 workers',
        all(
          between('cache', 'shards', 'cache', { capacity: 2 }),
          set('workers', { capacity: 7 }),
        ),
      ),
      fx('workers as 2 machines', set('workers', { instances: 2 })),
      fx(
        'a deeper shard line and 8 workers',
        all(set('shards', { queueLimit: 256 }), set('workers', { capacity: 8 })),
      ),
      fx(
        'more API threads',
        all(set('api1', { capacity: 26 }), set('api2', { capacity: 26 })),
      ),
      fx(
        'cache hit rate 0.9 and 8 workers',
        all(set('cache', { hitRate: 0.9 }), set('workers', { capacity: 8 })),
      ),
      fx('cache capacity 128, over budget', set('cache', { capacity: 128 })),
    ],
    exploits: [
      ...aroundEveryBrief(),
      fx('a queue of 100 shedding jobs', set('queue', { queueLimit: 100 })),
      fx(
        'shards 3 deep and a queue of 100',
        all(set('shards', { shardCapacity: 3 }), set('queue', { queueLimit: 100 })),
      ),
      fx('a queue of 100,000', set('queue', { queueLimit: 100_000 })),
      fx('CDN hit rate 0.9', set('cdn', { hitRate: 0.9 })),
      fx(
        'APIs straight to the workers',
        all(remove('queue'), connect('api1', 'workers'), connect('api2', 'workers')),
      ),
      fx('APIs no longer send jobs', all(cut('api1', 'queue'), cut('api2', 'queue'))),
    ],
  },
};

/* ---------------- each brief, held to its fixtures ---------------- */

/** One seed of a design, played the way the check plays it. */
function seedRun(c: Challenge, design: Topology, seed: number): RunResult {
  const play = playRun(c, judgedTopology(c, design).topology, seed);
  for (;;) {
    const step = play.next();
    if (step.done) return step.value;
  }
}

function edited(c: Challenge, f: Fixture): Topology {
  const t = opened(c);
  f.edit(t);
  return t;
}

/** What a verdict came to, for a failure message. */
function told(v: Verdict): string {
  if (v.status === 'unjudgeable') return `unjudgeable: ${JSON.stringify(v.why)}`;
  if (v.status === 'over-budget')
    return `over budget: ${v.budget.used} of ${v.budget.allowed}`;
  const d = v.deciding;
  return `${v.status} on seed ${d.seed}: ${JSON.stringify(d.goals.map((g) => [g.goal.metric, g.actual]))}`;
}

/** Seeds past the check's own, so a pass is not luck on three. */
const LATER_SEEDS = [4, 5, 6, 7, 8, 9, 10];
/** Ten seeds of a heavy brief take a second or two; leave room on a busy machine. */
const SLOW_MS = 30_000;

for (const c of CHALLENGES) {
  const fixtures = FIXTURES[c.id] ?? { answers: [], wrong: [], exploits: [] };
  describe(`brief: ${c.name}`, () => {
    it(
      'fails as it starts, on every seed from 1 to 10',
      () => {
        const start = opened(c);
        expect(judge(c, start).status).not.toBe('passed');
        for (const seed of [...CHECK_SEEDS, ...LATER_SEEDS]) {
          expect(seedRun(c, start, seed).outcome, `seed ${seed}`).not.toBe('passed');
        }
      },
      SLOW_MS,
    );

    for (const f of fixtures.answers) {
      it(
        `passes with ${f.name}, on every seed from 1 to 10`,
        () => {
          const design = edited(c, f);
          const v = judge(c, design);
          expect(v.status, told(v)).toBe('passed');
          for (const seed of LATER_SEEDS) {
            const run = seedRun(c, design, seed);
            expect(run.outcome, `seed ${seed}: ${JSON.stringify(run.goals)}`).toBe(
              'passed',
            );
          }
        },
        SLOW_MS,
      );
    }

    for (const f of [...fixtures.wrong, ...fixtures.exploits]) {
      it(`fails with ${f.name}`, () => {
        const v = judge(c, edited(c, f));
        expect(v.status, told(v)).not.toBe('passed');
      });
    }
  });
}
