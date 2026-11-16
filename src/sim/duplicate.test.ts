import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BREAK_END_MS,
  BREAK_WARMUP_MS,
  replayOf,
  runSearch,
  DEFAULT_OPTIONS,
} from './breakit';
import type { Attack } from './breakit';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { checkAtMostOnce } from './oplog';
import type { OpLog } from './oplog';
import { PRESETS, defaultConfig } from './presets';
import type {
  FaultEvent,
  NodeConfig,
  NodeKind,
  SimEdge,
  SimNode,
  Topology,
} from './types';
import { followRequest, verify } from './verify';

/* A cable that delivers some requests twice: the run is unchanged while it
   is off, the second copy does the work again, and idempotency keys at the
   part that charges are what stop it charging twice. */

function node(id: string, kind: NodeKind, config: Partial<NodeConfig> = {}): SimNode {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...config },
  };
}

function edge(from: string, to: string): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1 };
}

function checkout(
  api: Partial<NodeConfig> = {},
  pay: Partial<NodeConfig> = {},
): Topology {
  return {
    nodes: [
      node('client', 'client', { rps: 100 }),
      node('checkout', 'service', {
        capacity: 64,
        serviceMs: 5,
        timeoutMs: 300,
        retries: 2,
        ...api,
      }),
      node('pay', 'service', {
        capacity: 64,
        serviceMs: 100,
        serviceCv: 0.3,
        chargeable: 1,
        ...pay,
      }),
    ],
    edges: [edge('client', 'checkout'), edge('checkout', 'pay')],
  };
}

const ONCE = { metric: 'doubleCharges', max: 0 } as const;
const RETRIES_ONLY = ['crash', 'crash-instance', 'slow', 'errors', 'cut'] as const;

function run(t: Topology, untilMs: number): { engine: Engine; log: OpLog } {
  const engine = new Engine(t, t.seed ?? 1);
  engine.startOpLog();
  while (engine.now < untilMs - 1e-9)
    engine.advance(Math.min(100, untilMs - engine.now));
  return { engine, log: engine.readOpLog() as OpLog };
}

function hashOf(t: Topology, seed: number): string {
  const engine = new Engine(t, seed);
  const h = createHash('sha256');
  for (let i = 1; i <= 600; i++) {
    engine.advance(1000 / 60);
    if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
  }
  return h.digest('hex');
}

/** Requests sent in [from, to) charged more than once, counted by hand. */
function chargedTwiceByHand(log: OpLog, from: number, to: number): number {
  const per = new Map<number, number>();
  for (const rid of log.charges.rid) per.set(rid, (per.get(rid) ?? 0) + 1);
  let n = 0;
  for (const [rid, c] of per) {
    const at = log.invokeMs[rid - log.ridBase];
    if (c > 1 && at >= from && at < to) n++;
  }
  return n;
}

function window(
  rate: number,
  edgeId: string,
  fromMs: number,
  toMs: number,
): FaultEvent[] {
  return [
    { atMs: fromMs, action: 'duplicate', edgeId, rate },
    { atMs: toMs, action: 'undup', edgeId },
  ];
}

describe('duplicate delivery: changes nothing while off', () => {
  it('leaves every preset byte for byte with a duplicate that never comes due', () => {
    for (const p of PRESETS.slice(0, 8)) {
      const e = p.topology.edges[0];
      if (!e) continue;
      const late: Topology = {
        ...p.topology,
        faults: [{ atMs: 1e9, action: 'duplicate', edgeId: e.id, rate: 1 }],
      };
      expect(hashOf(late, 3)).toBe(hashOf(p.topology, 3));
    }
  });

  it('runs on after it stops exactly as a run that never draws for it', () => {
    // Off again before anything crosses: no draw was made, so nothing moves.
    const t = checkout();
    const quiet: Topology = {
      ...t,
      faults: window(0.5, 'checkout->pay', 0, 0),
    };
    expect(hashOf(quiet, 5)).toBe(hashOf(t, 5));
  });

  it('keeps the snapshot field away while no cable duplicates', () => {
    const engine = new Engine(checkout(), 1);
    engine.advance(100);
    expect('duplicating' in engine.snapshot()).toBe(false);
    engine.duplicateEdge('checkout->pay', 0.25);
    engine.advance(100);
    const live = engine.snapshot().duplicating;
    expect(live).toHaveLength(1);
    expect(live?.[0]).toMatchObject({
      edgeId: 'checkout->pay',
      rate: 0.25,
      sinceMs: 100,
    });
    expect(live?.[0]?.delivered).toBeGreaterThan(0);
    engine.undupEdge('checkout->pay');
    expect('duplicating' in engine.snapshot()).toBe(false);
  });
});

describe('duplicate delivery: the second copy does the work again', () => {
  it('charges every payment twice on a cable that duplicates them all', () => {
    const t: Topology = {
      ...checkout({ retries: 0 }),
      faults: window(1, 'checkout->pay', 10_000, 20_000),
    };
    const { engine, log } = run(t, 25_000);
    const counted = checkAtMostOnce(log, 10_000, 20_000);
    // Every request sent in the window crossed it; all were delivered twice.
    let sent = 0;
    for (const at of log.invokeMs) if (at >= 10_000 && at < 20_000) sent++;
    expect(sent).toBeGreaterThan(900);
    // A request sent just before the window can cross it just after 10s.
    expect(counted.count).toBe(chargedTwiceByHand(log, 10_000, 20_000));
    expect(counted.count).toBe(sent);
    expect(engine.snapshot().system.errorRate).toBe(0);
  });

  it('is stopped by idempotency keys where the card is charged', () => {
    const t: Topology = {
      ...checkout({ retries: 0 }, { idempotencyKeys: 1 }),
      faults: window(1, 'checkout->pay', 10_000, 20_000),
    };
    const { log } = run(t, 25_000);
    expect(checkAtMostOnce(log, 0, 25_000).count).toBe(0);
  });

  it('is not stopped by keys in front of the part that charges', () => {
    const t: Topology = {
      ...checkout({ retries: 0, idempotencyKeys: 1 }),
      faults: window(1, 'checkout->pay', 10_000, 20_000),
    };
    const { log } = run(t, 25_000);
    expect(checkAtMostOnce(log, 10_000, 20_000).count).toBeGreaterThan(900);
  });

  it('carries the copy downstream: a duplicate into the caller charges twice too', () => {
    const t: Topology = {
      ...checkout({ retries: 0 }),
      faults: window(1, 'client->checkout', 10_000, 20_000),
    };
    const { log } = run(t, 25_000);
    const counted = checkAtMostOnce(log, 10_000, 20_000).count;
    expect(counted).toBeGreaterThan(900);
    expect(counted).toBe(chargedTwiceByHand(log, 10_000, 20_000));
  });

  it('tells the story of one request delivered twice', () => {
    const t: Topology = {
      ...checkout({ retries: 0 }),
      faults: window(1, 'checkout->pay', 10_000, 20_000),
    };
    const { log } = run(t, 25_000);
    const v = checkAtMostOnce(log, 10_000, 20_000).violations[0];
    if (v === undefined) throw new Error('no double charge');
    const tl = followRequest(t, v.rid);
    if (tl === null) throw new Error('no story');
    const types = tl.events.map((e) => e.type);
    expect(types).toContain('duplicate');
    expect(types).not.toContain('retry');
    expect(tl.events.filter((e) => e.type === 'apply' && e.charge)).toHaveLength(2);
    // The copy's answer goes to nobody, the first one's to the client.
    expect(
      tl.events.filter((e) => e.type === 'answer' && e.heard === 'nobody'),
    ).toHaveLength(1);
    expect(
      tl.events.filter((e) => e.type === 'answer' && e.heard === 'client'),
    ).toHaveLength(1);
  });

  it('delivers about its share, from the seeded stream', () => {
    const t: Topology = {
      ...checkout({ retries: 0 }),
      faults: [{ atMs: 0, action: 'duplicate', edgeId: 'checkout->pay', rate: 0.1 }],
    };
    const a = run(t, 20_000).engine.snapshot().duplicating?.[0]?.delivered ?? 0;
    const b = run(t, 20_000).engine.snapshot().duplicating?.[0]?.delivered ?? 0;
    expect(a).toBe(b);
    // 100 requests a second for 20s, a tenth of them twice.
    expect(a).toBeGreaterThan(150);
    expect(a).toBeLessThan(250);
  });
});

describe('duplicate delivery: recorded, replayed and validated', () => {
  it('replays a recorded duplicate exactly after Reset', () => {
    const live = new Engine(checkout({ retries: 0 }), 9);
    for (let i = 0; i < 30; i++) live.advance(100);
    expect(live.recordDuplicateEdge('checkout->pay', 0.05)).toBe(true);
    expect(live.recordDuplicateEdge('checkout->pay', 0.05)).toBe(false);
    for (let i = 0; i < 30; i++) live.advance(100);
    expect(live.recordUndupEdge('checkout->pay')).toBe(true);
    expect(live.recordUndupEdge('checkout->pay')).toBe(false);
    for (let i = 0; i < 20; i++) live.advance(100);
    const first = JSON.stringify(live.snapshot());
    expect(live.faultSchedule()).toEqual([
      { atMs: 3000, action: 'duplicate', edgeId: 'checkout->pay', rate: 0.05 },
      { atMs: 6000, action: 'undup', edgeId: 'checkout->pay' },
    ]);
    live.reset();
    for (let i = 0; i < 80; i++) live.advance(100);
    expect(JSON.stringify(live.snapshot())).toBe(first);
  });

  it('heals a duplicating cable removed by an edit, in the schedule too', () => {
    const t = checkout();
    const engine = new Engine(t, 1);
    engine.advance(100);
    engine.recordDuplicateEdge('checkout->pay', 0.25);
    engine.advance(100);
    engine.setTopology({ ...t, edges: [t.edges[0] as SimEdge] });
    expect(engine.activeDuplicates()).toEqual([]);
    expect(engine.faultSchedule().map((f) => f.action)).toEqual(['duplicate', 'undup']);
  });

  it('keeps a cut and a duplicate apart on one cable', () => {
    const engine = new Engine(checkout(), 1);
    engine.advance(100);
    engine.recordCutEdge('checkout->pay');
    engine.recordDuplicateEdge('checkout->pay', 0.1);
    engine.recordRestoreEdge('checkout->pay');
    expect(engine.activeDuplicates().map((d) => d.rate)).toEqual([0.1]);
    expect(engine.activeCuts()).toEqual([]);
  });

  it('refuses a share that is not above 0 and at most 1', () => {
    const t = checkout();
    const why: string[] = [];
    const kept = sanitizeFaults(
      [
        { atMs: 0, action: 'duplicate', edgeId: 'checkout->pay', rate: 0 },
        { atMs: 0, action: 'duplicate', edgeId: 'checkout->pay', rate: 1.5 },
        { atMs: 0, action: 'duplicate', edgeId: 'checkout->pay' },
        { atMs: 0, action: 'duplicate', edgeId: 'nope', rate: 0.1 },
        { atMs: 0, action: 'duplicate', edgeId: 'checkout->pay', rate: 0.1, extra: 1 },
        { atMs: 5, action: 'undup', edgeId: 'checkout->pay', rate: 0.1 },
      ],
      t,
      (i, w) => why.push(`${i} ${w}`),
    );
    expect(kept).toEqual([
      { atMs: 0, action: 'duplicate', edgeId: 'checkout->pay', rate: 0.1 },
      { atMs: 5, action: 'undup', edgeId: 'checkout->pay' },
    ]);
    expect(why).toEqual([
      '0 has rate 0; give the share of requests delivered twice, above 0 and at most 1.',
      '1 has rate 1.5; give the share of requests delivered twice, above 0 and at most 1.',
      '2 has rate undefined; give the share of requests delivered twice, above 0 and at most 1.',
      "3 names edge 'nope', but there is no such edge.",
    ]);
    const engine = new Engine(t, 1);
    expect(engine.duplicateEdge('checkout->pay', 0)).toBe(false);
    expect(engine.duplicateEdge('nope', 0.5)).toBe(false);
  });
});

describe('duplicate delivery: the search', () => {
  it('breaks a design with no retries at all by delivering a payment twice', () => {
    const v = verify(checkout({ retries: 0 }), ONCE);
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule.map((a) => a.kind)).toEqual(['duplicate']);
    expect(v.minimal).toBe(true);
    const first = v.first;
    if (first?.check !== 'atMostOnce') throw new Error('no double charge');
    const tl = followRequest(v.replay, first.rid);
    expect(tl?.events.some((e) => e.type === 'duplicate')).toBe(true);
  }, 60_000);

  it('holds once the part that charges keeps keys', () => {
    const v = verify(checkout({ retries: 0 }, { idempotencyKeys: 1 }), ONCE, {
      budget: 30,
    });
    expect(v.status).toBe('held');
    if (v.status === 'held') expect(v.nothingRetries).toBeUndefined();
  }, 60_000);

  it('says nothing retries only when no cable was tried delivering twice', () => {
    const v = verify(checkout({ retries: 0 }), ONCE, {
      budget: 5,
      kinds: [...RETRIES_ONLY],
    });
    expect(v.status).toBe('held');
    if (v.status === 'held') expect(v.nothingRetries).toBe(true);
  }, 60_000);

  it('is only tried for the double-charge goal, and leaves other searches alone', () => {
    const t = checkout();
    const up = { metric: 'errorRate', max: 1 } as const;
    const all = runSearch(t, up, { ...DEFAULT_OPTIONS, budget: 12 });
    const without = runSearch(t, up, {
      ...DEFAULT_OPTIONS,
      kinds: [...RETRIES_ONLY],
      budget: 12,
    });
    expect(all).toEqual(without);
  }, 60_000);

  it('turns into a schedule that replays the same double charges', () => {
    const attack: Attack = {
      kind: 'duplicate',
      target: 'checkout->pay',
      rate: 0.25,
      atMs: 10_000,
      forMs: 5000,
    };
    const replay = replayOf(checkout({ retries: 0 }), [attack], 1);
    expect(replay.faults).toEqual(window(0.25, 'checkout->pay', 10_000, 15_000));
    const a = checkAtMostOnce(run(replay, 40_000).log, BREAK_WARMUP_MS, BREAK_END_MS);
    const b = checkAtMostOnce(run(replay, 40_000).log, BREAK_WARMUP_MS, BREAK_END_MS);
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(50);
  });
});
