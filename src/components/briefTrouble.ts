import type { Challenge } from '../sim/challenge';

/* ==========================================================================
   The trouble a brief promises, in words.

   A brief with faults is judged on runs that include them, so its first
   verdict describes a failure the live run on screen may not have reached
   yet. Saying when and what lets "As it starts" read as a forecast of the
   brief's own runs rather than a loss nobody can see happening.
   ========================================================================== */

export interface BriefTrouble {
  /** Run time the first fault lands, in ms. */
  atMs: number;
  /** "S3 goes down", finishing "When ... at 20s". */
  what: string;
  /** "Outage", finishing "... in 14s". */
  noun: string;
}

/** The brief's first fault, or null for a brief with none. */
export function briefTrouble(
  challenge: Challenge,
  nameOf: (id: string) => string,
): BriefTrouble | null {
  let first: NonNullable<Challenge['faults']>[number] | null = null;
  for (const f of challenge.faults ?? []) {
    if (f.action !== 'inject' && f.action !== 'cut') continue;
    if (first === null || f.atMs < first.atMs) first = f;
  }
  if (first === null) return null;
  if (first.action === 'cut') {
    return { atMs: first.atMs, what: 'a connection is cut', noun: 'Cut' };
  }
  // A label with a comma in it ("S3, one region") reads as an aside, which
  // a sentence has to close before its verb.
  const raw = nameOf(first.nodeId);
  const name = raw.includes(',') ? `${raw},` : raw;
  switch (first.kind) {
    case 'crash':
      return { atMs: first.atMs, what: `${name} goes down`, noun: 'Outage' };
    case 'crash-instance':
      return {
        atMs: first.atMs,
        what: `one ${name} machine crashes`,
        noun: 'Crash',
      };
    case 'slow':
      return { atMs: first.atMs, what: `${name} slows down`, noun: 'Slowdown' };
    case 'errors':
      return {
        atMs: first.atMs,
        what: `${name} starts failing requests`,
        noun: 'Errors',
      };
    case 'partition':
      return { atMs: first.atMs, what: `${name} is cut off`, noun: 'Outage' };
    default:
      return null;
  }
}

/**
 * Whole seconds until the fault in the live run, for "Outage in 14s", or
 * null once it has landed. Rounded up, so it never says 0s before it hits.
 */
export function troubleCountdown(
  trouble: BriefTrouble | null,
  liveMs: number | null,
): { noun: string; seconds: number } | null {
  if (trouble === null || liveMs === null || liveMs >= trouble.atMs) return null;
  return { noun: trouble.noun, seconds: Math.ceil((trouble.atMs - liveMs) / 1000) };
}
