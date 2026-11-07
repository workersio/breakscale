import type { Challenge } from './sim/challenge';
import { judgedTopology, startDesign } from './sim/judge';
import { isNote, sanitizeAnnotations } from './sim/annotations';
import { sanitizeFaults } from './sim/faults';
import { sanitizeSeed } from './sim/seed';
import type { Topology } from './sim/types';
import { isTopology } from './clipboard';

/* ------------------------------------------------------------------ *
 * A challenge is its own workspace.
 *
 * Starting one used to replace whatever was on the canvas, behind a confirm
 * that asked the reader to gamble their design on undo. Now their design is
 * set aside instead, untouched, and the brief gets a canvas of its own. Each
 * brief keeps its attempt here, so leaving one and coming back later picks
 * up where it was, and a reload in the middle of one comes back to it.
 *
 * Kept apart from `breakscale.session.v1`, which is the reader's own design
 * and is never written while a brief holds the canvas. That is the whole
 * promise: nothing done inside a challenge can reach their design.
 * ------------------------------------------------------------------ */

export const CHALLENGES_KEY = 'breakscale.challenges.v1';

/** One brief's attempt, as last saved. */
export interface Attempt {
  /** The brief's version when this was saved. A newer brief starts over. */
  version: number;
  topology: Topology;
  /** How many hints the reader has asked for on this attempt. */
  hintsShown: number;
}

/** A brief passed by a check. Written when the check passes, not on Done. */
export interface Passed {
  version: number;
  /** ISO time of the first passing check on this version. */
  passedAt: string;
  hintsUsed: number;
}

export interface ChallengeStore {
  /** The brief on the canvas, or null when the reader's own design is. */
  active: string | null;
  attempts: Readonly<Record<string, Attempt>>;
  progress: Readonly<Record<string, Passed>>;
}

export const EMPTY_STORE: ChallengeStore = { active: null, attempts: {}, progress: {} };

/* ---------------- the design a brief starts from ---------------- */

/**
 * The design with the brief's fixed fields and load written into it, and
 * everything else the reader's.
 *
 * The check puts these back before it runs anyway, so this changes no
 * verdict. It is for the live view: a database added inside a brief would
 * otherwise run at the default service time while the check ran it at the
 * brief's, and a second client would add its own traffic on top of the load
 * the brief states. The two would disagree, and the reader would be watching
 * a system the check is not judging.
 */
export function conform(challenge: Challenge, design: Topology): Topology {
  const judged = judgedTopology(challenge, design).topology;
  return {
    ...design,
    nodes: design.nodes.map((n, i) => ({ ...n, config: judged.nodes[i]!.config })),
  };
}

/**
 * A fresh attempt: the brief's preset at the brief's load, carrying the
 * brief's faults so Reset replays them, with the preset's notes taken off.
 *
 * The notes go because they were written to teach the example, and on most
 * presets one of them names what to drag and what happens, which is the
 * answer. The sections stay: they name what each tier does, not what is
 * wrong with it.
 */
export function freshStart(challenge: Challenge): Topology {
  const start = structuredClone(startDesign(challenge));
  const annotations = (start.annotations ?? []).filter((a) => !isNote(a));
  const faults = challenge.faults ? structuredClone([...challenge.faults]) : [];
  return conform(challenge, {
    nodes: start.nodes,
    edges: start.edges,
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(faults.length > 0 ? { faults } : {}),
  });
}

/* ---------------- storage ---------------- */

/**
 * A stored topology through the same gates the session's goes through, or
 * null. Anything malformed costs only that attempt, never the store.
 */
function cleanTopology(raw: unknown): Topology | null {
  if (!isTopology(raw)) return null;
  const annotations = sanitizeAnnotations(
    (raw as { annotations?: unknown }).annotations,
  );
  const faults = sanitizeFaults((raw as { faults?: unknown }).faults, raw);
  const seed = sanitizeSeed((raw as { seed?: unknown }).seed);
  return {
    nodes: raw.nodes,
    edges: raw.edges,
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(faults.length > 0 ? { faults } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
}

const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Read the store. Entries for a brief that no longer exists, or that was
 * saved against an older version of it, are dropped: an attempt at a brief
 * whose load or goal has since changed is an attempt at something else, and
 * a pass of the old one is not a pass of this one.
 */
export function loadChallengeStore(
  challenges: readonly Challenge[],
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): ChallengeStore {
  try {
    const raw = storage?.getItem(CHALLENGES_KEY);
    if (!raw) return EMPTY_STORE;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return EMPTY_STORE;
    }
    const p = parsed as Partial<Record<keyof ChallengeStore, unknown>>;
    const current = new Map(challenges.map((c) => [c.id, c.version]));

    const attempts: Record<string, Attempt> = {};
    if (p.attempts && typeof p.attempts === 'object') {
      for (const [id, a] of Object.entries(p.attempts as Record<string, unknown>)) {
        if (!a || typeof a !== 'object') continue;
        const at = a as Partial<Record<keyof Attempt, unknown>>;
        if (at.version !== current.get(id)) continue;
        const topology = cleanTopology(at.topology);
        if (!topology) continue;
        attempts[id] = {
          version: at.version as number,
          topology,
          hintsShown: whole(at.hintsShown) ? at.hintsShown : 0,
        };
      }
    }

    const progress: Record<string, Passed> = {};
    if (p.progress && typeof p.progress === 'object') {
      for (const [id, r] of Object.entries(p.progress as Record<string, unknown>)) {
        if (!r || typeof r !== 'object') continue;
        const pr = r as Partial<Record<keyof Passed, unknown>>;
        if (pr.version !== current.get(id) || typeof pr.passedAt !== 'string') continue;
        progress[id] = {
          version: pr.version as number,
          passedAt: pr.passedAt,
          hintsUsed: whole(pr.hintsUsed) ? pr.hintsUsed : 0,
        };
      }
    }

    // Active only while there is an attempt to come back to.
    const active =
      typeof p.active === 'string' && attempts[p.active] !== undefined
        ? p.active
        : null;
    return { active, attempts, progress };
  } catch {
    // Corrupt JSON or blocked storage: no challenge state, never a failed boot.
    return EMPTY_STORE;
  }
}

export function saveChallengeStore(
  store: ChallengeStore,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(CHALLENGES_KEY, JSON.stringify(store));
  } catch {
    // Quota or blocked storage. Same rule as the session: silent.
  }
}

/* ---------------- updates ---------------- */

export function withActive(store: ChallengeStore, id: string | null): ChallengeStore {
  return store.active === id ? store : { ...store, active: id };
}

/** The attempt saved as `topology`, keeping the hints already asked for. */
export function withAttempt(
  store: ChallengeStore,
  challenge: Challenge,
  topology: Topology,
): ChallengeStore {
  const prev = attemptFor(store, challenge);
  return {
    ...store,
    attempts: {
      ...store.attempts,
      [challenge.id]: {
        version: challenge.version,
        topology,
        hintsShown: prev?.hintsShown ?? 0,
      },
    },
  };
}

export function withHints(
  store: ChallengeStore,
  challenge: Challenge,
  hintsShown: number,
  topology: Topology,
): ChallengeStore {
  const prev = attemptFor(store, challenge);
  return {
    ...store,
    attempts: {
      ...store.attempts,
      [challenge.id]: {
        version: challenge.version,
        topology: prev?.topology ?? topology,
        hintsShown,
      },
    },
  };
}

/** Record a pass. The first pass of a version stands; a later one adds nothing. */
export function withPass(
  store: ChallengeStore,
  challenge: Challenge,
  hintsUsed: number,
  now: Date,
): ChallengeStore {
  if (passedFor(store, challenge)) return store;
  return {
    ...store,
    progress: {
      ...store.progress,
      [challenge.id]: {
        version: challenge.version,
        passedAt: now.toISOString(),
        hintsUsed,
      },
    },
  };
}

/* ---------------- reads ---------------- */

export function attemptFor(
  store: ChallengeStore,
  challenge: Challenge,
): Attempt | null {
  const a = store.attempts[challenge.id];
  return a && a.version === challenge.version ? a : null;
}

export function passedFor(store: ChallengeStore, challenge: Challenge): Passed | null {
  const p = store.progress[challenge.id];
  return p && p.version === challenge.version ? p : null;
}

export type ChallengeBadge = 'passed' | 'in-progress' | null;

/** What the picker says about a brief. Passed wins over an attempt in hand. */
export function badgeFor(store: ChallengeStore, challenge: Challenge): ChallengeBadge {
  if (passedFor(store, challenge)) return 'passed';
  return attemptFor(store, challenge) ? 'in-progress' : null;
}

/** The briefs in the order the picker shows them: by tier, then as listed. */
export function inPickerOrder(challenges: readonly Challenge[]): Challenge[] {
  return challenges
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.tier ?? 1) - (b.c.tier ?? 1) || a.i - b.i)
    .map(({ c }) => c);
}

/** The brief after this one in the picker, or null for the last. */
export function nextChallenge(
  challenges: readonly Challenge[],
  id: string,
): Challenge | null {
  const order = inPickerOrder(challenges);
  const at = order.findIndex((c) => c.id === id);
  return at >= 0 ? (order[at + 1] ?? null) : null;
}

/** The brief a `?challenge=<id>` link names, if the URL carries one. */
export function challengeParam(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('challenge');
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}
