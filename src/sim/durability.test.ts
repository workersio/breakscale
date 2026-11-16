import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import { acksBeforeSafe, flushesLater } from './behaviour';
import {
  breakGoals,
  breakTargets,
  DEFAULT_OPTIONS,
  playBaseline,
  trial,
} from './breakit';
import type { Attack, SeedRun } from './breakit';
import type { Goal } from './challenge';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import {
  BUFFER_DROPPED,
  BUFFER_LANDED,
  COPY_DISK,
  checkLostAckedWrites,
} from './oplog';
import type { OpLog } from './oplog';
import { defaultConfig } from './presets';
import type { FaultEvent, NodeConfig, NodeKind, SimNode, Topology } from './types';
import { verify, verifyErrors } from './verify';

/**
 * A store that answers before its writes reach disk, and the restart that
 * loses them.
 *
 * The fixture is a client, an api that retries, and one database. With
 * `flushEveryMs` a write is on disk that long after it applied, so a crash
 * at c loses exactly the writes applied in (c - flushEveryMs, c].
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

function orders(db: Partial<NodeConfig> = {}, faults?: FaultEvent[]): Topology {
  return {
    nodes: [
      node('client', 'client', { rps: 100 }),
      node('api', 'service', {
        capacity: 32,
        serviceMs: 5,
        timeoutMs: 300,
        retries: 2,
      }),
      node('db', 'db', { capacity: 12, serviceMs: 15, ...db }),
    ],
    edges: [
      { id: 'client->api', from: 'client', to: 'api', weight: 1 },
      { id: 'api->db', from: 'api', to: 'db', weight: 1 },
    ],
    ...(faults ? { faults } : {}),
  };
}

const RESTART: FaultEvent = {
  atMs: 12_500,
  action: 'inject',
  nodeId: 'db',
  kind: 'restart',
  opts: { downMs: 2000 },
};

function play(t: Topology, untilMs: number, seed = 1): { engine: Engine; log: OpLog } {
  const engine = new Engine(t, seed);
  engine.startOpLog();
  while (engine.now < untilMs) engine.advance(100);
  const log = engine.readOpLog();
  if (log === null) throw new Error('no log');
  return { engine, log };
}

/** The store's own writes the log kept, as [applied at, state]. */
function diskCopies(log: OpLog): [number, number][] {
  const out: [number, number][] = [];
  const b = log.buffers;
  for (let i = 0; i < b.rid.length; i++) {
    if (b.copy[i] === COPY_DISK) out.push([b.t[i], b.state[i]]);
  }
  return out;
}

describe('a store that answers before its disk has the write', () => {
  it('loses exactly the writes applied in the last flushEveryMs before a restart', () => {
    const { engine, log } = play(orders({ flushEveryMs: 1000 }, [RESTART]), 20_000);
    const copies = diskCopies(log);
    const window = copies.filter(([t]) => t > 11_500 && t <= 12_500);
    const dropped = copies.filter(([, s]) => s === BUFFER_DROPPED);
    expect(window.length).toBe(6);
    expect(dropped.map(([t]) => t)).toEqual(window.map(([t]) => t));
    // Everything applied before the window had reached disk.
    for (const [t, s] of copies) if (t <= 11_500) expect(s).toBe(BUFFER_LANDED);
    const check = checkLostAckedWrites(log, 5000, 20_000);
    expect(check.count).toBe(6);
    expect(
      check.violations.every((v) => v.copy === 'disk' && v.lostMs === 12_500),
    ).toBe(true);
    expect(engine.snapshot().nodes.db.lostInLastCrash).toBe(6);
  });

  it('loses nothing when each write is on disk before it answers', () => {
    const { engine, log } = play(orders({}, [RESTART]), 20_000);
    expect(diskCopies(log)).toEqual([]);
    expect(checkLostAckedWrites(log, 5000, 20_000).count).toBe(0);
    const db = engine.snapshot().nodes.db;
    expect(db.unflushedWrites).toBeUndefined();
    expect(db.lostInLastCrash).toBeUndefined();
  });

  it('counts the writes not on disk yet, live', () => {
    const engine = new Engine(orders({ flushEveryMs: 1000 }), 1);
    let most = 0;
    while (engine.now < 10_000) {
      engine.advance(100);
      most = Math.max(most, engine.snapshot().nodes.db.unflushedWrites ?? -1);
    }
    expect(most).toBe(17);
    expect(engine.snapshot().nodes.db.lostInLastCrash).toBe(0);
  });

  it('draws nothing and changes no event until a crash', () => {
    // The same run with and without the setting, its two readouts aside.
    const hash = (t: Topology) => {
      const engine = new Engine(t, 7);
      const h = createHash('sha256');
      for (let i = 1; i <= 600; i++) {
        engine.advance(1000 / 60);
        if (i % 6 === 0) {
          const s = engine.snapshot();
          delete s.nodes.db.unflushedWrites;
          delete s.nodes.db.lostInLastCrash;
          h.update(JSON.stringify(s));
        }
      }
      return h.digest('hex');
    };
    expect(hash(orders({ flushEveryMs: 1000 }))).toBe(hash(orders()));
  });

  it('counts the lost writes in the tally too', () => {
    const goal: Goal = { metric: 'lostWrites', max: 0 };
    const crash: Attack = { kind: 'crash', target: 'db', atMs: 10_000, forMs: 500 };
    const t = orders({ flushEveryMs: 1000 });
    const base = baseline(t, goal);
    expect(base.map((r) => r.actual)).toEqual([0, 0, 0]);
    // Every write acked in the window counts, the api's retries included.
    expect(trial(t, goal, [crash], base).runs[0].actual).toBe(11);
  });

  it('is a setting only a database and a replica set have', () => {
    expect(flushesLater(node('db', 'db', { flushEveryMs: 100 }))).toBe(true);
    expect(flushesLater(node('r', 'replica', { flushEveryMs: 100 }))).toBe(true);
    expect(flushesLater(node('db', 'db', { flushEveryMs: 0 }))).toBe(false);
    expect(flushesLater(node('s', 'service', { flushEveryMs: 100 }))).toBe(false);
    expect(acksBeforeSafe(node('w', 'writebehind'))).toBe(true);
    expect(acksBeforeSafe(node('db', 'db'))).toBe(false);
  });

  it('loses a replica set’s unflushed writes when the whole set restarts', () => {
    const t: Topology = {
      nodes: [
        node('client', 'client', { rps: 100 }),
        node('rs', 'replica', { readFraction: 0.5, flushEveryMs: 1000 }),
      ],
      edges: [{ id: 'client->rs', from: 'client', to: 'rs', weight: 1 }],
      faults: [{ ...RESTART, nodeId: 'rs' }],
    };
    const { log } = play(t, 20_000);
    const copies = diskCopies(log);
    const window = copies.filter(([t]) => t > 11_500 && t <= 12_500);
    expect(window.length).toBeGreaterThan(0);
    expect(copies.filter(([, s]) => s === BUFFER_DROPPED).length).toBe(window.length);
  });
});

describe('restart', () => {
  it('is down for downMs, then back on its own', () => {
    const engine = new Engine(orders({}, [RESTART]), 1);
    const kinds: string[] = [];
    for (const at of [12_400, 12_600, 14_400, 14_600]) {
      while (engine.now < at) engine.advance(100);
      kinds.push(
        engine
          .snapshot()
          .activeFailures.map((f) => f.kind)
          .join() || 'none',
      );
    }
    expect(kinds).toEqual(['none', 'restart', 'restart', 'none']);
    expect(engine.snapshot().nodes.db.totalFailed).toBeGreaterThan(0);
  });

  it('a Fix, then a second restart, is not cut short by the first one', () => {
    const t = orders({}, [
      {
        atMs: 10_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'restart',
        opts: { downMs: 2000 },
      },
      { atMs: 10_500, action: 'clear', nodeId: 'db' },
      {
        atMs: 11_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'restart',
        opts: { downMs: 2000 },
      },
    ]);
    const engine = new Engine(t, 1);
    while (engine.now < 12_500) engine.advance(100);
    expect(engine.snapshot().activeFailures.map((f) => f.kind)).toEqual(['restart']);
    while (engine.now < 13_100) engine.advance(100);
    expect(engine.snapshot().activeFailures).toEqual([]);
  });

  it('a restart clicked live replays exactly from its schedule', () => {
    const live = new Engine(orders({ flushEveryMs: 100 }), 3);
    const frames: string[] = [];
    for (let i = 1; i <= 300; i++) {
      live.advance(50);
      if (i === 120) live.recordFailure('db', 'restart', { downMs: 1000 });
      frames.push(JSON.stringify(live.snapshot()));
    }
    const exported = live.exportTopology();
    expect(exported.faults).toEqual([
      {
        atMs: 6000,
        action: 'inject',
        nodeId: 'db',
        kind: 'restart',
        opts: { downMs: 1000 },
      },
    ]);
    const replay = new Engine(exported, 3);
    for (let i = 1; i <= 300; i++) {
      replay.advance(50);
      expect(JSON.stringify(replay.snapshot())).toBe(frames[i - 1]);
    }
  });

  it('needs a time down above 0 to load', () => {
    const drops: string[] = [];
    const kept = sanitizeFaults(
      [
        { atMs: 1, action: 'inject', nodeId: 'db', kind: 'restart' },
        {
          atMs: 1,
          action: 'inject',
          nodeId: 'db',
          kind: 'restart',
          opts: { downMs: 0 },
        },
        {
          atMs: 1,
          action: 'inject',
          nodeId: 'db',
          kind: 'restart',
          opts: { downMs: 500 },
        },
        // Only a restart keeps a time down.
        {
          atMs: 1,
          action: 'inject',
          nodeId: 'db',
          kind: 'crash',
          opts: { downMs: 500 },
        },
      ],
      undefined,
      (_i, why) => drops.push(why),
    );
    expect(drops).toHaveLength(2);
    expect(kept).toEqual([
      {
        atMs: 1,
        action: 'inject',
        nodeId: 'db',
        kind: 'restart',
        opts: { downMs: 500 },
      },
      { atMs: 1, action: 'inject', nodeId: 'db', kind: 'crash' },
    ]);
  });

  it('crosses a share link with its time down and the store setting', () => {
    const t = orders({ flushEveryMs: 1000 }, [
      RESTART,
      { atMs: 13_000, action: 'clear', nodeId: 'db' },
    ]);
    const back = unpackTopology(packTopology(t));
    const db = back?.nodes.find((n) => n.kind === 'db');
    expect(db?.config.flushEveryMs).toBe(1000);
    expect(back?.faults).toEqual([
      { ...RESTART, nodeId: db?.id },
      { atMs: 13_000, action: 'clear', nodeId: db?.id },
    ]);
  });
});

function baseline(t: Topology, goal: Goal): SeedRun[] {
  const it = playBaseline(t, goal);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value.runs;
  }
}

describe('Can you break it? and a store that flushes later', () => {
  const GOAL = { metric: 'lostAckedWrites', max: 0 } as const;

  it('offers the saved-writes goal once the store answers before its disk', () => {
    expect(breakGoals(orders()).some((g) => g.id === 'saved')).toBe(false);
    expect(
      breakGoals(orders({ flushEveryMs: 100 })).some((g) => g.id === 'saved'),
    ).toBe(true);
    expect(verifyErrors(orders(), GOAL)[0]).toMatch(/saved before it is/);
    expect(verifyErrors(orders({ flushEveryMs: 100 }), GOAL)).toEqual([]);
  });

  it('crashes the only database for a correctness goal, and not for an outage one', () => {
    const t = orders({ flushEveryMs: 1000 });
    const kindsAt = (goal: Goal) =>
      breakTargets(t, goal, DEFAULT_OPTIONS).find((x) => x.id === 'db')?.kinds;
    expect(kindsAt(GOAL)).toContain('crash');
    expect(kindsAt({ metric: 'errorRate', max: 1 })).not.toContain('crash');
  });

  it('finds the restart that loses saved writes', () => {
    const verdict = verify(orders({ flushEveryMs: 1000 }), GOAL);
    expect(verdict.status).toBe('broken');
    if (verdict.status !== 'broken') return;
    expect(verdict.schedule).toEqual([
      { kind: 'crash', target: 'db', atMs: 10_000, forMs: 500 },
    ]);
    expect(verdict.first?.check).toBe('lostAckedWrite');
  });

  it('holds when each write is on disk before the store answers', () => {
    const t = orders({ flushEveryMs: 1000 });
    const crash: Attack = { kind: 'crash', target: 'db', atMs: 10_000, forMs: 500 };
    expect(trial(t, GOAL, [crash], baseline(t, GOAL)).broke).toBe(true);
    const safe = orders({ flushEveryMs: 0 });
    // The goal is not offered there, but the trial itself loses nothing.
    expect(trial(safe, GOAL, [crash], baseline(safe, GOAL)).runs[0].actual).toBe(0);
  });
});
