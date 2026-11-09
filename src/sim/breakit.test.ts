import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import {
  BREAK_END_MS,
  BREAK_FRAME_MS,
  BREAK_WARMUP_MS,
  DEFAULT_OPTIONS,
  SHRINK_CAP,
  breakGoals,
  breakKey,
  breakTargets,
  defaultMax,
  neighbours,
  playBaseline,
  replayOf,
  runLengthMs,
  runSearch,
  scheduleKey,
  searchBreak,
  singlePoints,
  toSchedule,
  trial,
} from './breakit';
import type { Attack, BreakOptions, SearchProgress, SearchResult } from './breakit';
import type { Goal } from './challenge';
import { Engine } from './engine';
import { PRESETS, defaultConfig } from './presets';
import type { NodeKind, Topology } from './types';

const preset = (id: string): Topology => {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return p.topology;
};

function node(
  id: string,
  kind: NodeKind,
  config: Partial<Topology['nodes'][0]['config']>,
) {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...config },
  };
}

/** A client and one roomy server: slowing it 20x still answers in 100ms. */
const ROOMY: Topology = {
  nodes: [
    node('client', 'client', { rps: 20, timeoutMs: 2000 }),
    node('api', 'service', {
      capacity: 64,
      serviceMs: 5,
      serviceCv: 0,
      queueLimit: 64,
    }),
  ],
  edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1 }],
};

function drain(it: Generator<SearchProgress, SearchResult, void>, every = 1) {
  const seen: SearchProgress[] = [];
  let n = 0;
  for (;;) {
    const step = it.next();
    if (step.done) return { result: step.value, seen };
    if (++n % every === 0) seen.push(step.value);
  }
}

const baselineOf = (t: Topology, goal: Goal) => {
  const it = playBaseline(t, goal);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
  }
};

describe('break it: determinism', () => {
  it('gives the same verdict and the same progress twice', () => {
    const goal: Goal = { metric: 'errorRate', max: 1 };
    const a = drain(searchBreak(preset('full-stack'), goal, DEFAULT_OPTIONS));
    const b = drain(searchBreak(preset('full-stack'), goal, DEFAULT_OPTIONS));
    expect(b.result).toEqual(a.result);
    expect(JSON.stringify(b.seen)).toBe(JSON.stringify(a.seen));
    expect(a.result.status).toBe('broke');
  });

  it('stopped and resumed, plays the same as straight through', () => {
    const goal: Goal = { metric: 'p99', max: 300 };
    const whole = runSearch(preset('cache-aside'), goal, DEFAULT_OPTIONS);
    const it = searchBreak(preset('cache-aside'), goal, DEFAULT_OPTIONS);
    const first: SearchProgress[] = [];
    for (let i = 0; i < 37; i++) {
      const s = it.next();
      if (s.done) break;
      first.push(s.value);
    }
    expect(drain(it).result).toEqual(whole);
  });

  it('keys the search on its options in any order, and on the seed', () => {
    const t = preset('single-server');
    const goal: Goal = { metric: 'errorRate', max: 1 };
    const a: BreakOptions = {
      ...DEFAULT_OPTIONS,
      kinds: ['slow', 'crash'],
      protect: ['db', 'api'],
    };
    const b: BreakOptions = {
      ...DEFAULT_OPTIONS,
      kinds: ['crash', 'slow'],
      protect: ['api', 'db'],
    };
    expect(breakKey(t, goal, a)).toBe(breakKey(t, goal, b));
    expect(breakKey({ ...t, seed: 7 }, goal, a)).not.toBe(breakKey(t, goal, a));
  });
});

describe('break it: shrink', () => {
  for (const [id, goal] of [
    ['single-server', { metric: 'errorRate', max: 1 }],
    ['cache-aside', { metric: 'errorRate', max: 1 }],
    ['full-stack', { metric: 'p99', max: 300 }],
    ['stripe', { metric: 'errorRate', max: 1, route: 'dashboards' }],
  ] as const) {
    it(`leaves ${id} with no smaller break one step away`, () => {
      const t = preset(id);
      const r = runSearch(t, goal, DEFAULT_OPTIONS);
      expect(r.status).toBe('broke');
      if (r.status !== 'broke') return;
      expect(r.minimal).toBe(true);
      expect(r.shrinkTried).toBeLessThanOrEqual(SHRINK_CAP);
      expect(trial(t, goal, r.attacks, r.baseline.runs).broke).toBe(true);
      const targets = new Map(
        breakTargets(t, goal, DEFAULT_OPTIONS).map((x) => [x.id, x]),
      );
      for (const n of neighbours(r.attacks, targets)) {
        expect(trial(t, goal, n, r.baseline.runs).broke, scheduleKey(n)).toBe(false);
      }
    }, 60_000);
  }

  it('shrinks single-server down from slow 20x for good to slow 5x for 5s', () => {
    const r = runSearch(
      preset('single-server'),
      { metric: 'errorRate', max: 1 },
      DEFAULT_OPTIONS,
    );
    expect(r.status === 'broke' && r.found).toEqual([
      { kind: 'slow', target: 'db', factor: 20, atMs: 10_000, forMs: null },
    ]);
    expect(r.status === 'broke' && r.attacks).toEqual([
      { kind: 'slow', target: 'db', factor: 5, atMs: 10_000, forMs: 5000 },
    ]);
  });
});

describe('break it: replay', () => {
  const goal: Goal = { metric: 'errorRate', max: 1 };
  // With the ids the wire mints, so a run of it and a run of its link name
  // the same nodes in their snapshots. The wire has always renamed ids.
  const t = unpackTopology(packTopology(preset('single-server')));
  if (!t) throw new Error('single-server did not survive the wire');
  const r = runSearch(t, goal, DEFAULT_OPTIONS);
  if (r.status !== 'broke') throw new Error('single-server should break');
  const replay = replayOf(t, r.attacks, r.run.seed);

  it('travels through a link unchanged', () => {
    const back = unpackTopology(packTopology(replay));
    expect(back).toEqual(replay);
  });

  it('plays the searched run byte for byte and counts the same window', () => {
    const back = unpackTopology(packTopology(replay));
    if (!back) throw new Error('did not decode');
    const play = (topo: Topology) => {
      const e = new Engine(topo, topo.seed);
      const snaps: string[] = [];
      while (e.now < BREAK_END_MS - 1e-9) {
        if (Math.abs(e.now - BREAK_WARMUP_MS) < 1e-9) e.startTally();
        e.advance(BREAK_FRAME_MS);
        snaps.push(JSON.stringify(e.snapshot()));
      }
      e.stopTally();
      return { snaps, tally: e.readTally() };
    };
    const a = play(replay);
    const b = play(back);
    expect(b.snaps.length).toBe(a.snaps.length);
    for (let i = 0; i < a.snaps.length; i++) {
      if (a.snaps[i] !== b.snaps[i]) throw new Error(`snapshot ${i} differs`);
    }
    expect(b.tally).toEqual(a.tally);
    const tally = b.tally;
    if (!tally) throw new Error('no tally');
    expect(tally.failed).toBe(r.run.failed);
    expect(tally.completed).toBe(r.run.completed);
    expect((tally.failed / (tally.failed + tally.completed)) * 100).toBe(r.run.actual);
  });

  it('turns attacks into an inject and a clear, or a cut and a restore', () => {
    const attacks: Attack[] = [
      { kind: 'cut', target: 'api->db', atMs: 12_000, forMs: 1000 },
      { kind: 'slow', target: 'db', factor: 5, atMs: 10_000, forMs: null },
    ];
    expect(toSchedule(attacks)).toEqual([
      {
        atMs: 10_000,
        action: 'inject',
        nodeId: 'db',
        kind: 'slow',
        opts: { factor: 5 },
      },
      { atMs: 12_000, action: 'cut', edgeId: 'api->db' },
      { atMs: 13_000, action: 'restore', edgeId: 'api->db' },
    ]);
  });
});

describe('break it: verdicts', () => {
  it('reports held for a design nothing in its fault space breaks', () => {
    const r = runSearch(ROOMY, { metric: 'p99', max: 300 }, DEFAULT_OPTIONS);
    expect(r.status).toBe('held');
    if (r.status !== 'held') return;
    // One server, so it is a single point: only slowing it is on the table.
    expect(r.tried).toBe(1);
    expect(r.closest?.attacks).toEqual([
      { kind: 'slow', target: 'api', factor: 20, atMs: 10_000, forMs: null },
    ]);
    expect(r.simMs).toBe(runLengthMs({ metric: 'p99', max: 300 }) * 4 + 10_000);
  });

  it('reports already broken when the fault-free run misses', () => {
    const r = runSearch(
      preset('stripe'),
      { metric: 'errorRate', max: 1 },
      DEFAULT_OPTIONS,
    );
    expect(r.status).toBe('alreadyBroken');
  });
});

describe('break it: single points of failure', () => {
  const t = preset('single-server');
  const goal: Goal = { metric: 'errorRate', max: 1 };

  it('finds every part single-server cannot do without', () => {
    expect(singlePoints(t).map((p) => p.id)).toEqual(['api', 'api->db', 'db']);
  });

  it('a cache that answers on its own keeps the store behind it off the list', () => {
    expect(singlePoints(preset('cache-aside')).map((p) => p.id)).toEqual([
      'api',
      'api->cache',
      'cache',
    ]);
  });

  it('only slows them by default', () => {
    for (const target of breakTargets(t, goal, DEFAULT_OPTIONS)) {
      expect(target.kinds).toEqual(['slow']);
    }
    const r = runSearch(t, goal, DEFAULT_OPTIONS);
    expect(r.status === 'broke' && r.attacks.every((a) => a.kind === 'slow')).toBe(
      true,
    );
  });

  it('crashes them when asked, and the crash is what breaks it', () => {
    const r = runSearch(t, goal, { ...DEFAULT_OPTIONS, includeSinglePoints: true });
    expect(r.status).toBe('broke');
    if (r.status !== 'broke') return;
    expect(r.attacks).toHaveLength(1);
    expect(['crash', 'errors']).toContain(r.attacks[0].kind);
  });
});

describe('break it: remembered breaks', () => {
  const t = preset('single-server');
  const goal: Goal = { metric: 'errorRate', max: 1 };
  const old: Attack[] = [
    { kind: 'slow', target: 'db', factor: 5, atMs: 10_000, forMs: 5000 },
  ];

  it('tries a remembered break first, and stops there if it still breaks', () => {
    const r = runSearch(t, goal, DEFAULT_OPTIONS, [old]);
    expect(r.status === 'broke' && r.fromRemembered).toBe(true);
    expect(r.status === 'broke' && r.tried).toBe(0);
  });

  it('skips one whose target is gone, and says so', () => {
    const gone: Attack[] = [
      { kind: 'slow', target: 'cache', factor: 5, atMs: 10_000, forMs: null },
    ];
    const r = runSearch(t, goal, DEFAULT_OPTIONS, [gone]);
    expect(r.status !== 'alreadyBroken' && r.notes).toEqual([
      { kind: 'gone', target: 'cache' },
    ]);
  });

  it('skips one the options now leave out', () => {
    const crash: Attack[] = [
      { kind: 'crash', target: 'db', atMs: 10_000, forMs: null },
    ];
    const opts = { ...DEFAULT_OPTIONS, budget: 0 };
    const allowed = runSearch(t, goal, { ...opts, includeSinglePoints: true }, [crash]);
    expect(allowed.status === 'broke' && allowed.fromRemembered).toBe(true);
    // The database is a single point, so by default it is only slowed.
    expect(runSearch(t, goal, opts, [crash]).status).toBe('held');
    expect(runSearch(t, goal, { ...opts, protect: ['db'] }, [old]).status).toBe('held');
    expect(runSearch(t, goal, { ...opts, kinds: ['crash'] }, [old]).status).toBe(
      'held',
    );
  });

  it('notes one that now holds and looks for another way in', () => {
    const fixed: Topology = {
      ...t,
      nodes: t.nodes.map((n) =>
        n.id === 'db' ? { ...n, config: { ...n.config, capacity: 24 } } : n,
      ),
    };
    const r = runSearch(fixed, goal, DEFAULT_OPTIONS, [old]);
    expect(r.status !== 'alreadyBroken' && r.notes[0]).toEqual({
      kind: 'holds',
      attacks: old,
    });
  });
});

describe('break it: what a schedule may hold', () => {
  it('never doubles up, never cuts a client off, never touches a protected part', () => {
    const t = preset('full-stack');
    const opts: BreakOptions = {
      ...DEFAULT_OPTIONS,
      budget: 80,
      protect: ['db'],
      includeSinglePoints: true,
    };
    // A goal nothing here reaches, so the whole budget is played.
    const { result, seen } = drain(
      searchBreak(t, { metric: 'errorRate', max: 100 }, opts),
    );
    const clients = new Set(
      t.nodes.filter((n) => n.kind === 'client').map((n) => n.id),
    );
    const edges = new Map(t.edges.map((e) => [e.id, e]));
    for (const p of seen) {
      const ids = p.current.map((a) => a.target);
      expect(new Set(ids).size).toBe(ids.length);
      for (const a of p.current) {
        expect(a.target).not.toBe('db');
        const e = edges.get(a.target);
        if (e) {
          expect(clients.has(e.from)).toBe(false);
          expect([e.from, e.to]).not.toContain('db');
        }
      }
    }
    expect(result.status !== 'alreadyBroken' && result.tried).toBeLessThanOrEqual(80);
  }, 60_000);
});

describe('break it: goals', () => {
  it('offers per-client goals only where there are several clients', () => {
    expect(breakGoals(preset('single-server')).map((g) => g.id)).toEqual([
      'up',
      'fast',
    ]);
    const stripe = breakGoals(preset('stripe')).map((g) => g.id);
    expect(stripe).toContain('up:dashboards');
    expect(stripe).toContain('fast:merchants');
  });

  it('offers lost writes and lost jobs only where they can happen', () => {
    for (const p of PRESETS) {
      const ids = breakGoals(p.topology).map((g) => g.id);
      expect(ids.includes('writes')).toBe(
        p.topology.nodes.some((n) => n.kind === 'writebehind'),
      );
    }
  });

  it('sets the default above a design that already sits near the line', () => {
    const goal: Goal = { metric: 'errorRate', max: 1 };
    const worst = baselineOf(preset('stripe'), goal).worst.actual;
    expect(worst).toBeGreaterThan(1);
    expect(defaultMax(goal, worst)).toBeGreaterThanOrEqual(2 * (worst ?? 0));
    expect(defaultMax(goal, 0.1)).toBe(1);
  });
});
