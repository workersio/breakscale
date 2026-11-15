import { describe, expect, it } from 'vitest';
import { playBaseline, replayOf, trial } from './breakit';
import type { Attack, SeedRun } from './breakit';
import type { Goal } from './challenge';
import { Engine } from './engine';
import { checkLostAckedWrites } from './oplog';
import type { LostWrite } from './oplog';
import { PRESETS, defaultConfig } from './presets';
import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './types';
import { followRequest, verify, verifyErrors } from './verify';

/**
 * The lost acknowledged write check.
 *
 * The fixture is the smallest design that can lose one: a client, an api,
 * a write-behind cache that says "saved" in a millisecond and flushes 200ms
 * later, and the database behind it. Crash the cache, or stop its flushes
 * reaching the database, and writes the client already heard succeed are
 * gone.
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

function edge(from: string, to: string): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1 };
}

function writeBehind(buf: Partial<NodeConfig> = {}): Topology {
  return {
    nodes: [
      node('client', 'client', { rps: 100 }),
      node('api', 'service', { capacity: 32, serviceMs: 5 }),
      node('buf', 'writebehind', {
        capacity: 256,
        serviceMs: 1,
        queueLimit: 512,
        flushDelayMs: 200,
        ...buf,
      }),
      node('db', 'db', { capacity: 12, serviceMs: 15, serviceCv: 0.6, queueLimit: 96 }),
    ],
    edges: [edge('client', 'api'), edge('api', 'buf'), edge('buf', 'db')],
  };
}

/** The same api writing straight to the database. */
function writeThrough(): Topology {
  return {
    nodes: [
      node('client', 'client', { rps: 100 }),
      node('api', 'service', { capacity: 32, serviceMs: 5 }),
      node('db', 'db', { capacity: 12, serviceMs: 15 }),
    ],
    edges: [edge('client', 'api'), edge('api', 'db')],
  };
}

const GOAL = { metric: 'lostAckedWrites', max: 0 } as const;
const TALLY: Goal = { metric: 'lostWrites', max: 0 };

function crash(target: string, forMs = 500): Attack {
  return { kind: 'crash', target, atMs: 10_000, forMs };
}

function baseline(t: Topology, goal: Goal = GOAL): SeedRun[] {
  const it = playBaseline(t, goal);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value.runs;
  }
}

function lostWrites(run: SeedRun): LostWrite[] {
  return (run.violations ?? []).flatMap((v) =>
    v.check === 'lostAckedWrite' ? [v] : [],
  );
}

describe('no lost acknowledged writes', () => {
  it('loses nothing with no faults', () => {
    const runs = baseline(writeBehind());
    expect(runs.map((r) => r.actual)).toEqual([0, 0, 0]);
    expect(runs.map((r) => r.pending)).toEqual([0, 0, 0]);
    for (const r of runs) expect(r.checked).toBeGreaterThan(2900);
  });

  it('loses the buffered writes when the cache crashes, and only those', () => {
    const t = writeBehind();
    const result = trial(t, GOAL, [crash('buf')], baseline(t));
    expect(result.broke).toBe(true);
    expect(result.runs.map((r) => r.actual)).toEqual([25, 22]);
    // The same writes the tally counts here, since the client's answer
    // rides on the cache's ack alone.
    const tally = trial(t, TALLY, [crash('buf')], baseline(t, TALLY));
    expect(tally.runs.map((r) => r.actual)).toEqual([25, 22]);
    for (const v of lostWrites(result.runs[0])) {
      expect(v.nodeId).toBe('buf');
      expect(v.reason).toBe('crashed');
      expect(v.ackedMs).toBeGreaterThanOrEqual(v.bufferedMs);
      // Saved before the crash and lost during it. After the restart the
      // cache is empty, and the writes it takes from then on land.
      expect(v.bufferedMs).toBeLessThan(10_000);
      expect(v.lostMs).toBeGreaterThanOrEqual(10_000);
      expect(v.lostMs).toBeLessThan(10_500);
    }
  });

  it('loses the writes whose flush fails, with the reason', () => {
    const t = writeBehind();
    const errors: Attack = {
      kind: 'errors',
      target: 'db',
      rate: 0.5,
      atMs: 10_000,
      forMs: 2000,
    };
    const result = trial(t, GOAL, [errors], baseline(t));
    expect(result.runs.map((r) => r.actual)).toEqual([97, 109]);
    expect(new Set(lostWrites(result.runs[0]).map((v) => v.reason))).toEqual(
      new Set(['error']),
    );
  });

  it('counts a write still waiting to flush at the end as pending, not lost', () => {
    // Flushed 8s later, so the last writes of the window are still in the
    // buffer when the run stops. The tally counts them as lost; they are not.
    const t = writeBehind({ flushDelayMs: 8000, capacity: 2000, queueLimit: 4000 });
    const runs = baseline(t);
    expect(runs.map((r) => r.actual)).toEqual([0, 0, 0]);
    expect(runs.map((r) => r.pending)).toEqual([280, 265, 286]);
    expect(baseline(t, TALLY).map((r) => r.actual)).toEqual([574, 564, 585]);
  });

  it('a store that saves before answering loses nothing it acknowledged', () => {
    // A crash fails the writes in flight where the client hears it, and
    // the database comes back with everything it had said was saved.
    const t = writeThrough();
    const result = trial(t, GOAL, [crash('db')], baseline(t));
    expect(result.broke).toBe(false);
    expect(result.runs[0].actual).toBe(0);
    expect(result.runs[0].failed).toBeGreaterThan(0);
    expect(verifyErrors(t, GOAL)[0]).toMatch(/saved before it is/);
  });

  it('a flush the cache stopped waiting for still saves the write when the store applies it', () => {
    // The cache gives up on the database after 100ms and does not try again,
    // but the slowed database still writes every one of those copies.
    const t = writeBehind({ timeoutMs: 100, retries: 0 });
    const slow: Attack = {
      kind: 'slow',
      target: 'db',
      factor: 10,
      atMs: 10_000,
      forMs: 1000,
    };
    const result = trial(t, GOAL, [slow], baseline(t));
    expect(result.runs[0].actual).toBe(0);
    expect(result.runs[0].checked).toBeGreaterThan(2900);
  });

  it('names the part whose failure lost the write', () => {
    // No flush delay, so the copies are at the database when it crashes.
    const t = writeBehind({ flushDelayMs: 0 });
    const result = trial(t, GOAL, [crash('db')], baseline(t));
    const lost = lostWrites(result.runs[0]);
    expect(lost.length).toBeGreaterThan(0);
    expect(new Set(lost.map((v) => `${v.lostAt} ${v.reason}`))).toEqual(
      new Set(['db crashed']),
    );
    const cache = lostWrites(
      trial(writeBehind(), GOAL, [crash('buf')], baseline(writeBehind())).runs[0],
    );
    expect(new Set(cache.map((v) => v.lostAt))).toEqual(new Set(['buf']));
  });

  it('records the same log every time', () => {
    const play = () => {
      const engine = new Engine(replayOf(writeBehind(), [crash('buf')], 3), 3);
      engine.startOpLog({ follow: 'all' });
      for (let t = 0; t < 12_000; t += 100) engine.advance(100);
      const log = engine.readOpLog();
      if (log === null) throw new Error('no log');
      return { log, check: checkLostAckedWrites(log, 0, 12_000) };
    };
    const a = play();
    expect(a.check.count).toBeGreaterThan(0);
    expect(play()).toEqual(a);
  });
});

describe('verify: lostAckedWrites', () => {
  it('finds the smallest schedule, and the lost write can be followed', () => {
    const v = verify(writeBehind(), GOAL);
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    // Every request passes through the cache, so by default the search
    // leaves it whole and cuts its flushes off instead.
    expect(v.schedule).toEqual([
      { kind: 'cut', target: 'buf->db', atMs: 10_000, forMs: 500 },
    ]);
    expect(v.minimal).toBe(true);
    expect(v.measured.actual).toBe(60);
    expect(v.withoutFaults.actual).toBe(0);
    const first = v.first;
    if (first?.check !== 'lostAckedWrite') throw new Error('no first lost write');
    expect(first.reason).toBe('partitioned');
    const tl = followRequest(v.replay, first.rid);
    if (tl === null) throw new Error('request not found');
    const story = tl.events.flatMap((e) =>
      e.type === 'buffered' || e.type === 'dropped'
        ? [{ type: e.type, t: e.t }]
        : e.type === 'answer' && e.heard === 'client'
          ? [{ type: e.ok ? 'told saved' : 'told failed', t: e.t }]
          : [],
    );
    expect(story).toEqual([
      { type: 'buffered', t: first.bufferedMs },
      { type: 'told saved', t: first.ackedMs },
      { type: 'dropped', t: first.lostMs },
    ]);
  });

  it('crashes the cache itself when single points are allowed', () => {
    const v = verify(writeBehind(), GOAL, { includeSinglePoints: true });
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule).toEqual([crash('buf')]);
    expect(v.measured.actual).toBe(25);
  });

  it('gives the same verdict every time', () => {
    expect(verify(writeBehind(), GOAL, { budget: 20 })).toEqual(
      verify(writeBehind(), GOAL, { budget: 20 }),
    );
  });

  it('breaks the resilient delivery example by crashing its write buffer', () => {
    const p = PRESETS.find((x) => x.id === 'resilient-delivery');
    if (!p) throw new Error('no resilient-delivery preset');
    const t = structuredClone(p.topology);
    const v = verify(t, GOAL);
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule).toEqual([crash('writebuf')]);
    expect(v.measured.actual).toBe(58);
  });
});
