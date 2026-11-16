import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, replayOf, runSearch } from './breakit';
import type { Attack } from './breakit';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { OUTCOME_OK, checkAtMostOnce, timelineOf } from './oplog';
import type { OpLog, OpLogOptions } from './oplog';
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

/* A node that stops for a while and carries on: nothing fails and nothing is
   lost, its work finishes late by the length of the pause, and the callers
   whose timeouts fire meanwhile send the same call again, which charges
   twice unless the part that charges keeps idempotency keys. */

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

function pauseAt(nodeId: string, atMs: number, pauseMs: number): FaultEvent {
  return { atMs, action: 'inject', nodeId, kind: 'pause', opts: { pauseMs } };
}

function run(
  t: Topology,
  untilMs: number,
  opts: OpLogOptions = {},
): { engine: Engine; log: OpLog } {
  const engine = new Engine(t, t.seed ?? 1);
  engine.startOpLog(opts);
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

/** When each request was charged, by request id: its first charge. */
function chargedAt(log: OpLog): Map<number, number> {
  const out = new Map<number, number>();
  const c = log.charges;
  for (let i = 0; i < c.rid.length; i++) {
    if (!out.has(c.rid[i])) out.set(c.rid[i], c.t[i]);
  }
  return out;
}

describe('pause: changes nothing while off', () => {
  it('leaves every preset byte for byte with a pause that never comes due', () => {
    for (const p of PRESETS.slice(0, 8)) {
      const n = p.topology.nodes.find((x) => x.kind !== 'client');
      if (!n) continue;
      const late: Topology = { ...p.topology, faults: [pauseAt(n.id, 1e9, 2000)] };
      expect(hashOf(late, 3)).toBe(hashOf(p.topology, 3));
    }
  });

  it('draws nothing: a run after a pause that held no work is the same run', () => {
    // A pause on a part nothing calls holds nothing, so nothing moves.
    const t = checkout();
    const idle: Topology = {
      ...t,
      nodes: [...t.nodes, node('spare', 'service')],
      faults: [pauseAt('spare', 1000, 2000)],
    };
    const without: Topology = { ...t, nodes: [...t.nodes, node('spare', 'service')] };
    const strip = (s: string) => s.replace(/"activeFailures":\[[^\]]*\]/g, '');
    const a = new Engine(idle, 4);
    const b = new Engine(without, 4);
    for (let i = 0; i < 60; i++) {
      a.advance(100);
      b.advance(100);
      expect(strip(JSON.stringify(a.snapshot()))).toBe(
        strip(JSON.stringify(b.snapshot())),
      );
    }
  });
});

describe('pause: the work waits and finishes late', () => {
  it('finishes what was in service exactly as late as the pause was long', () => {
    // No timeout and no retries, so only the pause moves anything.
    const quiet = { timeoutMs: 0, retries: 0 };
    const follow = { follow: 'all' } as const;
    const plain = run(checkout(quiet), 16_000, follow).log;
    const paused = run(
      checkout(quiet, {}, [pauseAt('pay', 10_000, 2000)]),
      16_000,
      follow,
    ).log;
    const before = chargedAt(plain);
    const after = chargedAt(paused);
    let inService = 0;
    for (const [rid, t] of before) {
      if (t <= 10_000) {
        // Done before the pause: untouched.
        expect(after.get(rid)).toBe(t);
        continue;
      }
      const tl = timelineOf(plain, rid);
      const sent = tl?.events.find((e) => e.type === 'send' && e.to === 'pay')?.t;
      if (sent === undefined || sent >= 10_000) continue;
      // In service when it stopped: the same draw, 2000ms later.
      inService++;
      expect(after.get(rid)).toBeCloseTo(t + 2000, 9);
    }
    // 100 requests a second for 40ms each: about 4 were in service.
    expect(inService).toBeGreaterThanOrEqual(2);
    // Nothing is charged while it is stopped.
    for (const t of after.values()) expect(t > 10_000 && t < 12_000).toBe(false);
  });

  it('holds new requests at the door and counts them as waiting', () => {
    const engine = new Engine(checkout({ timeoutMs: 0, retries: 0 }), 1);
    for (let i = 0; i < 100; i++) engine.advance(100);
    engine.injectFailure('pay', 'pause', { pauseMs: 2000 });
    for (let i = 0; i < 10; i++) engine.advance(100);
    const s = engine.snapshot();
    // Every thread the caller holds waits on one call to it: in service
    // there when it stopped, or at its door since.
    const pay = s.nodes.pay;
    expect((pay?.queued ?? 0) + (pay?.inFlight ?? 0)).toBe(
      s.nodes.checkout?.waitingOnDownstream,
    );
    expect(pay?.queued).toBeGreaterThan(40);
    expect(pay?.throughput).toBe(0);
    expect(s.activeFailures).toEqual([
      { nodeId: 'pay', kind: 'pause', sinceMs: 10_000, pauseMs: 2000 },
    ]);
    for (let i = 0; i < 15; i++) engine.advance(100);
    const later = engine.snapshot();
    expect(later.activeFailures).toEqual([]);
    expect(later.nodes.pay?.queued).toBe(0);
    // Nothing failed at it. Its caller's own line did fill up and turn
    // requests away, which is the pause showing upstream.
    expect(later.failuresByReason.crashed).toBe(0);
    expect(later.nodes.pay?.errorRate).toBe(0);
  });

  it('ends early on a clear, owing only the time it was stopped', () => {
    const quiet = { timeoutMs: 0, retries: 0 };
    const follow = { follow: 'all' } as const;
    const plain = run(checkout(quiet), 16_000, follow).log;
    const cleared = run(
      checkout(quiet, {}, [
        pauseAt('pay', 10_000, 5000),
        { atMs: 10_500, action: 'clear', nodeId: 'pay' },
      ]),
      16_000,
      follow,
    ).log;
    const after = chargedAt(cleared);
    let n = 0;
    for (const [rid, t] of chargedAt(plain)) {
      if (t <= 10_000) continue;
      const sent = timelineOf(plain, rid)?.events.find(
        (e) => e.type === 'send' && e.to === 'pay',
      )?.t;
      if (sent === undefined || sent >= 10_000) continue;
      n++;
      expect(after.get(rid)).toBeCloseTo(t + 500, 9);
    }
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('holds the answers a paused caller gets until it carries on', () => {
    const t = checkout({ timeoutMs: 0, retries: 0 }, {}, [
      pauseAt('checkout', 10_000, 1000),
    ]);
    const { log } = run(t, 15_000);
    let during = 0;
    let after = 0;
    log.answeredMs.forEach((at, i) => {
      // The client's own timeout still fires meanwhile; only a success
      // means the caller passed an answer on.
      if (log.outcome[i] !== OUTCOME_OK) return;
      if (at > 10_000 && at < 11_000) during++;
      if (at >= 11_000 && at < 11_100) after++;
    });
    expect(during).toBe(0);
    // What it held, answered the moment it carries on, plus what it starts.
    expect(after).toBeGreaterThan(50);
  });
});

describe('pause: callers give up and send it again', () => {
  const window = [pauseAt('pay', 10_000, 2000)];

  it('charges twice when the caller retries while the first try is stalled', () => {
    const { engine, log } = run(checkout({}, {}, window), 20_000);
    const counted = checkAtMostOnce(log, 0, 20_000);
    expect(counted.count).toBe(48);
    expect(engine.snapshot().failuresByReason.timeout).toBe(111);
  });

  it('is stopped by keys where the card is charged', () => {
    const { log } = run(checkout({}, { idempotencyKeys: 1 }, window), 20_000);
    expect(checkAtMostOnce(log, 0, 20_000).count).toBe(0);
  });

  it('is not stopped by keys in front of the part that charges', () => {
    const { log } = run(checkout({ idempotencyKeys: 1 }, {}, window), 20_000);
    expect(checkAtMostOnce(log, 0, 20_000).count).toBe(48);
  });

  it('charges nothing twice when nothing retries', () => {
    const { log } = run(checkout({ retries: 0 }, {}, window), 20_000);
    expect(checkAtMostOnce(log, 0, 20_000).count).toBe(0);
  });

  it('tells the story: a timeout, a retry, and both tries charged', () => {
    const t = checkout({}, {}, window);
    const v = checkAtMostOnce(run(t, 20_000).log, 0, 20_000).violations[0];
    if (v === undefined) throw new Error('no double charge');
    const tl = followRequest(t, v.rid);
    const types = tl?.events.map((e) => e.type) ?? [];
    expect(types).toContain('timeout');
    expect(types).toContain('retry');
    const charges = tl?.events.filter((e) => e.type === 'apply' && e.charge) ?? [];
    expect(charges.length).toBeGreaterThanOrEqual(2);
    // The first try was stalled, so it finished after the pause.
    expect(charges.every((e) => e.t >= 12_000)).toBe(true);
  });
});

describe('pause: recorded, replayed and validated', () => {
  it('replays a recorded pause exactly after Reset', () => {
    const live = new Engine(checkout(), 9);
    for (let i = 0; i < 30; i++) live.advance(100);
    live.recordFailure('pay', 'pause', { pauseMs: 1000 });
    for (let i = 0; i < 50; i++) live.advance(100);
    const first = JSON.stringify(live.snapshot());
    expect(live.faultSchedule()).toEqual([pauseAt('pay', 3000, 1000)]);
    live.reset();
    for (let i = 0; i < 80; i++) live.advance(100);
    expect(JSON.stringify(live.snapshot())).toBe(first);
  });

  it('records the length it used when none or a bad one was given', () => {
    for (const kind of ['pause', 'restart'] as const) {
      for (const opts of [undefined, { pauseMs: 0, downMs: -5 }]) {
        const live = new Engine(checkout(), 9);
        for (let i = 0; i < 30; i++) live.advance(100);
        live.recordFailure('pay', kind, opts);
        for (let i = 0; i < 50; i++) live.advance(100);
        const first = JSON.stringify(live.snapshot());
        const used = kind === 'pause' ? { pauseMs: 2000 } : { downMs: 2000 };
        expect(live.faultSchedule()).toEqual([
          { atMs: 3000, action: 'inject', nodeId: 'pay', kind, opts: used },
        ]);
        expect(sanitizeFaults(live.faultSchedule(), checkout())).toHaveLength(1);
        live.reset();
        for (let i = 0; i < 80; i++) live.advance(100);
        expect(JSON.stringify(live.snapshot())).toBe(first);
      }
    }
  });

  it('hands everything it held back when a crash replaces it', () => {
    const engine = new Engine(checkout(), 1);
    for (let i = 0; i < 100; i++) engine.advance(100);
    engine.injectFailure('pay', 'pause', { pauseMs: 5000 });
    for (let i = 0; i < 10; i++) engine.advance(100);
    engine.injectFailure('pay', 'crash');
    for (let i = 0; i < 10; i++) engine.advance(100);
    engine.clearFailure('pay');
    for (let i = 0; i < 50; i++) engine.advance(100);
    const s = engine.snapshot();
    expect(s.failuresByReason.crashed).toBeGreaterThan(0);
    // Nothing is left stuck at the door or holding a slot for good.
    expect(s.nodes.pay?.queued).toBe(0);
    expect(s.nodes.checkout?.waitingOnDownstream ?? 0).toBeLessThan(10);
    expect(s.nodes.pay?.throughput).toBeGreaterThan(80);
  });

  it('answers what it held as gone when an edit removes it', () => {
    const t = checkout({ timeoutMs: 0, retries: 0 });
    const engine = new Engine(t, 1);
    for (let i = 0; i < 100; i++) engine.advance(100);
    engine.injectFailure('pay', 'pause', { pauseMs: 5000 });
    for (let i = 0; i < 10; i++) engine.advance(100);
    engine.setTopology({
      ...t,
      nodes: t.nodes.filter((n) => n.id !== 'pay'),
      edges: [t.edges[0] as SimEdge],
    });
    for (let i = 0; i < 10; i++) engine.advance(100);
    const s = engine.snapshot();
    expect(engine.activeFailures()).toEqual([]);
    // With no timeout, a caller left waiting would hold its slot for good.
    expect(s.nodes.checkout?.waitingOnDownstream ?? 0).toBe(0);
    expect(s.failuresByReason['no-route']).toBeGreaterThan(50);
  });

  it('refuses a pause with no length', () => {
    const t = checkout();
    const why: string[] = [];
    const kept = sanitizeFaults(
      [
        { atMs: 0, action: 'inject', nodeId: 'pay', kind: 'pause' },
        { atMs: 0, action: 'inject', nodeId: 'pay', kind: 'pause', opts: {} },
        pauseAt('pay', 0, 0),
        pauseAt('pay', 0, Number.NaN),
        pauseAt('pay', 5, 200),
      ],
      t,
      (i, w) => why.push(`${i} ${w}`),
    );
    expect(kept).toEqual([pauseAt('pay', 5, 200)]);
    expect(why).toEqual([
      '0 pauses a node but has no opts.pauseMs; give how long it stops for, in milliseconds.',
      '1 has opts.pauseMs undefined; give how long it stops for, in milliseconds above 0.',
      '2 has opts.pauseMs 0; give how long it stops for, in milliseconds above 0.',
      '3 has opts.pauseMs NaN; give how long it stops for, in milliseconds above 0.',
    ]);
  });
});

describe('pause: the search', () => {
  it('finds a pause that charges twice, and its replay does', () => {
    const v = verify(checkout(), ONCE, { kinds: ['pause'] });
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule.map((a) => a.kind)).toEqual(['pause']);
    expect(v.replay.faults?.[0]).toMatchObject({ action: 'inject', kind: 'pause' });
    const first = v.first;
    if (first?.check !== 'atMostOnce') throw new Error('no double charge');
    const tl = followRequest(v.replay, first.rid);
    expect(tl?.events.some((e) => e.type === 'retry')).toBe(true);
  }, 60_000);

  it('holds once the part that charges keeps keys', () => {
    const v = verify(checkout({}, { idempotencyKeys: 1 }), ONCE, {
      kinds: ['pause'],
      budget: 20,
    });
    expect(v.status).toBe('held');
  }, 60_000);

  it('schedules a pause with its own length and no clear', () => {
    const attack: Attack = { kind: 'pause', target: 'pay', atMs: 10_000, forMs: 2000 };
    expect(replayOf(checkout(), [attack], 1).faults).toEqual([
      pauseAt('pay', 10_000, 2000),
    ]);
  });

  it('is only tried for the double-charge goal', () => {
    const t = checkout();
    const up = { metric: 'errorRate', max: 1 } as const;
    const all = runSearch(t, up, { ...DEFAULT_OPTIONS, budget: 12 });
    const without = runSearch(t, up, {
      ...DEFAULT_OPTIONS,
      kinds: DEFAULT_OPTIONS.kinds.filter((k) => k !== 'pause' && k !== 'cut-replies'),
      budget: 12,
    });
    expect(all).toEqual(without);
  }, 60_000);
});
