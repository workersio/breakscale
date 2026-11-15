import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BREAK_END_MS,
  BREAK_WARMUP_MS,
  playBaseline,
  replayOf,
  trial,
} from './breakit';
import type { Attack, SeedRun } from './breakit';
import { Engine } from './engine';
import { OpLogRecorder, checkAtMostOnce, timelineOf } from './oplog';
import { PRESETS, defaultConfig } from './presets';
import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './types';
import { followRequest, verify, verifyErrors } from './verify';

/**
 * The operation log and the at-most-once check.
 *
 * The fixture is the smallest design that charges twice: a client, a
 * checkout service that gives up on the payment provider after 300ms and
 * tries again, and a provider that usually answers in 100ms. Slow the
 * provider down and a try checkout gave up on still finishes, and so does
 * the retry, and both charge the card.
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

function checkout(pay: Partial<NodeConfig> = {}): Topology {
  return {
    nodes: [
      node('client', 'client', { rps: 100 }),
      node('checkout', 'service', {
        capacity: 64,
        serviceMs: 5,
        timeoutMs: 300,
        retries: 2,
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

const GOAL = { metric: 'doubleCharges', max: 0 } as const;
const SLOW_2X: Attack = {
  kind: 'slow',
  target: 'pay',
  factor: 2,
  atMs: 10_000,
  forMs: 500,
};

function baseline(t: Topology): SeedRun[] {
  const it = playBaseline(t, GOAL);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value.runs;
  }
}

function snapshotHash(t: Topology, log: boolean): string {
  const engine = new Engine(t, 7);
  if (log) engine.startOpLog({ follow: 'all' });
  const h = createHash('sha256');
  for (let i = 1; i <= 600; i++) {
    engine.advance(1000 / 60);
    if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
  }
  return h.digest('hex');
}

describe('operation log: changes nothing', () => {
  it.each(PRESETS.map((p) => p.id))(
    '%s plays the same snapshots with every request followed',
    (id) => {
      const p = PRESETS.find((x) => x.id === id);
      if (!p) throw new Error(`no preset ${id}`);
      const t = structuredClone(p.topology);
      expect(snapshotHash(t, true)).toBe(snapshotHash(t, false));
    },
  );

  it('the same run records the same log', () => {
    const play = () => {
      const engine = new Engine({ ...checkout(), faults: [] }, 3);
      engine.startOpLog({ follow: 'all' });
      for (let t = 0; t < 12_000; t += 100) engine.advance(100);
      return engine.readOpLog();
    };
    expect(play()).toEqual(play());
  });

  it('reset ends the log', () => {
    const engine = new Engine(checkout(), 1);
    engine.startOpLog();
    engine.advance(100);
    engine.reset();
    expect(engine.readOpLog()).toBeNull();
  });
});

describe('at most once', () => {
  it('charges nobody twice with no faults', () => {
    const runs = baseline(checkout());
    expect(runs.map((r) => r.actual)).toEqual([0, 0, 0]);
    // Every request a client sent in the window was charged and checked.
    for (const r of runs) expect(r.checked).toBeGreaterThan(2900);
  });

  it('charges twice when a retry follows a timeout on a slow provider', () => {
    const t = checkout();
    const result = trial(t, GOAL, [SLOW_2X], baseline(t));
    expect(result.broke).toBe(true);
    expect(result.runs.map((r) => r.actual)).toEqual([2, 2]);
    const v = result.runs[0].violations?.[0];
    if (v?.check !== 'atMostOnce') throw new Error('expected a double charge');
    expect(v.nodeId).toBe('pay');
    expect(v.chargedMs).toHaveLength(2);
  });

  it('a refusal charges nothing, so errors alone never charge twice', () => {
    const t = checkout();
    const errors: Attack = {
      kind: 'errors',
      target: 'pay',
      rate: 0.5,
      atMs: 10_000,
      forMs: 2000,
    };
    expect(trial(t, GOAL, [errors], baseline(t)).runs[0].actual).toBe(0);
  });

  it('idempotency keys stop the second charge', () => {
    const t = checkout({ idempotencyKeys: 1 });
    const slower: Attack = { ...SLOW_2X, factor: 3, forMs: 2000 };
    const result = trial(t, GOAL, [slower], baseline(t));
    expect(result.runs[0].actual).toBe(0);
    // The same schedule without them charged about a hundred twice.
    const plain = checkout();
    expect(
      trial(plain, GOAL, [slower], baseline(plain)).runs[0].actual,
    ).toBeGreaterThan(50);
  });

  it('a call the provider already finished is answered from the first answer', () => {
    const engine = new Engine({ ...checkout({ idempotencyKeys: 1 }), faults: [] }, 1);
    engine.injectFailure('pay', 'slow', { factor: 3 });
    engine.startOpLog({ follow: 'all' });
    for (let t = 0; t < 3000; t += 100) engine.advance(100);
    const log = engine.readOpLog();
    if (log === null) throw new Error('no log');
    let dedupes = 0;
    for (const rid of new Set(log.events.rid)) {
      const tl = timelineOf(log, rid);
      if (tl?.events.some((x) => x.type === 'dedupe')) dedupes++;
    }
    expect(dedupes).toBeGreaterThan(0);
    expect(checkAtMostOnce(log, 0, 3000).count).toBe(0);
  });

  it('a call that failed after doing its work frees its key, so a retry does it again', () => {
    // The provider charges, then its bank refuses everything, so each try
    // fails after the charge and checkout tries again.
    const t: Topology = {
      nodes: [
        node('client', 'client', { rps: 20 }),
        node('checkout', 'service', { capacity: 16, serviceMs: 5, retries: 2 }),
        node('pay', 'service', {
          capacity: 16,
          serviceMs: 10,
          chargeable: 1,
          idempotencyKeys: 1,
        }),
        node('bank', 'service', { capacity: 16, serviceMs: 5, errorRate: 1 }),
      ],
      edges: [edge('client', 'checkout'), edge('checkout', 'pay'), edge('pay', 'bank')],
    };
    const engine = new Engine(t, 1);
    engine.startOpLog();
    for (let ms = 0; ms < 3000; ms += 100) engine.advance(100);
    const log = engine.readOpLog();
    if (log === null) throw new Error('no log');
    const found = checkAtMostOnce(log, 0, 2000);
    expect(found.count).toBe(found.checked);
    expect(found.violations[0].chargedMs).toHaveLength(3);
  });

  it('one request reaching the provider down two paths is not a double charge', () => {
    const t: Topology = {
      nodes: [
        node('client', 'client', { rps: 50 }),
        node('a', 'service', { capacity: 16, serviceMs: 2 }),
        node('b', 'service', { capacity: 16, serviceMs: 2 }),
        node('c', 'service', { capacity: 16, serviceMs: 2 }),
        node('pay', 'service', { capacity: 32, serviceMs: 10, chargeable: 1 }),
      ],
      edges: [
        edge('client', 'a'),
        edge('a', 'b'),
        edge('a', 'c'),
        edge('b', 'pay'),
        edge('c', 'pay'),
      ],
    };
    for (const idem of [undefined, 1]) {
      const design = {
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === 'pay' && idem !== undefined
            ? { ...n, config: { ...n.config, idempotencyKeys: idem } }
            : n,
        ),
      };
      const engine = new Engine(design, 1);
      engine.startOpLog();
      for (let ms = 0; ms < 3000; ms += 100) engine.advance(100);
      const log = engine.readOpLog();
      if (log === null) throw new Error('no log');
      expect(checkAtMostOnce(log, 0, 2000).count).toBe(0);
      // Both paths charged, keys or not: they are two calls, not a repeat.
      expect(log.charges.rid.length).toBeGreaterThan(1.9 * log.invokeMs.length);
    }
  });

  /** A client that retries, through a balancer, to two backends or two payment parts. */
  function balanced(behind: 'apps' | 'pays', keys: boolean): Topology {
    const pay = (id: string) =>
      node(id, 'service', {
        capacity: 128,
        serviceMs: 100,
        serviceCv: 0.3,
        chargeable: 1,
        ...(keys ? { idempotencyKeys: 1 } : {}),
      });
    const client = node('client', 'client', { rps: 100, timeoutMs: 400, retries: 2 });
    if (behind === 'pays') {
      return {
        nodes: [client, node('lb', 'lb'), pay('pay1'), pay('pay2')],
        edges: [edge('client', 'lb'), edge('lb', 'pay1'), edge('lb', 'pay2')],
      };
    }
    return {
      nodes: [
        client,
        node('lb', 'lb'),
        node('app1', 'service', { capacity: 64, serviceMs: 5 }),
        node('app2', 'service', { capacity: 64, serviceMs: 5 }),
        pay('pay'),
      ],
      edges: [
        edge('client', 'lb'),
        edge('lb', 'app1'),
        edge('lb', 'app2'),
        edge('app1', 'pay'),
        edge('app2', 'pay'),
      ],
    };
  }

  /** Requests the client sent in the window that were charged more than once, counted directly. */
  function chargedTwice(
    t: Topology,
    attacks: Attack[],
  ): { counted: number; truth: number } {
    const engine = new Engine(replayOf(t, attacks, 1), 1);
    engine.startOpLog();
    for (let ms = 0; ms < BREAK_END_MS + 5000; ms += 100) engine.advance(100);
    const log = engine.readOpLog();
    if (log === null) throw new Error('no log');
    const per = new Map<number, number>();
    for (const rid of log.charges.rid) per.set(rid, (per.get(rid) ?? 0) + 1);
    let truth = 0;
    for (const [rid, n] of per) {
      const at = log.invokeMs[rid - log.ridBase];
      if (n > 1 && at >= BREAK_WARMUP_MS && at < BREAK_END_MS) truth++;
    }
    return {
      counted: checkAtMostOnce(log, BREAK_WARMUP_MS, BREAK_END_MS).count,
      truth,
    };
  }

  it('a retry the balancer sends to the other backend is the same call', () => {
    const slow: Attack = {
      kind: 'slow',
      target: 'pay',
      factor: 4,
      atMs: 10_000,
      forMs: 2000,
    };
    const plain = chargedTwice(balanced('apps', false), [slow]);
    expect(plain.truth).toBeGreaterThan(50);
    expect(plain.counted).toBe(plain.truth);
    // The retry reaches the provider with the same key, so it is not charged again.
    expect(chargedTwice(balanced('apps', true), [slow])).toEqual({
      counted: 0,
      truth: 0,
    });
  });

  it('a charge at each of two payment parts behind a balancer is two charges', () => {
    const slow: Attack = {
      kind: 'slow',
      target: 'pay1',
      factor: 4,
      atMs: 10_000,
      forMs: 2000,
    };
    const plain = chargedTwice(balanced('pays', false), [slow]);
    expect(plain.counted).toBe(plain.truth);
    // Each keeps its own keys, so a retry sent to the other one charges again.
    const keyed = chargedTwice(balanced('pays', true), [slow]);
    expect(keyed.truth).toBeGreaterThan(10);
    expect(keyed.counted).toBe(keyed.truth);
  });

  it('keeps no charges past the request cap, and says it stopped', () => {
    const rec = new OpLogRecorder({}, 1);
    rec.invoke(0, 1, 'client', 0);
    rec.apply(1, 1, 0, 'pay', 0, true);
    const past = 1 + (1 << 20);
    rec.invoke(2, past, 'client', 0);
    rec.apply(3, past, 0, 'pay', 0, true);
    const log = rec.read();
    expect(log.truncated).toBe(true);
    expect(Array.from(log.charges.rid)).toEqual([1]);
    expect(checkAtMostOnce(log, 0, 10).truncated).toBe(true);
  });
});

describe('verify: doubleCharges', () => {
  it('finds the smallest schedule, and the request can be followed', () => {
    // Retries only; a cable delivering twice is in duplicate.test.ts.
    const v = verify(checkout(), GOAL, {
      kinds: ['crash', 'crash-instance', 'slow', 'errors', 'cut'],
    });
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.schedule).toEqual([SLOW_2X]);
    expect(v.minimal).toBe(true);
    expect(v.measured.actual).toBe(2);
    expect(v.withoutFaults.actual).toBe(0);
    const first = v.first;
    if (first?.check !== 'atMostOnce') throw new Error('no first double charge');
    const tl = followRequest(v.replay, first.rid);
    if (tl === null) throw new Error('request not found');
    const charges = tl.events.flatMap((e) =>
      e.type === 'apply' && e.charge ? [e] : [],
    );
    expect(charges.map((e) => e.t)).toEqual(first.chargedMs);
    expect(charges.map((e) => e.repeat)).toEqual([false, true]);
    const types = tl.events.map((e) => e.type);
    expect(types).toContain('timeout');
    expect(types).toContain('retry');
    // The client heard one answer.
    expect(
      tl.events.filter((e) => e.type === 'answer' && e.heard === 'client'),
    ).toHaveLength(1);
  });

  it('gives the same verdict every time', () => {
    expect(verify(checkout(), GOAL, { budget: 20 })).toEqual(
      verify(checkout(), GOAL, { budget: 20 }),
    );
  });

  it('holds with idempotency keys', () => {
    const v = verify(checkout({ idempotencyKeys: 1 }), GOAL, { budget: 40 });
    expect(v.status).toBe('held');
    if (v.status === 'held') expect(v.checked).toBeGreaterThan(2900);
  });

  it('takes the payment part as an option, and the replay carries it', () => {
    const design = checkout({ chargeable: undefined });
    const v = verify(design, GOAL, { chargeable: ['pay'] });
    if (v.status !== 'broken') throw new Error(`expected broken, got ${v.status}`);
    expect(v.replay.nodes.find((n) => n.id === 'pay')?.config.chargeable).toBe(1);
  });

  it('is already broken when a retry charges twice with no faults', () => {
    const p = PRESETS.find((x) => x.id === 'stripe');
    if (!p) throw new Error('no stripe preset');
    const t = structuredClone(p.topology);
    const merchants = t.nodes.find((n) => n.id === 'merchants');
    if (!merchants) throw new Error('no merchants');
    merchants.config.retries = 2;
    const v = verify(t, GOAL, { chargeable: ['cardnet', 'ledger'] });
    expect(v.status).toBe('alreadyBroken');
    if (v.status === 'alreadyBroken') {
      expect(v.measured.actual).toBeGreaterThan(0);
      if (v.replay === undefined || v.first?.check !== 'atMostOnce')
        throw new Error('no replay');
      expect(v.first.chargedMs.length).toBeGreaterThan(1);
      const tl = followRequest(v.replay, v.first.rid);
      expect(tl?.events.some((e) => e.type === 'apply' && e.repeat)).toBe(true);
    }
  });

  it('explains what is missing in plain words', () => {
    const plain = checkout({ chargeable: undefined });
    expect(verifyErrors(plain, GOAL)[0]).toMatch(/Nothing in the design is marked/);
    expect(verifyErrors(plain, GOAL, { chargeable: ['nope'] })[0]).toMatch(
      /not a part/,
    );
    expect(verifyErrors(plain, GOAL, { chargeable: ['client'] })[0]).toMatch(
      /sends the requests/,
    );
    expect(verifyErrors(checkout(), { ...GOAL, route: 'client' })[0]).toMatch(
      /whole system/,
    );
    const queued: Topology = {
      nodes: [...plain.nodes, node('rq', 'retryqueue')],
      edges: plain.edges,
    };
    expect(verifyErrors(queued, GOAL, { chargeable: ['rq'] })[0]).toMatch(
      /answers before the work is done/,
    );
    expect(verifyErrors(checkout(), GOAL)).toEqual([]);
  });
});
