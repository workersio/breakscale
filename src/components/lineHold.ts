import { useEffect, useState } from 'react';
import { IDLE_SETTLE_MS, SETTLE_SNAPSHOTS } from './settledHealth';

/**
 * Display hysteresis for the waiting-line bar on a node card.
 *
 * A server near its limit has a line that blinks between 0 and 2 from one
 * 10Hz snapshot to the next. Drawing that as it comes is a bar that flickers
 * in and out, so the bar follows the same hold as the health colours
 * (settledHealth.ts), with one difference: a line forming is not trouble yet,
 * so it also has to hold before the bar appears. Turning people away is
 * trouble, and shows at once.
 *
 *   none      nobody waiting, or not for long enough to draw
 *   waiting   a line has held for SETTLE_SNAPSHOTS snapshots
 *   refusing  the line is full and the node is turning calls away
 *
 * Any change other than into 'refusing' waits for SETTLE_SNAPSHOTS snapshots
 * in a row, and a step down lands on the worst state seen during that run.
 */
export type LineState = 'none' | 'waiting' | 'refusing';

const RANK: Readonly<Record<LineState, number>> = { none: 0, waiting: 1, refusing: 2 };

/** What one snapshot says, before any hold. */
export function rawLine(
  queued: number,
  queueLimit: number,
  shedRate: number,
): LineState {
  if (!(queueLimit > 0) || !(queued > 0)) return 'none';
  return shedRate > 0 ? 'refusing' : 'waiting';
}

export interface LineTrack {
  readonly shown: LineState;
  readonly raw: LineState;
  /** Snapshots in a row that came in different from `shown`, one way. */
  readonly run: number;
  /** Worst raw state in that run: where a step down lands. */
  readonly peak: LineState;
}

function adopt(raw: LineState): LineTrack {
  return { shown: raw, raw, run: 0, peak: raw };
}

/** One node's next track; `advanced` is true only for a newer snapshot. */
export function stepLine(
  prev: LineTrack | undefined,
  raw: LineState,
  advanced: boolean,
): LineTrack {
  if (!prev) return adopt(raw);
  if (!advanced) return prev.raw === raw ? prev : adopt(raw);
  if (raw === 'refusing' || raw === prev.shown) {
    return prev.shown === raw && prev.run === 0 && prev.raw === raw ? prev : adopt(raw);
  }
  const up = RANK[raw] > RANK[prev.shown];
  // A run in the other direction, or a run broken by a matching snapshot
  // (handled above), starts over.
  const same = prev.run > 0 && RANK[prev.raw] > RANK[prev.shown] === up;
  const run = same ? prev.run + 1 : 1;
  const peak = same && RANK[prev.peak] > RANK[raw] ? prev.peak : raw;
  if (run >= SETTLE_SNAPSHOTS) return { shown: peak, raw, run: 0, peak };
  return { shown: prev.shown, raw, run, peak };
}

export interface LineMap {
  readonly tick: number | null;
  readonly tracks: ReadonlyMap<string, LineTrack>;
  readonly shown: ReadonlyMap<string, LineState>;
}

export const EMPTY_LINES: LineMap = { tick: null, tracks: new Map(), shown: new Map() };

/**
 * Steps every node's track. Returns `state` itself when nothing changed, so
 * the hook can adjust during render without looping. Time going backwards (a
 * reset, a replay seek) drops all history.
 */
export function stepLines(
  state: LineMap,
  raw: ReadonlyMap<string, LineState>,
  tick: number | null,
): LineMap {
  const known = state.tick !== null && tick !== null;
  const rewound = known && tick < (state.tick ?? 0);
  const advanced = known && tick > (state.tick ?? 0);
  const base = rewound ? EMPTY_LINES.tracks : state.tracks;

  let changed = tick !== state.tick || raw.size !== base.size;
  const tracks = new Map<string, LineTrack>();
  for (const [id, r] of raw) {
    const prev = base.get(id);
    const next = stepLine(prev, r, advanced);
    if (next !== prev) changed = true;
    tracks.set(id, next);
  }
  if (!changed) return state;
  const shown = new Map<string, LineState>();
  for (const [id, t] of tracks) shown.set(id, t.shown);
  return { tick, tracks, shown };
}

/** Every pending change applied now; `state` itself if none was pending. */
export function flushLines(state: LineMap): LineMap {
  if (!hasPending(state)) return state;
  const tracks = new Map<string, LineTrack>();
  const shown = new Map<string, LineState>();
  for (const [id, t] of state.tracks) {
    const next = t.run > 0 ? adopt(t.raw) : t;
    tracks.set(id, next);
    shown.set(id, next.shown);
  }
  return { tick: state.tick, tracks, shown };
}

function hasPending(state: LineMap): boolean {
  for (const t of state.tracks.values()) if (t.run > 0) return true;
  return false;
}

/**
 * Held line state per node id, stepped once per snapshot. Paused inside a
 * hold, the pending change lands after IDLE_SETTLE_MS, so a still frame never
 * keeps a bar the numbers beside it no longer support.
 */
export function useLineStates(
  raw: ReadonlyMap<string, LineState>,
  tick: number | null,
): ReadonlyMap<string, LineState> {
  const [state, setState] = useState<LineMap>(EMPTY_LINES);
  const next = stepLines(state, raw, tick);
  if (next !== state) setState(next);
  const pending = hasPending(next);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setState(flushLines), IDLE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [pending, next.tick]);
  return next.shown;
}
