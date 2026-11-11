import { behaviourFor } from './behaviour';
import {
  ATTACK_KINDS,
  DEFAULT_OPTIONS,
  replayOf,
  searchBreak,
  singlePointsFor,
  toSchedule,
} from './breakit';
import type {
  Attack,
  AttackKind,
  BreakOptions,
  SearchProgress,
  SearchResult,
  SeedRun,
  SinglePoint,
} from './breakit';
import type { Goal } from './challenge';
import type { FaultEvent, Topology } from './types';

/* ------------------------------------------------------------------ *
 * The "Can you break it?" search without the panel: a design and a goal
 * in, a verdict out. It wraps `searchBreak`, the same search the panel
 * steps, so an answer here is the answer the panel gives for the same
 * design, goal and options.
 *
 * Deterministic: no wall clock anywhere. Budgets count schedules and
 * simulated seconds, so the same input gives the same verdict on any
 * machine, however fast.
 *
 *   import { verify } from './sim/verify';
 *
 *   const v = verify(design, { metric: 'errorRate', max: 1 }, { budget: 100 });
 *   switch (v.status) {
 *     case 'broken':
 *       // v.schedule is the smallest set of faults found; v.measured.actual
 *       // is the figure it caused, against v.withoutFaults.actual.
 *       // v.replay is the design with v.faults and v.measured.seed: play it,
 *       // or encode it as a share link, and the same run plays again.
 *       break;
 *     case 'held':          // v.tried schedules, v.stoppedBy, v.closest
 *     case 'alreadyBroken': // misses the goal with no faults: v.measured
 *     case 'invalid':       // v.errors, in plain words
 *   }
 *
 * Goals:
 * - errorRate (percent), p99 and p95 (ms), optionally for one client's
 *   requests with `route` set to that client's id.
 * - lostWrites and lostJobs (counts), system-wide only.
 * - A backlog is not a goal of its own: a run that stops keeping up with
 *   its arrivals (`outcome: 'falling-behind'`) breaks every goal, and so
 *   does one where nothing completes.
 *
 * `verifySteps` is the same search as a generator, one simulated second
 * per step, for a caller that wants progress or its own time slicing.
 * ------------------------------------------------------------------ */

export type VerifyMetric = 'errorRate' | 'p99' | 'p95' | 'lostWrites' | 'lostJobs';

export const VERIFY_METRICS: readonly VerifyMetric[] = [
  'errorRate',
  'p99',
  'p95',
  'lostWrites',
  'lostJobs',
];

export interface VerifyGoal {
  metric: VerifyMetric;
  /** Percent for errorRate, ms for p99 and p95, a count for lostWrites and lostJobs. */
  max: number;
  /** A client's id: the goal is about that client's requests only. */
  route?: string;
}

export interface VerifyOptions {
  /** Fault kinds to try. Default: all of them. */
  kinds?: readonly AttackKind[];
  /** Most faults in one schedule. Default 3. */
  maxFaults?: 1 | 2 | 3;
  /** Schedules to try. Default 500. */
  budget?: number;
  /**
   * Simulated seconds after which no new schedule starts. The one playing
   * finishes and a break found is still made smaller, so a verdict can
   * report a little more than this.
   */
  maxSimSeconds?: number;
  /** The run's seed. Default: the design's own, or 1. */
  seed?: number;
  /** Node and edge ids never to fault. */
  protect?: readonly string[];
  /** Also crash, fail and cut the parts every request passes through. */
  includeSinglePoints?: boolean;
  /** Schedules that broke it before, tried first and outside the budget. */
  remembered?: readonly (readonly Attack[])[];
}

/** A schedule that came close without breaking it. */
export interface VerifyClosest {
  schedule: Attack[];
  actual: number | null;
  outcome: SeedRun['outcome'];
  /** How close it came: 1 or more is past the line. */
  score: number;
  /** The backlog, not the goal's figure, is what came close. */
  pilingUp: boolean;
}

export type Verdict =
  | {
      status: 'broken';
      goal: VerifyGoal;
      /** The smallest schedule found, in time order. */
      schedule: Attack[];
      /** The schedule as the engine's fault events, the ones `replay` carries. */
      faults: FaultEvent[];
      /** Every one-step-smaller schedule was tried and met the goal. */
      minimal: boolean;
      /** The run with the schedule, on the seed `replay` plays. */
      measured: SeedRun;
      /** The same seed with no faults. */
      withoutFaults: SeedRun;
      /** The design with the faults and the seed: playing it repeats the run. */
      replay: Topology;
      /** Schedules tried from the budget, then by the shrink. */
      tried: number;
      shrinkTried: number;
      simSeconds: number;
      singlePoints: SinglePoint[];
    }
  | {
      status: 'held';
      goal: VerifyGoal;
      tried: number;
      /** Schedules tried with one, two and three faults. */
      bySize: [number, number, number];
      stoppedBy: 'budget' | 'simSeconds' | 'exhausted';
      closest: VerifyClosest | null;
      simSeconds: number;
      singlePoints: SinglePoint[];
    }
  | {
      status: 'alreadyBroken';
      goal: VerifyGoal;
      /** The fault-free run that missed it by the most. */
      measured: SeedRun;
      /** Every seed's fault-free run. */
      runs: SeedRun[];
      simSeconds: number;
      singlePoints: SinglePoint[];
    }
  | { status: 'invalid'; errors: string[] };

const MAX_SEED = 4294967295;

/** What is wrong with a request, in plain words. Empty when nothing is. */
export function verifyErrors(
  design: Topology,
  goal: VerifyGoal,
  opts: VerifyOptions = {},
): string[] {
  const errors: string[] = [];
  const clients = design.nodes.filter((n) => behaviourFor(n.kind).generatesLoad);
  if (clients.length === 0) {
    errors.push('The design has no client, so nothing sends requests to break.');
  }
  if (!VERIFY_METRICS.includes(goal.metric)) {
    errors.push(
      `The goal's metric "${String(goal.metric)}" cannot be searched. Use one of ${VERIFY_METRICS.join(', ')}.`,
    );
  }
  if (typeof goal.max !== 'number' || !Number.isFinite(goal.max) || goal.max < 0) {
    errors.push("The goal's max must be a number, 0 or more.");
  }
  if (goal.route !== undefined) {
    if (goal.metric === 'lostWrites' || goal.metric === 'lostJobs') {
      errors.push(
        `${goal.metric} is counted for the whole system, so it cannot be about one route. Leave route out.`,
      );
    } else if (!clients.some((n) => n.id === goal.route)) {
      errors.push(
        `The route "${goal.route}" is not a client in the design. A route is the id of a client.`,
      );
    }
  }
  if (opts.kinds !== undefined) {
    const bad = opts.kinds.filter((k) => !ATTACK_KINDS.includes(k));
    if (bad.length > 0) {
      errors.push(
        `Unknown fault kinds: ${bad.join(', ')}. Use any of ${ATTACK_KINDS.join(', ')}.`,
      );
    } else if (opts.kinds.length === 0) {
      errors.push('Pick at least one fault kind to try.');
    }
  }
  if (opts.maxFaults !== undefined && ![1, 2, 3].includes(opts.maxFaults)) {
    errors.push('maxFaults must be 1, 2 or 3.');
  }
  if (
    opts.budget !== undefined &&
    !(Number.isInteger(opts.budget) && opts.budget >= 0)
  ) {
    errors.push('budget must be a whole number of schedules, 0 or more.');
  }
  if (
    opts.maxSimSeconds !== undefined &&
    !(Number.isFinite(opts.maxSimSeconds) && opts.maxSimSeconds > 0)
  ) {
    errors.push('maxSimSeconds must be a number of seconds above 0.');
  }
  if (
    opts.seed !== undefined &&
    !(Number.isInteger(opts.seed) && opts.seed >= 0 && opts.seed <= MAX_SEED)
  ) {
    errors.push(`seed must be a whole number from 0 to ${MAX_SEED}.`);
  }
  return errors;
}

/**
 * The search the panel runs, with options filled from the defaults and the
 * seed written into the design. Returns the panel's detailed result; most
 * callers want `verify` or `verifySteps`. Assumes a request `verifyErrors`
 * passed.
 */
export function* searchSteps(
  design: Topology,
  goal: Goal,
  opts: VerifyOptions = {},
): Generator<SearchProgress, SearchResult, void> {
  return yield* searchBreak(
    withSeed(design, opts.seed),
    goal,
    breakOptions(opts),
    opts.remembered,
    opts.maxSimSeconds === undefined ? {} : { maxSimMs: opts.maxSimSeconds * 1000 },
  );
}

/** `verify` as a generator: one simulated second per step. */
export function* verifySteps(
  design: Topology,
  goal: VerifyGoal,
  opts: VerifyOptions = {},
): Generator<SearchProgress, Verdict, void> {
  const errors = verifyErrors(design, goal, opts);
  if (errors.length > 0) return { status: 'invalid', errors };
  const result = yield* searchSteps(design, goal, opts);
  return verdictOf(withSeed(design, opts.seed), goal, result);
}

/** Search for a schedule of faults that makes the design miss the goal. */
export function verify(
  design: Topology,
  goal: VerifyGoal,
  opts: VerifyOptions = {},
): Verdict {
  const it = verifySteps(design, goal, opts);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}

/* Unset options take the panel's defaults, so the search's key and its
   random draws match the panel's. */
function breakOptions(opts: VerifyOptions): BreakOptions {
  return {
    budget: opts.budget ?? DEFAULT_OPTIONS.budget,
    maxFaults: opts.maxFaults ?? DEFAULT_OPTIONS.maxFaults,
    kinds: opts.kinds ?? DEFAULT_OPTIONS.kinds,
    protect: opts.protect ?? DEFAULT_OPTIONS.protect,
    includeSinglePoints:
      opts.includeSinglePoints ?? DEFAULT_OPTIONS.includeSinglePoints,
  };
}

function withSeed(design: Topology, seed: number | undefined): Topology {
  return seed === undefined ? design : { ...design, seed };
}

function verdictOf(design: Topology, goal: VerifyGoal, r: SearchResult): Verdict {
  const singlePoints = singlePointsFor(design, goal);
  const simSeconds = r.simMs / 1000;
  switch (r.status) {
    case 'alreadyBroken':
      return {
        status: 'alreadyBroken',
        goal,
        measured: r.baseline.worst,
        runs: r.baseline.runs,
        simSeconds,
        singlePoints,
      };
    case 'held':
      return {
        status: 'held',
        goal,
        tried: r.tried,
        bySize: r.bySize,
        stoppedBy: r.stoppedBy,
        closest:
          r.closest === null
            ? null
            : {
                schedule: r.closest.attacks,
                actual: r.closest.actual,
                outcome: r.closest.outcome,
                score: r.closest.score,
                pilingUp: r.closest.pilingUp,
              },
        simSeconds,
        singlePoints,
      };
    case 'broke':
      return {
        status: 'broken',
        goal,
        schedule: r.attacks,
        faults: toSchedule(r.attacks),
        minimal: r.minimal,
        measured: r.run,
        withoutFaults: r.base,
        replay: replayOf(design, r.attacks, r.run.seed),
        tried: r.tried,
        shrinkTried: r.shrinkTried,
        simSeconds,
        singlePoints,
      };
  }
}
