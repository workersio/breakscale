import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Challenge } from '../sim/challenge';
import { PRESETS } from '../sim/presets';
import { challengeById } from '../sim/challenges';
import { incidentById } from '../sim/incidents';
import type { Topology } from '../sim/types';
import type { ChallengeBadge } from '../challengeWorkspace';
import { LEARNING_PATH, type PathStep } from '../content/learningPath';

/* ------------------------------------------------------------------ *
 * Progress along the learning path.
 *
 * A challenge is done when it is passed, and the challenge store already
 * knows that, so it stays the one place a pass is recorded. An example has
 * no verdict of its own, so it is done when its task is: every step of it
 * ticked off from what the engine measured (see exampleTask.ts). Opening
 * one, or turning the load up without anything breaking, does not count.
 *
 * An earlier rule counted ten seconds at twice the starting load. At that
 * load seven examples showed nothing wrong at all, so it marked them done
 * before the student had seen the lesson. Examples it already marked stay
 * marked: the stored list is read the same way.
 * ------------------------------------------------------------------ */

export const PATH_KEY = 'breakscale.path.v1';

/** Total load the clients offer: what the top bar's slider sets. */
export function offeredLoad(topology: Topology): number {
  let sum = 0;
  for (const n of topology.nodes) if (n.kind === 'client') sum += n.config.rps ?? 0;
  return sum;
}

/** Every example's id. */
const EXAMPLE_IDS: ReadonlySet<string> = new Set(PRESETS.map((p) => p.id));

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
      list.filter((id): id is string => typeof id === 'string' && EXAMPLE_IDS.has(id)),
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
 * The examples done. An external store, so a finished task marks one and
 * React re-renders once, when it is newly done.
 */
export class PathProgress {
  private explored: ReadonlySet<string>;
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
   * Mark an example done: its task finished, or the first-visit tour, which
   * only ends once the engine showed the first example full and then fixed.
   */
  credit(presetId: string): void {
    if (this.explored.has(presetId) || !EXAMPLE_IDS.has(presetId)) return;
    this.explored = new Set([...this.explored, presetId]);
    this.save(this.explored);
    for (const listener of this.listeners) listener();
  }
}

/**
 * The examples done so far. `credit` is an example to mark done now, or
 * null; marking is storage, so it happens in an effect.
 */
export function usePathProgress(credit: string | null): ReadonlySet<string> {
  const [progress] = useState(() => new PathProgress(loadExplored()));
  useEffect(() => {
    if (credit) progress.credit(credit);
  }, [progress, credit]);
  return useSyncExternalStore(progress.subscribe, progress.getExplored);
}

/* ---------------- where the student stands ---------------- */

export type StepStatus = 'done' | 'started' | 'todo';

/**
 * The brief a step is judged by: a challenge's own, or the one a real
 * outage hands over to with Fix it. Null for an example.
 */
export function briefIdOf(step: PathStep): string | null {
  if (step.kind === 'example') return null;
  if (step.kind === 'challenge') return step.id;
  return incidentById(step.id)?.brief.id ?? null;
}

/** The path step a brief belongs to, an outage's included, or null. */
export function stepOfBrief(briefId: string): PathStep | null {
  for (const track of LEARNING_PATH) {
    for (const step of track.steps) {
      if (step.kind !== 'example' && briefIdOf(step) === briefId) return step;
    }
  }
  return null;
}

/** A step's name as the gallery, the picker or the outages list shows it. */
export function stepName(step: PathStep): string {
  switch (step.kind) {
    case 'example':
      return PRESETS.find((p) => p.id === step.id)?.name ?? step.id;
    case 'challenge':
      return challengeById(step.id)?.name ?? step.id;
    case 'incident':
      return incidentById(step.id)?.name ?? step.id;
  }
}

export function stepStatus(
  step: PathStep,
  explored: ReadonlySet<string>,
  badgeOf: (id: string) => ChallengeBadge,
): StepStatus {
  if (step.kind === 'example') return explored.has(step.id) ? 'done' : 'todo';
  const brief = briefIdOf(step);
  const badge = brief === null ? null : badgeOf(brief);
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

/**
 * The step after this one in path order, or null after the last. By kind
 * and id: an outage's id is also its brief's.
 */
export function stepAfter(id: string, kind?: PathStep['kind']): PathStep | null {
  const all = LEARNING_PATH.flatMap((t) => t.steps);
  const i = all.findIndex(
    (s) => s.id === id && (kind === undefined || s.kind === kind),
  );
  return i < 0 ? null : (all[i + 1] ?? null);
}
