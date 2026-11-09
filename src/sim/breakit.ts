// behaviour before judge: judge imports behaviour-control through behaviour,
// in the order its own header explains.
import { behaviourFor, canCrashOneInstance } from './behaviour';
import { isRouteGoal } from './challenge';
import type { Goal } from './challenge';
import { Engine } from './engine';
import {
  KEPT_UP_FLOOR,
  SETTLE_MS,
  SHORTCUT_KINDS,
  canonical,
  hash53,
  nearestRank,
} from './judge';
import { Rng } from './random';
import { DEFAULT_SEED } from './seed';
import type { FailureReason, FaultEvent, RunTally, Topology } from './types';

/* ------------------------------------------------------------------ *
 * "Can you break it?"
 *
 * A search for the smallest set of faults that makes a design miss a goal
 * the reader picked. Everything here is measured in schedules tried and
 * simulated seconds, never wall time, so the same design, goal and options
 * give the same answer on any machine, and a search stopped after n
 * schedules has tried exactly the first n of the full one.
 *
 * Three things keep the answers honest rather than lucky:
 *
 * - Every fault lands between 10s and 15s and the window runs to 35s, so a
 *   fault always has room to show its effect and to recover. A fault in the
 *   last half second of a window breaks a 1% goal on arithmetic alone.
 * - A break has to clear the goal by a margin, and also clear the same seed
 *   with no faults by that margin, on the design's own seed and on one of
 *   the next two. Any fault shifts the engine's random stream, and without
 *   this a harmless fault "breaks" a design that sits near its goal.
 * - Components every request has to pass through are found from the wiring
 *   first and named as a finding. By default they are not crashed, failed
 *   or cut, because "crash the only database" breaks every design and
 *   teaches nothing the finding has not said already. They are still slowed
 *   and still lose single machines.
 * ------------------------------------------------------------------ */

/** No faults before this, so the run has reached its steady state. */
export const BREAK_WARMUP_MS = 5000;
/** The earliest a fault lands. */
export const FAULT_AT_MS = 10_000;
/** When a later fault in a schedule may land. Shrinking never moves these. */
export const FAULT_STARTS_MS: readonly number[] = [10_000, 12_000, 15_000];
/** End of the counted window, which starts at the end of the warm-up. */
export const BREAK_END_MS = 35_000;
/**
 * Simulated ms per step. The engine caps every advance at 100ms, so a
 * larger frame would not be one; a replay stepped the same way counts the
 * same requests.
 */
export const BREAK_FRAME_MS = 100;
/** Steps between two yields: one simulated second. */
const SLICE_FRAMES = 10;
/** How long a fault lasts, shortest first. Null runs to the end. */
export const DURATIONS_MS: readonly (number | null)[] = [
  500,
  1000,
  2000,
  5000,
  10_000,
  null,
];
/** Service-time multipliers, the same ones the fault controls offer. */
export const BREAK_SLOW_FACTORS: readonly number[] = [2, 3, 5, 10, 20];
/** Error fractions, the same ones the fault controls offer. */
export const BREAK_ERROR_RATES: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1];
/** How far past the goal, and past the fault-free run, a break must land. */
export const BREAK_MARGIN = 0.1;
/** Faults kept from the single-fault pass for building bigger schedules. */
const POOL_SIZE = 12;
/** Most schedules the shrink may try. */
export const SHRINK_CAP = 80;
/** Remembered breaks tried before anything new. */
export const MAX_REMEMBERED = 5;
export const DEFAULT_BUDGET = 500;
export const HARDER_BUDGET = 1000;
/** Draws in a row that only found schedules already tried, before a phase gives up. */
const MAX_REPEATS = 200;

export type AttackKind = 'crash' | 'crash-instance' | 'slow' | 'errors' | 'cut';
export const ATTACK_KINDS: readonly AttackKind[] = [
  'crash',
  'crash-instance',
  'slow',
  'errors',
  'cut',
];

/**
 * One fault in a schedule. `target` is a node id, or an edge id for `cut`.
 * `forMs` null lasts to the end of the run.
 */
export type Attack =
  | {
      kind: 'crash' | 'crash-instance' | 'cut';
      target: string;
      atMs: number;
      forMs: number | null;
    }
  | { kind: 'slow'; target: string; factor: number; atMs: number; forMs: number | null }
  | {
      kind: 'errors';
      target: string;
      rate: number;
      atMs: number;
      forMs: number | null;
    };

export interface BreakOptions {
  /** Schedules to try after the remembered ones. */
  budget: number;
  maxFaults: 1 | 2 | 3;
  kinds: readonly AttackKind[];
  /** Node and edge ids never to fault. */
  protect: readonly string[];
  /** Also crash, fail and cut the parts every request passes through. */
  includeSinglePoints: boolean;
}

export const DEFAULT_OPTIONS: BreakOptions = {
  budget: DEFAULT_BUDGET,
  maxFaults: 3,
  kinds: ATTACK_KINDS,
  protect: [],
  includeSinglePoints: false,
};

/** One seed's run, measured over the window. */
export interface SeedRun {
  seed: number;
  arrived: number;
  completed: number;
  failed: number;
  failuresByReason: Partial<Record<FailureReason, number>>;
  /** Settled over arrived, for the route when the goal has one. */
  keptUp: number | null;
  /** The goal's figure, or null when nothing it reads settled. */
  actual: number | null;
  outcome: 'passed' | 'goal-missed' | 'nothing-completed' | 'falling-behind';
}

/** A schedule's result: its runs, and whether they count as a break. */
export interface Trial {
  attacks: Attack[];
  /** One run per seed played: the design's own first, the others only if it broke. */
  runs: SeedRun[];
  broke: boolean;
  /** How close the design's own seed came to breaking: 1 or more is past the line. */
  score: number;
}

/** A part of the design that every request from some client passes through. */
export interface SinglePoint {
  id: string;
  type: 'node' | 'edge';
  /** The clients that lose everything without it. */
  clients: string[];
}

export type SearchPhase =
  'baseline' | 'remembered' | 'single' | 'pair' | 'triple' | 'shrink';

export type SearchNote =
  /** A remembered schedule names a part the design no longer has. */
  | { kind: 'gone'; target: string }
  /** A remembered schedule no longer breaks it. */
  | { kind: 'holds'; attacks: Attack[] };

export interface Closest {
  attacks: Attack[];
  actual: number | null;
  score: number;
  outcome: SeedRun['outcome'];
  /** The backlog, not the goal's figure, is what came close. */
  pilingUp: boolean;
}

export interface SearchProgress {
  phase: SearchPhase;
  /** Schedules tried against the budget, remembered ones not counted. */
  tried: number;
  budget: number;
  shrinkTried: number;
  /** The schedule being played. */
  current: readonly Attack[];
  closest: Closest | null;
  /** Simulated ms played so far, every seed and the baseline included. */
  simMs: number;
  notes: readonly SearchNote[];
}

export interface Baseline {
  runs: SeedRun[];
  /** The run that came closest to the goal. */
  worst: SeedRun;
}

export type SearchResult =
  | { status: 'alreadyBroken'; baseline: Baseline; simMs: number }
  | {
      status: 'broke';
      attacks: Attack[];
      /** The design's own seed with the schedule, and without it. */
      run: SeedRun;
      base: SeedRun;
      /** The schedule as first found, before the shrink. */
      found: Attack[];
      /** Which schedule found it, counting the budget's only. 0 for a remembered one. */
      foundAt: number;
      fromRemembered: boolean;
      tried: number;
      shrinkTried: number;
      /** Every neighbour the shrink checked still met the goal. */
      minimal: boolean;
      simMs: number;
      notes: SearchNote[];
      baseline: Baseline;
    }
  | {
      status: 'held';
      tried: number;
      /** The budget it ran with. */
      budget: number;
      /** Schedules tried with one, two and three faults. */
      bySize: [number, number, number];
      closest: Closest | null;
      simMs: number;
      notes: SearchNote[];
      baseline: Baseline;
    };

/* ---------------- schedules ---------------- */

/** The engine's fault schedule for a set of attacks, in time order. */
export function toSchedule(attacks: readonly Attack[]): FaultEvent[] {
  const out: FaultEvent[] = [];
  for (const a of sortAttacks(attacks)) {
    const end = a.forMs === null ? null : a.atMs + a.forMs;
    if (a.kind === 'cut') {
      out.push({ atMs: a.atMs, action: 'cut', edgeId: a.target });
      if (end !== null) out.push({ atMs: end, action: 'restore', edgeId: a.target });
      continue;
    }
    const opts =
      a.kind === 'slow'
        ? { opts: { factor: a.factor } }
        : a.kind === 'errors'
          ? { opts: { rate: a.rate } }
          : {};
    out.push({
      atMs: a.atMs,
      action: 'inject',
      nodeId: a.target,
      kind: a.kind,
      ...opts,
    });
    if (end !== null) out.push({ atMs: end, action: 'clear', nodeId: a.target });
  }
  // Stable, so entries sharing a time keep the order above.
  return out
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.atMs - y.e.atMs || x.i - y.i)
    .map((x) => x.e);
}

function sortAttacks(attacks: readonly Attack[]): Attack[] {
  return attacks
    .slice()
    .sort(
      (a, b) =>
        a.atMs - b.atMs ||
        (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
        ATTACK_KINDS.indexOf(a.kind) - ATTACK_KINDS.indexOf(b.kind),
    );
}

/** One string per schedule, whatever order its attacks were listed in. */
export function scheduleKey(attacks: readonly Attack[]): string {
  return canonical(sortAttacks(attacks));
}

/** The design without its own faults, for searching. */
export function searchDesign(t: Topology): Topology {
  return {
    nodes: t.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: t.edges.map((e) => ({ ...e })),
    ...(t.seed !== undefined ? { seed: t.seed } : {}),
  };
}

/** The run that shows a break: the design, the schedule and the seed. */
export function replayOf(
  design: Topology,
  attacks: readonly Attack[],
  seed: number,
): Topology {
  const { faults: _faults, ...rest } = design;
  const faults = toSchedule(attacks);
  return { ...rest, ...(faults.length > 0 ? { faults } : {}), seed };
}

/** The seeds a search plays: the design's own, then the next two. */
export function breakSeeds(design: Topology): [number, number, number] {
  const s = design.seed ?? DEFAULT_SEED;
  return [s, (s + 1) >>> 0, (s + 2) >>> 0];
}

/* ---------------- one run ---------------- */

function settles(goal: Goal): boolean {
  return goal.metric === 'lostWrites' || goal.metric === 'lostJobs';
}

/** Simulated ms one run plays for this goal. */
export function runLengthMs(goal: Goal): number {
  return BREAK_END_MS + (settles(goal) ? SETTLE_MS : 0);
}

function* stepTo(engine: Engine, untilMs: number): Generator<void, void, void> {
  let frames = 0;
  while (untilMs - engine.now > 1e-9) {
    engine.advance(Math.min(BREAK_FRAME_MS, untilMs - engine.now));
    if (++frames % SLICE_FRAMES === 0) yield;
  }
}

/** Play one seed of the design with a schedule and measure the goal. */
export function* playSeed(
  design: Topology,
  goal: Goal,
  attacks: readonly Attack[],
  seed: number,
): Generator<void, SeedRun, void> {
  const engine = new Engine(replayOf(design, attacks, seed), seed);
  yield* stepTo(engine, BREAK_WARMUP_MS);
  engine.startTally();
  yield* stepTo(engine, BREAK_END_MS);
  engine.stopTally();
  if (settles(goal)) yield* stepTo(engine, BREAK_END_MS + SETTLE_MS);
  const tally = engine.readTally();
  // Started above, and nothing here resets the engine.
  if (tally === null) throw new Error('tally missing after a run');
  return measureSeed(goal, tally, seed);
}

/** A goal's figure over a stopped tally, as `playSeed` measures it. */
export function measureSeed(goal: Goal, tally: RunTally, seed: number): SeedRun {
  const route = isRouteGoal(goal) ? tally.byRoute[goal.route] : undefined;
  const part = isRouteGoal(goal)
    ? (route ?? { arrived: 0, completed: 0, failed: 0, latencies: new Float64Array(0) })
    : tally;
  const settled = part.completed + part.failed;
  const keptUp = part.arrived > 0 ? settled / part.arrived : null;
  let actual: number | null;
  switch (goal.metric) {
    case 'errorRate':
      actual = settled > 0 ? (part.failed / settled) * 100 : null;
      break;
    case 'p99':
    case 'p95':
      actual = nearestRank(
        part.latencies.slice().sort(),
        goal.metric === 'p99' ? 0.99 : 0.95,
      );
      break;
    case 'lostWrites':
      actual = tally.writesAcked - tally.writesLanded;
      break;
    case 'lostJobs':
      actual = tally.jobsFailed;
      break;
    case 'queueDepth':
      actual = null;
      break;
  }
  // The check's own order: nothing through, then a backlog, then the goal.
  const outcome: SeedRun['outcome'] =
    part.completed === 0
      ? 'nothing-completed'
      : keptUp !== null && keptUp < KEPT_UP_FLOOR
        ? 'falling-behind'
        : actual !== null && actual <= goal.max
          ? 'passed'
          : 'goal-missed';
  return {
    seed,
    arrived: part.arrived,
    completed: part.completed,
    failed: part.failed,
    failuresByReason: isRouteGoal(goal)
      ? { ...(route?.failuresByReason ?? {}) }
      : tally.failuresByReason,
    keptUp,
    actual,
    outcome,
  };
}

/**
 * The fault-free run on every seed, measured for several goals at once, for
 * the panel's defaults. It always plays the settle time; a tally stops at
 * the window's end, so only lost writes and lost jobs read anything after it.
 */
export function* playBaselines(
  design: Topology,
  goals: readonly Goal[],
): Generator<void, Baseline[], void> {
  const runs: SeedRun[][] = goals.map(() => []);
  for (const seed of breakSeeds(design)) {
    const engine = new Engine(replayOf(design, [], seed), seed);
    yield* stepTo(engine, BREAK_WARMUP_MS);
    engine.startTally();
    yield* stepTo(engine, BREAK_END_MS);
    engine.stopTally();
    yield* stepTo(engine, BREAK_END_MS + SETTLE_MS);
    const tally = engine.readTally();
    if (tally === null) throw new Error('tally missing after a run');
    goals.forEach((g, i) => runs[i].push(measureSeed(g, tally, seed)));
  }
  return goals.map((g, i) => worstOf(runs[i], g));
}

function worstOf(runs: SeedRun[], goal: Goal): Baseline {
  let worst = runs[0];
  for (const r of runs) if (scoreOf(r, goal) > scoreOf(worst, goal)) worst = r;
  return { runs, worst };
}

/** Whether the goal counts whole things, where any one over the line is a miss. */
function counted(goal: Goal): boolean {
  return goal.metric === 'lostWrites' || goal.metric === 'lostJobs';
}

/**
 * Whether a run broke the goal, against the same seed with no faults. A
 * backlog or a dead route counts; a figure has to clear the goal and the
 * fault-free run by the margin.
 */
export function brokeOn(run: SeedRun, base: SeedRun, goal: Goal): boolean {
  if (run.outcome === 'passed') return false;
  if (run.outcome !== 'goal-missed' || run.actual === null) return true;
  if (counted(goal)) return run.actual > goal.max && run.actual > (base.actual ?? 0);
  const m = goal.max * BREAK_MARGIN;
  return run.actual > goal.max + m && run.actual > (base.actual ?? 0) + m;
}

/** How close a run came to falling behind: 1 at the floor. */
function backlogOf(run: SeedRun): number {
  return run.keptUp === null ? 0 : (1 - run.keptUp) / (1 - KEPT_UP_FLOOR);
}

/** How close a run came: 1 or more at the line `brokeOn` draws. */
export function scoreOf(run: SeedRun, goal: Goal): number {
  if (run.outcome === 'nothing-completed' || run.actual === null) return 1;
  const backlog = backlogOf(run);
  const line = counted(goal) ? goal.max + 1 : goal.max * (1 + BREAK_MARGIN);
  const figure = line > 0 ? run.actual / line : run.actual > 0 ? 1 : 0;
  return Math.max(backlog, figure);
}

/* ---------------- the wiring ---------------- */

interface Wire {
  id: string;
  from: string;
  to: string;
}

/** Request edges, as the check reads them: control edges carry no requests. */
function requestWires(t: Topology): Wire[] {
  const kinds = new Map(t.nodes.map((n) => [n.id, n.kind]));
  const out: Wire[] = [];
  for (const e of t.edges) {
    const from = kinds.get(e.from);
    if (from === undefined || !kinds.has(e.to)) continue;
    if (e.control === true || behaviourFor(from).controlsTarget === true) continue;
    out.push({ id: e.id, from: e.from, to: e.to });
  }
  return out;
}

function reach(
  wires: readonly Wire[],
  from: string,
  skipNode: string | null,
  skipEdge: string | null,
): Set<string> {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const w of wires) {
      if (w.from !== id || w.id === skipEdge || w.to === skipNode || seen.has(w.to))
        continue;
      seen.add(w.to);
      stack.push(w.to);
    }
  }
  return seen;
}

/**
 * The parts every request from some client has to pass through: take one
 * away and that client reaches nothing that can answer it. Something that
 * answers is the end of a line, or a kind that answers before the work is
 * done, such as a cache or a queue.
 */
export function singlePoints(t: Topology): SinglePoint[] {
  const wires = requestWires(t);
  const kindOf = new Map(t.nodes.map((n) => [n.id, n.kind]));
  const hasOut = new Set(wires.map((w) => w.from));
  const answers = (id: string): boolean => {
    const kind = kindOf.get(id);
    return kind !== undefined && (!hasOut.has(id) || SHORTCUT_KINDS.includes(kind));
  };
  const found = new Map<string, SinglePoint>();
  const add = (id: string, type: SinglePoint['type'], client: string) => {
    const known = found.get(id);
    if (known) known.clients.push(client);
    else found.set(id, { id, type, clients: [client] });
  };
  const clients = t.nodes
    .filter((n) => behaviourFor(n.kind).generatesLoad)
    .map((n) => n.id)
    .sort();
  for (const c of clients) {
    const live = reach(wires, c, null, null);
    const anyAnswer = (seen: Set<string>, not: string | null) => {
      for (const id of seen) if (id !== c && id !== not && answers(id)) return true;
      return false;
    };
    if (!anyAnswer(live, null)) continue;
    for (const id of [...live].sort()) {
      if (id === c) continue;
      if (!anyAnswer(reach(wires, c, id, null), id)) add(id, 'node', c);
    }
    for (const w of wires) {
      if (w.from === c || !live.has(w.from)) continue;
      if (!anyAnswer(reach(wires, c, null, w.id), null)) add(w.id, 'edge', c);
    }
  }
  return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Where a fault can go, and which kinds of fault it can take. */
export interface Target {
  id: string;
  type: 'node' | 'edge';
  kinds: AttackKind[];
}

/** The single points a goal is about: its client's, or anyone's. */
export function singlePointsFor(t: Topology, goal: Goal): SinglePoint[] {
  const all = singlePoints(t);
  return isRouteGoal(goal) ? all.filter((p) => p.clients.includes(goal.route)) : all;
}

/** Every place a fault can land under these options, in id order. */
export function breakTargets(t: Topology, goal: Goal, opts: BreakOptions): Target[] {
  const protect = new Set(opts.protect);
  const spof = new Set(
    opts.includeSinglePoints ? [] : singlePointsFor(t, goal).map((p) => p.id),
  );
  const allowed = new Set(opts.kinds);
  const out: Target[] = [];
  const clients = new Set(
    t.nodes.filter((n) => behaviourFor(n.kind).generatesLoad).map((n) => n.id),
  );
  for (const n of t.nodes) {
    const b = behaviourFor(n.kind);
    if (!b.servesRequests || b.generatesLoad || protect.has(n.id)) continue;
    const kinds: AttackKind[] = [];
    const whole = !spof.has(n.id);
    if (whole && allowed.has('crash')) kinds.push('crash');
    if (
      allowed.has('crash-instance') &&
      canCrashOneInstance(n.kind) &&
      (n.config.instances ?? 1) > 1
    ) {
      kinds.push('crash-instance');
    }
    if (allowed.has('slow')) kinds.push('slow');
    if (whole && allowed.has('errors')) kinds.push('errors');
    if (kinds.length > 0) out.push({ id: n.id, type: 'node', kinds });
  }
  if (allowed.has('cut')) {
    for (const w of requestWires(t)) {
      if (clients.has(w.from) || protect.has(w.from) || protect.has(w.to)) continue;
      if (protect.has(w.id) || spof.has(w.id)) continue;
      out.push({ id: w.id, type: 'edge', kinds: ['cut'] });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An attack at its hardest: the top of its ladder, from the first moment, to the end. */
function hardest(
  target: string,
  kind: AttackKind,
  atMs = FAULT_AT_MS,
  forMs: number | null = null,
): Attack {
  switch (kind) {
    case 'slow':
      return {
        kind,
        target,
        factor: BREAK_SLOW_FACTORS[BREAK_SLOW_FACTORS.length - 1],
        atMs,
        forMs,
      };
    case 'errors':
      return {
        kind,
        target,
        rate: BREAK_ERROR_RATES[BREAK_ERROR_RATES.length - 1],
        atMs,
        forMs,
      };
    default:
      return { kind, target, atMs, forMs };
  }
}

/** Whether a schedule puts two faults on one node or one edge. */
function clashes(attacks: readonly Attack[]): boolean {
  const seen = new Set<string>();
  for (const a of attacks) {
    if (seen.has(a.target)) return true;
    seen.add(a.target);
  }
  return false;
}

/**
 * Whether these options would try a remembered attack: its part is a target
 * and its kind is allowed there. A part the reader protected, a single point
 * left out, or an unchecked kind is skipped, not replayed.
 */
function stillFits(a: Attack, targets: ReadonlyMap<string, Target>): boolean {
  return targets.get(a.target)?.kinds.includes(a.kind) ?? false;
}

function exists(id: string, t: Topology): boolean {
  return t.nodes.some((n) => n.id === id) || t.edges.some((e) => e.id === id);
}

/* ---------------- the key ---------------- */

/**
 * What a search is about: the design as the engine runs it, its seed, the
 * goal and the options, in a canonical order. Where boxes sit and what they
 * are called are left out, so a drag does not throw an answer away.
 */
export function breakKey(design: Topology, goal: Goal, opts: BreakOptions): string {
  const run = {
    nodes: design.nodes.map((n) => ({ id: n.id, kind: n.kind, config: n.config })),
    edges: design.edges,
    seed: design.seed ?? DEFAULT_SEED,
    goal,
    opts: {
      ...opts,
      kinds: [...opts.kinds].sort(),
      protect: [...opts.protect].sort(),
    },
  };
  return hash53(canonical(run));
}

/* ---------------- goal templates ---------------- */

export interface GoalTemplate {
  /** Stable id for the radio group. */
  id: string;
  goal: Goal;
}

const PCT_STEPS = [1, 2, 5, 10, 20, 50];
const MS_STEPS = [100, 200, 300, 500, 1000, 2000, 5000, 10_000, 20_000];
const COUNT_STEPS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

function niceAtLeast(steps: readonly number[], x: number): number {
  for (const s of steps) if (s >= x) return s;
  return steps[steps.length - 1];
}

/**
 * A goal's default number: its own unless the design already sits within
 * half of it with no faults, in which case the next round number at or
 * above twice the worst fault-free run.
 */
export function defaultMax(goal: Goal, worst: number | null): number {
  const twice = worst === null ? 0 : worst * 2;
  switch (goal.metric) {
    case 'errorRate':
      return niceAtLeast(PCT_STEPS, Math.max(goal.max, twice));
    case 'p99':
    case 'p95':
      return niceAtLeast(MS_STEPS, Math.max(goal.max, twice));
    default:
      return niceAtLeast(COUNT_STEPS, Math.max(goal.max, twice));
  }
}

/** The goals the panel offers for this design, before any defaults. */
export function breakGoals(t: Topology): GoalTemplate[] {
  const clients = t.nodes
    .filter((n) => n.kind === 'client')
    .map((n) => n.id)
    .sort();
  const out: GoalTemplate[] = [{ id: 'up', goal: { metric: 'errorRate', max: 1 } }];
  if (clients.length > 1) {
    for (const c of clients) {
      out.push({ id: `up:${c}`, goal: { metric: 'errorRate', max: 1, route: c } });
    }
  }
  out.push({ id: 'fast', goal: { metric: 'p99', max: 300 } });
  if (clients.length > 1) {
    for (const c of clients) {
      out.push({ id: `fast:${c}`, goal: { metric: 'p99', max: 300, route: c } });
    }
  }
  if (t.nodes.some((n) => n.kind === 'writebehind')) {
    out.push({ id: 'writes', goal: { metric: 'lostWrites', max: 0 } });
  }
  if (t.nodes.some((n) => behaviourFor(n.kind).buffersForConsumers)) {
    out.push({ id: 'jobs', goal: { metric: 'lostJobs', max: 0 } });
  }
  return out;
}

/** Play the fault-free run on every seed, in slices. */
export function* playBaseline(
  design: Topology,
  goal: Goal,
): Generator<void, Baseline, void> {
  const runs: SeedRun[] = [];
  for (const seed of breakSeeds(design))
    runs.push(yield* playSeed(design, goal, [], seed));
  return worstOf(runs, goal);
}

/* ---------------- the search ---------------- */

interface Ctx {
  design: Topology;
  goal: Goal;
  seeds: [number, number, number];
  base: readonly SeedRun[];
  cache: Map<string, Trial>;
  simMs: number;
  progress: SearchProgress;
}

/**
 * Play a schedule on the design's own seed, and on the next two only if it
 * broke there. It counts as a break when the first seed and one of the
 * other two break, each against the same seed with no faults.
 */
export function* playTrial(
  design: Topology,
  goal: Goal,
  attacks: readonly Attack[],
  base: readonly SeedRun[],
): Generator<void, Trial, void> {
  const seeds = breakSeeds(design);
  const runs: SeedRun[] = [];
  let broke = false;
  for (let i = 0; i < 3; i++) {
    const run = yield* playSeed(design, goal, attacks, seeds[i]);
    runs.push(run);
    const hit = brokeOn(run, base[i], goal);
    if (i === 0 && !hit) break;
    if (i > 0 && hit) {
      broke = true;
      break;
    }
  }
  return { attacks: sortAttacks(attacks), runs, broke, score: scoreOf(runs[0], goal) };
}

/** A whole trial at once, for tests and scripts. */
export function trial(
  design: Topology,
  goal: Goal,
  attacks: readonly Attack[],
  base: readonly SeedRun[],
): Trial {
  const it = playTrial(searchDesign(design), goal, attacks, base);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}

/** `playTrial`, cached by schedule, reporting progress as it plays. */
function* tryAttacks(
  ctx: Ctx,
  attacks: readonly Attack[],
): Generator<SearchProgress, Trial, void> {
  const key = scheduleKey(attacks);
  const known = ctx.cache.get(key);
  if (known) return known;
  ctx.progress = { ...ctx.progress, current: sortAttacks(attacks) };
  const play = playTrial(ctx.design, ctx.goal, attacks, ctx.base);
  let step = play.next();
  while (!step.done) {
    yield ctx.progress;
    step = play.next();
  }
  const result = step.value;
  ctx.simMs += runLengthMs(ctx.goal) * result.runs.length;
  ctx.progress = { ...ctx.progress, simMs: ctx.simMs };
  ctx.cache.set(key, result);
  return result;
}

function weightedPick<T>(rng: Rng, items: readonly T[], weight: (t: T) => number): T {
  let total = 0;
  for (const it of items) total += weight(it);
  let r = rng.next() * total;
  for (const it of items) {
    r -= weight(it);
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

function pickOf<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.min(items.length - 1, Math.floor(rng.next() * items.length))];
}

/** An attack from the pool with a random severity, start and length. */
function varied(rng: Rng, a: Attack, atMs: number): Attack {
  const forMs = pickOf(rng, DURATIONS_MS);
  switch (a.kind) {
    case 'slow':
      return {
        kind: 'slow',
        target: a.target,
        factor: pickOf(rng, BREAK_SLOW_FACTORS),
        atMs,
        forMs,
      };
    case 'errors':
      return {
        kind: 'errors',
        target: a.target,
        rate: pickOf(rng, BREAK_ERROR_RATES),
        atMs,
        forMs,
      };
    default:
      return { kind: a.kind, target: a.target, atMs, forMs };
  }
}

/**
 * Search for a schedule that breaks the goal, in slices. Each `next()` plays
 * about a simulated second; the return value is the verdict. Abandoning the
 * generator is how a search stops, and resuming it carries on exactly where
 * it was.
 */
export function* searchBreak(
  input: Topology,
  goal: Goal,
  opts: BreakOptions,
  remembered: readonly (readonly Attack[])[] = [],
): Generator<SearchProgress, SearchResult, void> {
  const design = searchDesign(input);
  const notes: SearchNote[] = [];
  const ctx: Ctx = {
    design,
    goal,
    seeds: breakSeeds(design),
    base: [],
    cache: new Map(),
    simMs: 0,
    progress: {
      phase: 'baseline',
      tried: 0,
      budget: opts.budget,
      shrinkTried: 0,
      current: [],
      closest: null,
      simMs: 0,
      notes,
    },
  };

  const basePlay = playBaseline(design, goal);
  let bs = basePlay.next();
  while (!bs.done) {
    yield ctx.progress;
    bs = basePlay.next();
  }
  const baseline = bs.value;
  ctx.simMs += runLengthMs(goal) * baseline.runs.length;
  if (baseline.runs.some((r) => r.outcome !== 'passed')) {
    return { status: 'alreadyBroken', baseline, simMs: ctx.simMs };
  }
  ctx.base = baseline.runs;

  const targets = breakTargets(design, goal, opts);
  const byId = new Map(targets.map((t) => [t.id, t]));
  const rng = new Rng(Number.parseInt(breakKey(design, goal, opts), 36) % 4294967296);
  const seen = new Set<string>();
  let tried = 0;
  const bySize: [number, number, number] = [0, 0, 0];
  let closest: Closest | null = null;
  const singles: Trial[] = [];

  const note = (trial: Trial) => {
    if (trial.broke) return;
    if (closest === null || trial.score > closest.score) {
      const run = trial.runs[0];
      closest = {
        attacks: trial.attacks,
        actual: run.actual,
        score: trial.score,
        outcome: run.outcome,
        pilingUp: backlogOf(run) >= trial.score && trial.score > 0,
      };
    }
  };

  const finish = function* (
    found: Trial,
    foundAt: number,
    fromRemembered: boolean,
  ): Generator<SearchProgress, SearchResult, void> {
    ctx.progress = { ...ctx.progress, phase: 'shrink', tried };
    const shrunk = yield* shrinkBreak(ctx, found, opts);
    return {
      status: 'broke',
      attacks: shrunk.trial.attacks,
      run: shrunk.trial.runs[0],
      base: ctx.base[0],
      found: found.attacks,
      foundAt,
      fromRemembered,
      tried,
      shrinkTried: shrunk.tried,
      minimal: shrunk.minimal,
      simMs: ctx.simMs,
      notes,
      baseline,
    };
  };

  /* Remembered breaks, newest first, outside the budget. */
  ctx.progress = { ...ctx.progress, phase: 'remembered' };
  for (const r of remembered.slice(0, MAX_REMEMBERED)) {
    const gone = r.find((a) => !exists(a.target, design));
    if (gone) {
      notes.push({ kind: 'gone', target: gone.target });
      continue;
    }
    if (r.length === 0 || clashes(r) || !r.every((a) => stillFits(a, byId))) continue;
    const trial = yield* tryAttacks(ctx, r);
    seen.add(scheduleKey(r));
    if (trial.broke) return yield* finish(trial, 0, true);
    notes.push({ kind: 'holds', attacks: trial.attacks });
    ctx.progress = { ...ctx.progress, notes: notes.slice() };
  }

  const attempt = function* (
    attacks: Attack[],
  ): Generator<SearchProgress, Trial | null, void> {
    if (tried >= opts.budget || clashes(attacks)) return null;
    const key = scheduleKey(attacks);
    if (seen.has(key)) return null;
    seen.add(key);
    tried++;
    bySize[attacks.length - 1]++;
    const trial = yield* tryAttacks(ctx, attacks);
    note(trial);
    ctx.progress = { ...ctx.progress, tried, closest };
    return trial;
  };

  /* Singles: every target at its hardest, busiest part first. */
  ctx.progress = { ...ctx.progress, phase: 'single', tried };
  const busy = yield* busiest(ctx);
  const ordered = targets
    .slice()
    .sort(
      (a, b) => (busy.get(b.id) ?? 0) - (busy.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1),
    );
  const singleCap = Math.floor(opts.budget * 0.4);
  for (const t of ordered) {
    for (const kind of t.kinds) {
      if (tried >= singleCap) break;
      const trial = yield* attempt([hardest(t.id, kind)]);
      if (!trial) continue;
      if (trial.broke) return yield* finish(trial, tried, false);
      singles.push(trial);
    }
  }

  const pool = singles
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL_SIZE);
  const weight = (t: Trial) => t.score + 0.05;

  /* Pairs: every pool pair at its hardest, then with the second 2s later,
     then drawn from the pool with random timing and severity. */
  if (opts.maxFaults >= 2 && pool.length >= 2) {
    ctx.progress = { ...ctx.progress, phase: 'pair' };
    const pairCap = opts.maxFaults === 2 ? opts.budget : Math.floor(opts.budget * 0.75);
    for (const later of [FAULT_STARTS_MS[0], FAULT_STARTS_MS[1]]) {
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          if (tried >= pairCap) break;
          const a = pool[i].attacks[0];
          const b = pool[j].attacks[0];
          const trial = yield* attempt([a, { ...b, atMs: later }]);
          if (trial?.broke) return yield* finish(trial, tried, false);
        }
      }
    }
    let repeats = 0;
    while (tried < pairCap && repeats < MAX_REPEATS) {
      const a = weightedPick(rng, pool, weight).attacks[0];
      const b = weightedPick(rng, pool, weight).attacks[0];
      const before = tried;
      const trial = yield* attempt([
        varied(rng, a, FAULT_AT_MS),
        varied(rng, b, pickOf(rng, FAULT_STARTS_MS)),
      ]);
      repeats = tried === before ? repeats + 1 : 0;
      if (trial?.broke) return yield* finish(trial, tried, false);
    }
  }

  /* Three at once, with some ones and twos among them, for the rest. */
  if (opts.maxFaults >= 3 && pool.length >= 3) {
    ctx.progress = { ...ctx.progress, phase: 'triple' };
    let repeats = 0;
    while (tried < opts.budget && repeats < MAX_REPEATS) {
      const r = rng.next();
      const k = r < 0.2 ? 1 : r < 0.5 ? 2 : 3;
      const attacks: Attack[] = [];
      for (let i = 0; i < k; i++) {
        const a = weightedPick(rng, pool, weight).attacks[0];
        attacks.push(
          varied(rng, a, i === 0 ? FAULT_AT_MS : pickOf(rng, FAULT_STARTS_MS)),
        );
      }
      const before = tried;
      const trial = yield* attempt(attacks);
      repeats = tried === before ? repeats + 1 : 0;
      if (trial?.broke) return yield* finish(trial, tried, false);
    }
  }

  return {
    status: 'held',
    tried,
    budget: opts.budget,
    bySize,
    closest,
    simMs: ctx.simMs,
    notes,
    baseline,
  };
}

/**
 * Completed requests per second at each node, and at each edge's caller,
 * read once from the fault-free run on the design's own seed.
 */
function* busiest(ctx: Ctx): Generator<SearchProgress, Map<string, number>, void> {
  const engine = new Engine(replayOf(ctx.design, [], ctx.seeds[0]), ctx.seeds[0]);
  const play = stepTo(engine, FAULT_AT_MS);
  while (!play.next().done) yield ctx.progress;
  ctx.simMs += FAULT_AT_MS;
  const nodes = engine.snapshot().nodes;
  const out = new Map<string, number>();
  for (const n of ctx.design.nodes) out.set(n.id, nodes[n.id]?.throughput ?? 0);
  for (const e of ctx.design.edges) out.set(e.id, nodes[e.from]?.throughput ?? 0);
  return out;
}

/* ---------------- the shrink ---------------- */

/** One step down an attack's ladder, or null at the bottom. */
export function gentler(a: Attack, target: Target | undefined): Attack | null {
  switch (a.kind) {
    case 'slow': {
      const i = BREAK_SLOW_FACTORS.indexOf(a.factor);
      return i > 0 ? { ...a, factor: BREAK_SLOW_FACTORS[i - 1] } : null;
    }
    case 'errors': {
      const i = BREAK_ERROR_RATES.indexOf(a.rate);
      return i > 0 ? { ...a, rate: BREAK_ERROR_RATES[i - 1] } : null;
    }
    case 'crash':
      return target?.kinds.includes('crash-instance')
        ? { kind: 'crash-instance', target: a.target, atMs: a.atMs, forMs: a.forMs }
        : null;
    default:
      return null;
  }
}

/** One step shorter, or null at the shortest. */
export function shorter(a: Attack): Attack | null {
  const i = DURATIONS_MS.indexOf(a.forMs);
  return i > 0 ? { ...a, forMs: DURATIONS_MS[i - 1] } : null;
}

/** Every schedule one step smaller than this one. */
export function neighbours(
  attacks: readonly Attack[],
  targets: ReadonlyMap<string, Target>,
): Attack[][] {
  const out: Attack[][] = [];
  if (attacks.length > 1) {
    for (let i = 0; i < attacks.length; i++)
      out.push(attacks.filter((_, j) => j !== i));
  }
  for (const step of [(a: Attack) => gentler(a, targets.get(a.target)), shorter]) {
    for (let i = 0; i < attacks.length; i++) {
      const next = step(attacks[i]);
      if (next) out.push(attacks.map((a, j) => (j === i ? next : a)));
    }
  }
  return out;
}

/**
 * Make a break smaller: fewer faults, then gentler ones, then shorter ones,
 * keeping each change that still breaks it. Start times stay where they
 * were found. Stops after a pass that changes nothing, or at the cap.
 */
function* shrinkBreak(
  ctx: Ctx,
  found: Trial,
  opts: BreakOptions,
): Generator<SearchProgress, { trial: Trial; tried: number; minimal: boolean }, void> {
  const targets = new Map(
    breakTargets(ctx.design, ctx.goal, opts).map((t) => [t.id, t]),
  );
  let best = found;
  let tried = 0;
  const check = function* (
    attacks: Attack[],
  ): Generator<SearchProgress, Trial | null, void> {
    const cached = ctx.cache.has(scheduleKey(attacks));
    if (!cached && tried >= SHRINK_CAP) return null;
    if (!cached) tried++;
    ctx.progress = { ...ctx.progress, shrinkTried: tried };
    return yield* tryAttacks(ctx, attacks);
  };
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    // Drop faults, starting again after each drop.
    for (let i = 0; i < best.attacks.length && best.attacks.length > 1;) {
      const t = yield* check(best.attacks.filter((_, j) => j !== i));
      if (t?.broke) {
        best = t;
        changed = true;
        i = 0;
      } else i++;
    }
    for (const step of [(a: Attack) => gentler(a, targets.get(a.target)), shorter]) {
      for (let i = 0; i < best.attacks.length; i++) {
        for (;;) {
          const next = step(best.attacks[i]);
          if (!next) break;
          const t = yield* check(best.attacks.map((a, j) => (j === i ? next : a)));
          if (!t?.broke) break;
          // Sorting can move the attack; find it again by target.
          best = t;
          changed = true;
          i = best.attacks.findIndex((a) => a.target === next.target);
        }
      }
    }
    if (!changed) break;
  }
  let minimal = true;
  for (const n of neighbours(best.attacks, targets)) {
    const known = ctx.cache.get(scheduleKey(n));
    if (!known || known.broke) minimal = false;
  }
  return { trial: best, tried, minimal };
}

/** Run a search to the end. For tests and scripts; the interface slices it. */
export function runSearch(
  design: Topology,
  goal: Goal,
  opts: BreakOptions,
  remembered: readonly (readonly Attack[])[] = [],
): SearchResult {
  const it = searchBreak(design, goal, opts, remembered);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}
