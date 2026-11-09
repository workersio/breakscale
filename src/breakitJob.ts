import { playBaselines, searchBreak } from './sim/breakit';
import type {
  Attack,
  Baseline,
  BreakOptions,
  SearchProgress,
  SearchResult,
} from './sim/breakit';
import type { Goal } from './sim/challenge';
import type { Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * The work "Can you break it?" hands off, in a shape that can cross to a
 * worker: plain data in, a generator out. The worker and the main-thread
 * fallback both step the same generator, so where it runs never changes
 * what it finds.
 * ------------------------------------------------------------------ */

export type BreakJob =
  | { kind: 'baseline'; design: Topology; goals: Goal[] }
  | {
      kind: 'search';
      design: Topology;
      goal: Goal;
      opts: BreakOptions;
      remembered: Attack[][];
    };

export type BreakJobResult =
  | { kind: 'baseline'; baselines: Baseline[] }
  | { kind: 'search'; result: SearchResult };

export type ToWorker =
  | { type: 'start'; id: number; job: BreakJob }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'progress'; id: number; progress: SearchProgress }
  | { type: 'done'; id: number; result: BreakJobResult };

/** Most often progress is reported, in ms. */
export const PROGRESS_EVERY_MS = 100;

/** The job as a generator. Yields progress, or undefined inside a baseline. */
export function* runJob(
  job: BreakJob,
): Generator<SearchProgress | void, BreakJobResult, void> {
  if (job.kind === 'baseline') {
    const baselines = yield* playBaselines(job.design, job.goals);
    return { kind: 'baseline', baselines };
  }
  const result = yield* searchBreak(job.design, job.goal, job.opts, job.remembered);
  return { kind: 'search', result };
}

/**
 * Step a job in slices of `budgetMs` on whatever thread calls it, reporting
 * progress at most every `PROGRESS_EVERY_MS`. Returns controls; `schedule`
 * is how the next slice is queued.
 */
export function pumpJob(
  job: BreakJob,
  budgetMs: number,
  onProgress: (p: SearchProgress) => void,
  onDone: (r: BreakJobResult) => void,
  schedule: (fn: () => void) => void,
): { pause: () => void; resume: () => void; stop: () => void } {
  const it = runJob(job);
  let paused = false;
  let stopped = false;
  let queued = false;
  let lastPost = -Infinity;
  const slice = () => {
    queued = false;
    if (paused || stopped) return;
    const t0 = performance.now();
    let latest: SearchProgress | undefined;
    for (;;) {
      const step = it.next();
      if (step.done) {
        stopped = true;
        onDone(step.value);
        return;
      }
      if (step.value) latest = step.value;
      const now = performance.now();
      if (now - t0 >= budgetMs) {
        if (latest && now - lastPost >= PROGRESS_EVERY_MS) {
          lastPost = now;
          onProgress(latest);
        }
        break;
      }
    }
    queued = true;
    schedule(slice);
  };
  queued = true;
  schedule(slice);
  return {
    pause: () => {
      paused = true;
    },
    resume: () => {
      if (stopped || !paused) return;
      paused = false;
      if (!queued) {
        queued = true;
        schedule(slice);
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
