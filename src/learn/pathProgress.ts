import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Challenge } from '../sim/challenge';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';
import type { ChallengeBadge } from '../challengeWorkspace';
import { LEARNING_PATH, type PathStep } from '../content/learningPath';

/* ------------------------------------------------------------------ *
 * Progress along the learning path.
 *
 * A challenge is done when it is passed, and the challenge store already
 * knows that, so it stays the one place a pass is recorded. An example has
 * no verdict, so "done" is a measured rule instead of a click: the student
 * ran it at twice its starting load or more for 10 seconds of simulated
 * time. Every example is stable at its starting load and degrades by 2x to
 * 4x, so that is the run in which they saw it break. Opening one and closing
 * it again does not count.
 * ------------------------------------------------------------------ */

export const PATH_KEY = 'breakscale.path.v1';
/** Load, as a multiple of the example's own, that counts as pushing it. */
export const EXPLORE_FACTOR = 2;
/** Simulated time it has to run there. */
export const EXPLORE_MS = 10_000;
/**
 * The most one snapshot can add. Snapshots arrive ten a second, so a bigger
 * gap is a tab coming back from the background or a fast-forward, and a
 * second of it is all that is credited.
 */
const MAX_STEP_MS = 1000;

/** Total load the clients offer: what the top bar's slider sets. */
export function offeredLoad(topology: Topology): number {
  let sum = 0;
  for (const n of topology.nodes) if (n.kind === 'client') sum += n.config.rps ?? 0;
  return sum;
}

/** Each example's starting load, read once from the presets themselves. */
const STARTING_LOAD: ReadonlyMap<string, number> = new Map(
  PRESETS.map((p) => [p.id, offeredLoad(p.topology)]),
);

/* ---------------- storage ---------------- */

/**
 * The examples explored, as stored. Ids that are not an example any more are
 * dropped. Corrupt or blocked storage reads as nothing explored, never as a
 * failed boot.
 */
export function loadExplored(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(PATH_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { explored?: unknown } | null)?.explored;
    if (!Array.isArray(list)) return new Set();
    return new Set(
      list.filter(
        (id): id is string => typeof id === 'string' && STARTING_LOAD.has(id),
      ),
    );
  } catch {
    return new Set();
  }
}

export function saveExplored(
  explored: ReadonlySet<string>,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(PATH_KEY, JSON.stringify({ explored: [...explored] }));
  } catch {
    // Quota or blocked storage: progress lasts this visit only.
  }
}

/* ---------------- the tracker ---------------- */

/**
 * Watches the run and marks an example explored. An external store, so the
 * snapshot effect only feeds it and React re-renders once, when an example
 * is newly done, rather than on every snapshot.
 */
export class PathProgress {
  private explored: ReadonlySet<string>;
  private presetId: string | null = null;
  private heldMs = 0;
  private lastMs = 0;
  private readonly listeners = new Set<() => void>();
  private readonly save: (explored: ReadonlySet<string>) => void;

  constructor(
    initial: ReadonlySet<string>,
    save: (explored: ReadonlySet<string>) => void = saveExplored,
  ) {
    this.explored = initial;
    this.save = save;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getExplored = (): ReadonlySet<string> => this.explored;

  /**
   * One snapshot of the run. `presetId` is the example on the canvas, or null
   * when it is the student's own design or a challenge's.
   */
  observe(presetId: string | null, topology: Topology, timeMs: number): void {
    if (presetId !== this.presetId) {
      this.presetId = presetId;
      this.heldMs = 0;
      this.lastMs = timeMs;
      return;
    }
    const dt = timeMs - this.lastMs;
    this.lastMs = timeMs;
    if (presetId === null || this.explored.has(presetId) || dt <= 0) return;
    const start = STARTING_LOAD.get(presetId);
    if (start === undefined || offeredLoad(topology) < start * EXPLORE_FACTOR) return;
    this.heldMs += Math.min(dt, MAX_STEP_MS);
    if (this.heldMs < EXPLORE_MS) return;
    this.credit(presetId);
  }

  /**
   * Mark an example explored on other evidence: the first-visit tour, which
   * only finishes once the engine showed that example full and then fixed.
   * Its fix is an edit, which takes the canvas off the example, so the
   * 10 second rule above could not have counted it.
   */
  credit(presetId: string): void {
    if (this.explored.has(presetId) || !STARTING_LOAD.has(presetId)) return;
    this.explored = new Set([...this.explored, presetId]);
    this.save(this.explored);
    for (const listener of this.listeners) listener();
  }
}

/**
 * The examples explored so far, kept up to date from the run.
 *
 * `presetId` is null inside a challenge: a brief is set in an example's
 * system, but it is the brief being worked on, not the example.
 */
export function usePathProgress(
  presetId: string | null,
  topology: Topology,
  snapshot: SimSnapshot | null,
  /** An example to count as explored now, see `PathProgress.credit`. */
  credit: string | null = null,
): ReadonlySet<string> {
  const [progress] = useState(() => new PathProgress(loadExplored()));
  useEffect(() => {
    if (snapshot) progress.observe(presetId, topology, snapshot.system.timeMs);
  }, [progress, presetId, topology, snapshot]);
  useEffect(() => {
    if (credit) progress.credit(credit);
  }, [progress, credit]);
  return useSyncExternalStore(progress.subscribe, progress.getExplored);
}

/* ---------------- where the student stands ---------------- */

export type StepStatus = 'done' | 'started' | 'todo';

export function stepStatus(
  step: PathStep,
  explored: ReadonlySet<string>,
  badgeOf: (id: string) => ChallengeBadge,
): StepStatus {
  if (step.kind === 'example') return explored.has(step.id) ? 'done' : 'todo';
  const badge = badgeOf(step.id);
  return badge === 'passed' ? 'done' : badge === 'in-progress' ? 'started' : 'todo';
}

/** The first step not done, in path order, or null when every one is. */
export function nextStep(
  explored: ReadonlySet<string>,
  badgeOf: (id: string) => ChallengeBadge,
): PathStep | null {
  for (const track of LEARNING_PATH) {
    for (const step of track.steps) {
      if (stepStatus(step, explored, badgeOf) !== 'done') return step;
    }
  }
  return null;
}

/** A badge lookup by id, for a caller that holds `badgeOf(challenge)`. */
export function badgeById(
  challenges: readonly Challenge[],
  badgeOf: (c: Challenge) => ChallengeBadge,
): (id: string) => ChallengeBadge {
  const byId = new Map(challenges.map((c) => [c.id, c]));
  return (id) => {
    const c = byId.get(id);
    return c ? badgeOf(c) : null;
  };
}
