import { useEffect, useState } from 'react';
import type { Health } from './format';

/**
 * Display-only hysteresis for health colours.
 *
 * A value sitting on a threshold flips its class from one 10Hz snapshot to
 * the next, and the 200ms colour ease never gets to finish. On hold-the-line
 * the API server flipped between ok and warn 18 times in 6s while its
 * headline read a steady 7-9% busy, because its health follows the share of
 * slots held, not the number printed on it.
 *
 * So a worse state applies at once, and a better one only after it has held
 * for SETTLE_SNAPSHOTS snapshots in a row (500ms at 10Hz). Trouble is never
 * hidden or delayed; only the all-clear waits. For those few snapshots the
 * colour can read warn while the number beside it is under the threshold.
 * That is intended. Nothing here touches the engine or its snapshots.
 *
 * Why 5: 120s of hold-the-line's start design, measured on the API server,
 * averages 11.6 flips per 6s unsettled, 7.0 holding for 3 snapshots, 4.9 for
 * 5 and 3.6 for 8. Five is where it falls under one change a second while an
 * all-clear still lands within half a second.
 */
export const SETTLE_SNAPSHOTS = 5;

/**
 * Wall-clock ms with no new snapshot after which a pending all-clear lands
 * anyway. Snapshots arrive every 100ms of wall time while the sim runs, at
 * any speed, so a gap this long means it is paused or was stepped once.
 * Without it a node paused inside the calm run kept its worse colour next
 * to a healthy number for as long as it stayed paused.
 */
export const IDLE_SETTLE_MS = 1000;

const RANK: Readonly<Record<Health, number>> = { ok: 0, warn: 1, danger: 2 };

function worse(a: Health, b: Health): Health {
  return RANK[a] >= RANK[b] ? a : b;
}

export interface HealthTrack {
  /** What is painted. */
  readonly shown: Health;
  /** The latest unsettled health, to tell an edit from a new snapshot. */
  readonly raw: Health;
  /** Snapshots in a row that came in better than `shown`. */
  readonly calm: number;
  /** The worst health seen during that calm run: where a step down lands. */
  readonly peak: Health;
}

function adopt(raw: Health): HealthTrack {
  return { shown: raw, raw, calm: 0, peak: raw };
}

/**
 * One node's next track. `advanced` is true only when a newer snapshot has
 * arrived. Without one (a re-render, or a config edit while paused) the raw
 * health is taken as it is, because only time passing can settle anything.
 */
export function settleHealth(
  prev: HealthTrack | undefined,
  raw: Health,
  advanced: boolean,
): HealthTrack {
  if (!prev) return adopt(raw);
  if (!advanced) return prev.raw === raw ? prev : adopt(raw);
  if (RANK[raw] >= RANK[prev.shown]) {
    return prev.shown === raw && prev.raw === raw && prev.calm === 0
      ? prev
      : adopt(raw);
  }
  const calm = prev.calm + 1;
  const peak = calm === 1 ? raw : worse(prev.peak, raw);
  if (calm >= SETTLE_SNAPSHOTS) return { shown: peak, raw, calm: 0, peak };
  return { shown: prev.shown, raw, calm, peak };
}

/** The track with any pending all-clear applied now. */
export function flushHealth(t: HealthTrack): HealthTrack {
  return t.calm > 0 ? adopt(t.raw) : t;
}

export interface SettledMap {
  /** Sim time of the snapshot the tracks were last stepped on. */
  readonly tick: number | null;
  readonly tracks: ReadonlyMap<string, HealthTrack>;
  readonly shown: ReadonlyMap<string, Health>;
}

/** How a snapshot's sim time relates to the one the tracks last saw. */
function compare(
  last: number | null,
  tick: number | null,
): { rewound: boolean; advanced: boolean } {
  if (last === null || tick === null) return { rewound: false, advanced: false };
  return { rewound: tick < last, advanced: tick > last };
}

export const EMPTY_SETTLED: SettledMap = {
  tick: null,
  tracks: new Map(),
  shown: new Map(),
};

/**
 * Steps every node's track. Returns `state` itself when nothing changed, which
 * is what lets the hook below call setState during render without looping.
 * Time going backwards (a reset, a replay seek) drops all history.
 */
export function settleMap(
  state: SettledMap,
  raw: ReadonlyMap<string, Health>,
  tick: number | null,
): SettledMap {
  const { rewound, advanced } = compare(state.tick, tick);
  const base = rewound ? EMPTY_SETTLED.tracks : state.tracks;

  let changed = tick !== state.tick || raw.size !== base.size;
  const tracks = new Map<string, HealthTrack>();
  for (const [id, h] of raw) {
    const prev = base.get(id);
    const next = settleHealth(prev, h, advanced);
    if (next !== prev) changed = true;
    tracks.set(id, next);
  }
  if (!changed) return state;

  const shown = new Map<string, Health>();
  for (const [id, t] of tracks) shown.set(id, t.shown);
  return { tick, tracks, shown };
}

/** Every pending all-clear applied now; `state` itself if none was pending. */
export function flushMap(state: SettledMap): SettledMap {
  if (!hasPending(state)) return state;
  const tracks = new Map<string, HealthTrack>();
  const shown = new Map<string, Health>();
  for (const [id, t] of state.tracks) {
    const next = flushHealth(t);
    tracks.set(id, next);
    shown.set(id, next.shown);
  }
  return { tick: state.tick, tracks, shown };
}

function hasPending(state: SettledMap): boolean {
  for (const t of state.tracks.values()) if (t.calm > 0) return true;
  return false;
}

/**
 * Settled health per node id, stepped once per snapshot. `tick` is the
 * snapshot's sim time. Adjusted during render (React's "storing information
 * from previous renders" pattern), so the settled colour lands in the same
 * commit as the numbers rather than one effect later.
 */
export function useSettledHealthMap(
  raw: ReadonlyMap<string, Health>,
  tick: number | null,
): ReadonlyMap<string, Health> {
  const [state, setState] = useState<SettledMap>(EMPTY_SETTLED);
  const next = settleMap(state, raw, tick);
  if (next !== state) setState(next);
  const pending = hasPending(next);
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(() => setState(flushMap), IDLE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [pending, next.tick]);
  return next.shown;
}

interface SettledOne {
  readonly tick: number | null;
  readonly track: HealthTrack | undefined;
}

/** The single-value form, for the system p99 readouts. */
export function useSettledHealth(raw: Health, tick: number | null): Health {
  const [state, setState] = useState<SettledOne>({ tick: null, track: undefined });
  const { rewound, advanced } = compare(state.tick, tick);
  const track = settleHealth(rewound ? undefined : state.track, raw, advanced);
  if (track !== state.track || tick !== state.tick) setState({ tick, track });
  const pending = track.calm > 0;
  useEffect(() => {
    if (!pending) return;
    const id = setTimeout(
      () =>
        setState((s) => (s.track ? { tick: s.tick, track: flushHealth(s.track) } : s)),
      IDLE_SETTLE_MS,
    );
    return () => clearTimeout(id);
  }, [pending, tick]);
  return track.shown;
}
