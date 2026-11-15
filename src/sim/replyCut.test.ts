import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { replayOf } from './breakit';
import type { Attack } from './breakit';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { checkAtMostOnce, timelineOf } from './oplog';
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

/* A cable that loses the answers coming back: the far end still does the
   work, the caller only finds out when its own timeout gives up, and its
   retry does the work a second time. */

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
  faults: FaultEvent[] = [],
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
        serviceMs: 40,
        serviceCv: 0.3,
        chargeable: 1,
        ...pay,
      }),
    ],
    edges: [edge('client', 'checkout'), edge('checkout', 'pay')],
    ...(faults.length > 0 ? { faults } : {}),
  };
}

const ONCE = { metric: 'doubleCharges', max: 0 } as const;
const WIRE = 'checkout->pay';

function cutFor(fromMs: number, toMs: number, edgeId = WIRE): FaultEvent[] {
  return [
    { atMs: fromMs, action: 'cut-replies', edgeId },
    { atMs: toMs, action: 'restore-replies', edgeId },
  ];
}

function run(
  t: Topology,
  untilMs: number,
  follow = false,
): { engine: Engine; log: OpLog } {
  const engine = new Engine(t, t.seed ?? 1);
  engine.startOpLog(follow ? { follow: 'all' } : {});
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

describe('answers lost on the way back: changes nothing while off', () => {
  it('leaves every preset byte for byte with a cut that never comes due', () => {
    for (const p of PRESETS.slice(0, 8)) {
      const e = p.topology.edges[0];
      if (!e) continue;
      const late: Topology = {
        ...p.topology,
        faults: [{ atMs: 1e9, action: 'cut-replies', edgeId: e.id }],
      };
      expect(hashOf(late, 3)).toBe(hashOf(p.topology, 3));
    }
  });

  it('keeps the snapshot field away while no cable loses answers', () => {
    const engine = new Engine(checkout(), 1);
    engine.advance(100);
    expect('repliesCut' in engine.snapshot()).toBe(false);
    expect(engine.cutReplies(WIRE)).toBe(true);
    expect(engine.cutReplies(WIRE)).toBe(false);
    engine.advance(500);
    const live = engine.snapshot().repliesCut;
    expect(live).toHaveLength(1);
    expect(live?.[0]).toMatchObject({ edgeId: WIRE, sinceMs: 100 });
    expect(live?.[0]?.lost).toBeGreaterThan(0);
    expect(engine.restoreReplies(WIRE)).toBe(true);
    expect('repliesCut' in engine.snapshot()).toBe(false);
  });
});

describe('answers lost on the way back: the work is done, the caller waits', () => {
  it('charges, times out at exactly the deadline, and charges again on the retry', () => {
    const t = checkout({}, {}, cutFor(10_000, 12_000));
    const { log } = run(t, 20_000, true);
    const v = checkAtMostOnce(log, 0, 20_000);
    expect(v.count).toBe(134);
    const first = v.violations[0];
    if (first === undefined) throw new Error('no double charge');
    const tl = timelineOf(log, first.rid);
    const events = tl?.events ?? [];
    const lost = events.find((e) => e.type === 'reply-lost');
    const sent = events.find((e) => e.type === 'send' && e.to === 'pay');
    const gaveUp = events.find((e) => e.type === 'timeout' && e.to === 'pay');
    if (!lost || !sent || !gaveUp) throw new Error('story incomplete');
    // It did the work, then its answer was lost.
    expect(events.some((e) => e.type === 'apply' && e.charge && e.t <= lost.t)).toBe(
      true,
    );
    // The caller hears nothing before its own deadline.
    expect(gaveUp.t).toBe(sent.t + 300);
    expect(events.map((e) => e.type)).toContain('retry');
  });

  it('is stopped by keys where the card is charged', () => {
    const { log } = run(
      checkout({}, { idempotencyKeys: 1 }, cutFor(10_000, 12_000)),
      20_000,
    );
    expect(checkAtMostOnce(log, 0, 20_000).count).toBe(0);
  });

  it('charges nothing twice when nothing retries', () => {
    const { log } = run(checkout({ retries: 0 }, {}, cutFor(10_000, 12_000)), 20_000);
    expect(checkAtMostOnce(log, 0, 20_000).count).toBe(0);
  });

  it('leaves a caller with no timeout waiting for good, every slot held', () => {
    const t = checkout({ timeoutMs: 0, retries: 0 }, {}, cutFor(10_000, 12_000));
    const { engine } = run(t, 20_000);
    const s = engine.snapshot();
    // Its 64 threads each wait on an answer that is never coming, long
    // after the cable carries answers again.
    expect(s.nodes.checkout?.waitingOnDownstream).toBe(64);
    expect(s.nodes.pay?.throughput).toBe(0);
  });

  it('counts the calls still waiting after the cut ends, and only while they wait', () => {
    const t = checkout({ timeoutMs: 0, retries: 0 }, {}, cutFor(10_000, 12_000));
    const { engine } = run(t, 20_000);
    expect(engine.snapshot().repliesStranded).toEqual([{ edgeId: WIRE, waiting: 64 }]);
    expect(engine.strandedReplies()).toEqual([{ edgeId: WIRE, waiting: 64 }]);
    // A crash frees the threads, and the field goes with them.
    engine.injectFailure('checkout', 'crash');
    engine.clearFailure('checkout');
    engine.advance(100);
    expect('repliesStranded' in engine.snapshot()).toBe(false);
  });

  it('counts nobody as stranded when the caller has a timeout', () => {
    const { engine } = run(checkout({}, {}, cutFor(10_000, 12_000)), 20_000);
    expect('repliesStranded' in engine.snapshot()).toBe(false);
  });

  it('counts each lost answer once', () => {
    const t = checkout({ retries: 0 }, {}, [
      { atMs: 10_000, action: 'cut-replies', edgeId: WIRE },
    ]);
    const { engine, log } = run(t, 15_000, true);
    const counted = engine.snapshot().repliesCut?.[0]?.lost ?? 0;
    let logged = 0;
    for (let i = 0; i < log.invokeMs.length; i++) {
      const tl = timelineOf(log, i + log.ridBase);
      logged += tl?.events.filter((e) => e.type === 'reply-lost').length ?? 0;
    }
    expect(counted).toBe(logged);
    expect(counted).toBeGreaterThan(400);
  });
});

describe('answers lost on the way back: recorded, replayed and validated', () => {
  it('replays a recorded cut exactly after Reset', () => {
    const live = new Engine(checkout(), 9);
    for (let i = 0; i < 30; i++) live.advance(100);
    expect(live.recordCutReplies(WIRE)).toBe(true);
    for (let i = 0; i < 20; i++) live.advance(100);
    expect(live.recordRestoreReplies(WIRE)).toBe(true);
    expect(live.recordRestoreReplies(WIRE)).toBe(false);
    for (let i = 0; i < 30; i++) live.advance(100);
    const first = JSON.stringify(live.snapshot());
    expect(live.faultSchedule()).toEqual(cutFor(3000, 5000));
    live.reset();
    for (let i = 0; i < 80; i++) live.advance(100);
    expect(JSON.stringify(live.snapshot())).toBe(first);
  });

  it('heals a cable removed by an edit, in the schedule too', () => {
    const t = checkout();
    const engine = new Engine(t, 1);
    engine.advance(100);
    engine.recordCutReplies(WIRE);
    engine.advance(100);
    engine.setTopology({ ...t, edges: [t.edges[0] as SimEdge] });
    expect(engine.activeReplyCuts()).toEqual([]);
    expect(engine.faultSchedule().map((f) => f.action)).toEqual([
      'cut-replies',
      'restore-replies',
    ]);
  });

  it('keeps a cut cable and lost answers apart on one cable', () => {
    const engine = new Engine(checkout(), 1);
    engine.advance(100);
    engine.recordCutEdge(WIRE);
    engine.recordCutReplies(WIRE);
    engine.recordRestoreEdge(WIRE);
    expect(engine.activeReplyCuts().map((r) => r.edgeId)).toEqual([WIRE]);
    expect(engine.activeCuts()).toEqual([]);
  });

  it('refuses one on a cable that is not there', () => {
    const why: string[] = [];
    const kept = sanitizeFaults(
      [
        { atMs: 0, action: 'cut-replies', edgeId: 'nope' },
        { atMs: 0, action: 'cut-replies' },
        { atMs: 1, action: 'cut-replies', edgeId: WIRE, rate: 1 },
      ],
      checkout(),
      (i, w) => why.push(`${i} ${w}`),
    );
    expect(kept).toEqual([{ atMs: 1, action: 'cut-replies', edgeId: WIRE }]);
    expect(why).toEqual([
      "0 names edge 'nope', but there is no such edge.",
      '1 needs `edgeId`.',
    ]);
  });
});

describe('answers lost on the way back: the search', () => {
  it('finds a cable that loses its answers and charges twice', () => {
    const v = verify(checkout(), ONCE, { kinds: ['cut-replies'] });
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule.map((a) => a.kind)).toEqual(['cut-replies']);
    const first = v.first;
    if (first?.check !== 'atMostOnce') throw new Error('no double charge');
    const tl = followRequest(v.replay, first.rid);
    expect(tl?.events.some((e) => e.type === 'reply-lost')).toBe(true);
  }, 60_000);

  it('holds once the part that charges keeps keys', () => {
    const v = verify(checkout({}, { idempotencyKeys: 1 }), ONCE, {
      kinds: ['cut-replies'],
      budget: 20,
    });
    expect(v.status).toBe('held');
  }, 60_000);

  it('schedules the cut and its restore', () => {
    const attack: Attack = {
      kind: 'cut-replies',
      target: WIRE,
      atMs: 10_000,
      forMs: 2000,
    };
    expect(replayOf(checkout(), [attack], 1).faults).toEqual(cutFor(10_000, 12_000));
  });
});
