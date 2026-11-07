import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { makeNode } from './presets';
import { canCrashOneInstance } from './behaviour';
import { packTopology, unpackTopology } from '../share/wire';
import type { FaultEvent, NodeKind, NodeStats, RunTally, Topology } from './types';

/*
 * 'crash-instance' takes one machine of a node down and leaves the rest
 * serving. The lesson it exists for is the difference between scaling out
 * and scaling up: three machines of 12 slots and one machine of 36 have the
 * same ceiling, and only the first survives losing a machine.
 */

/** client -> db, with lock contention off so the ceiling is the slot count. */
function clientDb(
  capacity: number,
  instances: number,
  rps: number,
  faults: FaultEvent[] = [],
): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps };
  const db = { ...makeNode('db', 200, 0), id: 'db' };
  db.config = {
    ...db.config,
    capacity,
    instances,
    serviceMs: 30,
    serviceCv: 0.5,
    queueLimit: 50,
    lockMs: 0,
  };
  return {
    nodes: [client, db],
    edges: [{ id: 'client->db', from: 'client', to: 'db', weight: 1 }],
    faults,
  };
}

/** One machine of the db down from 20s to 30s. */
const OUTAGE: FaultEvent[] = [
  { atMs: 20000, action: 'inject', nodeId: 'db', kind: 'crash-instance' },
  { atMs: 30000, action: 'clear', nodeId: 'db' },
];

function step(engine: Engine, ms: number): void {
  for (let t = 0; t < ms; t += 50) engine.advance(50);
}

/** Warm up 15s, then tally 25s, which holds the whole outage. */
function judged(topology: Topology, seed: number): RunTally {
  const engine = new Engine(topology, seed);
  step(engine, 15000);
  engine.startTally();
  step(engine, 25000);
  const tally = engine.readTally();
  if (tally === null) throw new Error('no tally');
  return tally;
}

function lossOf(t: RunTally): number {
  return t.failed / (t.completed + t.failed);
}

function dbStats(engine: Engine): NodeStats {
  const stats = engine.snapshot().nodes['db'];
  if (!stats) throw new Error('no db stats');
  return stats;
}

describe('losing one machine', () => {
  it('costs three machines of 12 a little and one machine of 36 everything', () => {
    // Both have 36 slots at 30ms: a ceiling of 1200 a second. At 1000 a
    // second, 83 percent of it, the 24 slots left after the crash are
    // overloaded and shed, but they keep serving. The single machine serves
    // nothing for the 10 of the 25 seconds it is down.
    for (const seed of [1, 2]) {
      const out = lossOf(judged(clientDb(12, 3, 1000, OUTAGE), seed));
      const up = lossOf(judged(clientDb(36, 1, 1000, OUTAGE), seed));
      expect(out).toBeLessThan(0.12);
      expect(up).toBeGreaterThan(0.38);
    }
  });

  it('costs almost nothing when the rest of the fleet can carry the load', () => {
    // 700 a second fits in the 800 the other two machines can finish.
    const t = judged(clientDb(12, 3, 700, OUTAGE), 1);
    expect(lossOf(t)).toBeLessThan(0.002);
    // What was lost is the work on the dead machine, and nothing else.
    expect(Object.keys(t.failuresByReason)).toEqual(['crashed']);
    expect(t.failuresByReason.crashed).toBeLessThanOrEqual(12);
  });

  it('fails the work that machine held, at once, and no more', () => {
    const engine = new Engine(clientDb(12, 3, 1000), 1);
    step(engine, 5000);
    const busy = dbStats(engine).inFlight;
    expect(busy).toBeGreaterThan(20);
    const before = engine.snapshot().failuresByReason.crashed;
    engine.injectFailure('db', 'crash-instance');
    const crashed = engine.snapshot().failuresByReason.crashed - before;
    // Work is spread round the fleet, so the dead machine held its share.
    expect(crashed).toBeGreaterThanOrEqual(Math.floor(busy / 3) - 1);
    expect(crashed).toBeLessThanOrEqual(12);
  });

  it('leaves the node the slots of the machines still up, until it is fixed', () => {
    const engine = new Engine(clientDb(12, 3, 3000), 1);
    step(engine, 2000);
    expect(dbStats(engine).inFlight).toBe(36);
    engine.injectFailure('db', 'crash-instance');
    let most = 0;
    for (let i = 0; i < 100; i++) {
      engine.advance(20);
      most = Math.max(most, dbStats(engine).inFlight);
    }
    expect(most).toBe(24);
    const down = dbStats(engine);
    expect(down.instances).toBe(3);
    expect(down.instancesDown).toBe(1);
    expect(down.perInstance?.[0]).toBe(0);
    expect(down.perInstance?.[1]).toBeGreaterThan(0.9);

    engine.clearFailure('db');
    step(engine, 1000);
    const fixed = dbStats(engine);
    expect(fixed.inFlight).toBe(36);
    expect(fixed.instancesDown).toBeUndefined();
  });

  it('on a node with one machine is a crash, number for number', () => {
    const run = (kind: 'crash' | 'crash-instance') => {
      const engine = new Engine(
        clientDb(36, 1, 1000, [
          { atMs: 3000, action: 'inject', nodeId: 'db', kind },
          { atMs: 6000, action: 'clear', nodeId: 'db' },
        ]),
        4,
      );
      step(engine, 4000);
      expect(engine.isCrashed('db')).toBe(true);
      step(engine, 4000);
      const snap = engine.snapshot();
      return {
        system: snap.system,
        reasons: snap.failuresByReason,
        history: snap.history,
      };
    };
    expect(run('crash-instance')).toEqual(run('crash'));
  });

  it('is not a crash while a machine is left', () => {
    const engine = new Engine(clientDb(12, 2, 100), 1);
    engine.injectFailure('db', 'crash-instance');
    expect(engine.isCrashed('db')).toBe(false);
    step(engine, 2000);
    expect(dbStats(engine).throughput).toBeGreaterThan(80);
  });

  it('kills the threads parked on that machine, and only those', () => {
    // A thread-per-request api of 3 machines x 4 slots calling a db that takes
    // half a second: every api slot is a thread parked on the db. The client
    // waits as long as it takes, so a lost thread is seen as what it was and
    // not as the client giving up.
    const client = { ...makeNode('client', 0, 0), id: 'client' };
    client.config = { ...client.config, rps: 200, timeoutMs: 0 };
    const api = { ...makeNode('service', 200, 0), id: 'api' };
    api.config = {
      ...api.config,
      capacity: 4,
      instances: 3,
      serviceMs: 1,
      serviceCv: 0,
    };
    const db = { ...makeNode('db', 400, 0), id: 'db' };
    db.config = {
      ...db.config,
      capacity: 64,
      serviceMs: 500,
      serviceCv: 0,
      lockMs: 0,
    };
    const topology: Topology = {
      nodes: [client, api, db],
      edges: [
        { id: 'client->api', from: 'client', to: 'api', weight: 1 },
        { id: 'api->db', from: 'api', to: 'db', weight: 1 },
      ],
    };
    const engine = new Engine(topology, 1);
    step(engine, 3000);
    const apiStats = (): NodeStats => {
      const s = engine.snapshot().nodes['api'];
      if (!s) throw new Error('no api stats');
      return s;
    };
    expect(apiStats().waitingOnDownstream).toBe(12);
    const crashedBefore = engine.snapshot().failuresByReason.crashed;

    engine.injectFailure('api', 'crash-instance');
    // Their slots come back at once, and the machine they were on is gone.
    expect(apiStats().waitingOnDownstream).toBe(8);
    // Their requests fail when the db answers them, as 'crashed', not before.
    expect(engine.snapshot().failuresByReason.crashed).toBe(crashedBefore);
    step(engine, 600);
    expect(engine.snapshot().failuresByReason.crashed - crashedBefore).toBe(4);
    // The other two machines are still full of threads waiting on the db.
    expect(apiStats().waitingOnDownstream).toBe(8);
  });

  it('replays from its schedule exactly as it happened', () => {
    const live = new Engine(clientDb(12, 3, 1000), 5);
    step(live, 3000);
    live.recordFailure('db', 'crash-instance');
    step(live, 2000);
    live.recordClearFailure('db');
    step(live, 2000);
    const exported = live.exportTopology();
    expect(exported.faults).toEqual([
      { atMs: 3000, action: 'inject', nodeId: 'db', kind: 'crash-instance' },
      { atMs: 5000, action: 'clear', nodeId: 'db' },
    ]);
    const replay = new Engine(exported);
    step(replay, 7000);
    expect(JSON.stringify(replay.snapshot())).toBe(JSON.stringify(live.snapshot()));
    live.reset();
    step(live, 7000);
    expect(JSON.stringify(live.snapshot())).toBe(JSON.stringify(replay.snapshot()));
  });

  it('crosses a replay link and comes back the same', () => {
    const t = clientDb(12, 3, 1000, OUTAGE);
    const back = unpackTopology(packTopology(t));
    // A link carries no ids, so the database comes back under a fresh one.
    const db = back?.nodes.find((n) => n.kind === 'db');
    expect(db?.config.instances).toBe(3);
    expect(back?.faults).toEqual(OUTAGE.map((f) => ({ ...f, nodeId: db?.id })));
  });

  it('is refused on a kind that cannot lose one machine', () => {
    const kinds: NodeKind[] = ['queue', 'websocket', 'replica', 'shard', 'client'];
    for (const kind of kinds) {
      expect(canCrashOneInstance(kind), kind).toBe(false);
      const node = { ...makeNode(kind, 0, 0), id: 'x' };
      const engine = new Engine({ nodes: [node], edges: [] });
      expect(engine.injectFailure('x', 'crash-instance')).toBe(false);
      engine.recordFailure('x', 'crash-instance');
      expect(engine.activeFailures()).toEqual([]);
      expect(engine.faultSchedule()).toEqual([]);
    }
    for (const kind of ['service', 'db', 'cache', 'worker', 'lb'] as NodeKind[]) {
      expect(canCrashOneInstance(kind), kind).toBe(true);
    }
  });

  it('is dropped from a schedule aimed at such a kind, with the reason', () => {
    const ws = { ...makeNode('websocket', 0, 0), id: 'ws' };
    const dropped: string[] = [];
    const kept = sanitizeFaults(
      [
        { atMs: 1, action: 'inject', nodeId: 'ws', kind: 'crash-instance' },
        { atMs: 2, action: 'inject', nodeId: 'ws', kind: 'crash' },
      ],
      { nodes: [ws], edges: [] },
      (i, why) => dropped.push(`${i} ${why}`),
    );
    expect(kept).toEqual([{ atMs: 2, action: 'inject', nodeId: 'ws', kind: 'crash' }]);
    expect(dropped).toEqual([
      "0 crashes one instance of 'ws', but a websocket cannot lose one instance; use crash.",
    ]);
  });

  it('goes with its node when the node is retyped to a kind that cannot have it', () => {
    const t = clientDb(12, 3, 100);
    const engine = new Engine(t, 1);
    step(engine, 1000);
    engine.recordFailure('db', 'crash-instance');
    step(engine, 500);
    engine.setTopology({
      ...t,
      faults: undefined,
      nodes: t.nodes.map((n) => (n.id === 'db' ? { ...n, kind: 'queue' as const } : n)),
    });
    expect(engine.activeFailures()).toEqual([]);
    expect(engine.faultSchedule()).toEqual([
      { atMs: 1000, action: 'inject', nodeId: 'db', kind: 'crash-instance' },
      { atMs: 1500, action: 'clear', nodeId: 'db' },
    ]);
  });

  it('changes nothing about a run that never uses it', () => {
    // Placement draws nothing and decides nothing a healthy run can see, so
    // two machines of 6 replay exactly as they always did: equal to a run of
    // the same design, and to the same seed run again.
    const a = new Engine(clientDb(6, 2, 300), 9);
    const b = new Engine(clientDb(6, 2, 300), 9);
    step(a, 5000);
    step(b, 5000);
    const snap = JSON.stringify(a.snapshot());
    expect(snap).toBe(JSON.stringify(b.snapshot()));
    expect(snap).not.toContain('instancesDown');
  });
});

describe('a fleet resized while a machine is down', () => {
  it('is never scaled down to only the dead machine by an autoscaler', () => {
    // Three machines of 10 at a light load, with an autoscaler free to go
    // down to one. It sizes the machines that are up, so the dead one stays
    // in the fleet beside at least one live one until it is fixed.
    const t = clientDb(10, 3, 100);
    const scaler = { ...makeNode('autoscaler', 200, 100), id: 'as' };
    scaler.config = {
      ...scaler.config,
      minCapacity: 1,
      maxCapacity: 6,
      cooldownMs: 3000,
    };
    t.nodes.push(scaler);
    t.edges.push({ id: 'as->db', from: 'as', to: 'db', weight: 1, control: true });
    t.faults = [{ atMs: 2000, action: 'inject', nodeId: 'db', kind: 'crash-instance' }];
    const engine = new Engine(t, 1);
    let fewest = Infinity;
    for (let s = 0; s < 40; s++) {
      step(engine, 1000);
      expect(engine.isCrashed('db'), `at ${s + 1}s`).toBe(false);
      if (s >= 2) fewest = Math.min(fewest, dbStats(engine).instances ?? 1);
    }
    // It did scale down, to one live machine and the dead one.
    expect(fewest).toBe(2);
    expect(engine.snapshot().failuresByReason.crashed ?? 0).toBeLessThan(10);
  });

  /** One machine of 12 slots, every slot busy on a 500ms query, then down. */
  function fullAndDown(): Engine {
    const t = clientDb(12, 1, 40);
    const [client, db] = t.nodes;
    // A client that waits, so every failure it sees is the database's.
    client.config = { ...client.config, timeoutMs: 0 };
    db.config = { ...db.config, serviceMs: 500, serviceCv: 0 };
    const engine = new Engine(t, 1);
    step(engine, 3000);
    expect(dbStats(engine).inFlight).toBe(12);
    engine.injectFailure('db', 'crash-instance');
    return engine;
  }

  it('fails the work on the dead machine when machines come up beside it', () => {
    // Left at one machine, the node is crashed, and the twelve in service
    // fail only as they come out, 500ms on.
    const left = fullAndDown();
    const leftBefore = left.snapshot().failuresByReason.crashed ?? 0;
    step(left, 100);
    expect((left.snapshot().failuresByReason.crashed ?? 0) - leftBefore).toBeLessThan(
      12,
    );

    // Grown to two, the twelve were on the machine that died, so they fail
    // now instead of finishing on it, and the new machine takes the line.
    const grown = fullAndDown();
    const before = grown.snapshot().failuresByReason.crashed ?? 0;
    const done = dbStats(grown).totalCompleted;
    grown.updateNodeConfig('db', { instances: 2 });
    expect(grown.isCrashed('db')).toBe(false);
    step(grown, 100);
    expect((grown.snapshot().failuresByReason.crashed ?? 0) - before).toBe(12);
    step(grown, 1000);
    expect(dbStats(grown).totalCompleted).toBeGreaterThan(done);
  });

  it('is a crash once only the dead machine is left', () => {
    const t = clientDb(6, 2, 40);
    const db = t.nodes[1];
    db.config = { ...db.config, serviceMs: 500, serviceCv: 0 };
    const engine = new Engine(t, 1);
    step(engine, 3000);
    engine.injectFailure('db', 'crash-instance');
    step(engine, 200);
    expect(dbStats(engine).inFlight).toBe(6);
    engine.updateNodeConfig('db', { instances: 1 });
    expect(engine.isCrashed('db')).toBe(true);
    // Nothing succeeds at it from then on, as with a crash.
    const done = dbStats(engine).totalCompleted;
    step(engine, 1000);
    expect(dbStats(engine).totalCompleted).toBe(done);
  });
});
