import type { HistoryPoint, SystemStats } from '../sim/types';
import { formatMs, formatPct, formatRate } from './format';

/**
 * A run held still for comparison: the engine's own history samples and the
 * top bar's three figures at the moment of pinning. Nothing here is derived;
 * a pin is a copy of what was on screen.
 */
export interface PinnedRun {
  /** Sim time of the pin, in ms. */
  atMs: number;
  /** The load the slider was set to. */
  rps: number;
  /** The bar's p99, or null where it showed none (nothing completing). */
  p99: number | null;
  goodput: number;
  errorRate: number;
  /** The charts' last 60s, copied out of the engine's live buffer. */
  history: readonly HistoryPoint[];
}

/** The bar's rule for p99: with nothing completing there is no percentile. */
export function barP99(system: SystemStats): number | null {
  return system.p99 === 0 && system.goodputRps === 0 ? null : system.p99;
}

/** The span the charts draw, and so the span a pin holds. Metrics.tsx keeps
    the same 60s as its WINDOW_MS. */
export const PIN_WINDOW_MS = 60_000;

/**
 * The samples a pin made outside the charts holds: the trailing window the
 * charts would be drawing, cut the same way.
 */
export function trailingWindow(history: readonly HistoryPoint[]): HistoryPoint[] {
  const n = history.length;
  if (n === 0) return [];
  const cutoff = (history[n - 1]?.t ?? 0) - PIN_WINDOW_MS;
  let i = 0;
  while (i < n && (history[i]?.t ?? cutoff) < cutoff) i += 1;
  return history.slice(i);
}

export function pinRun(
  system: SystemStats,
  history: readonly HistoryPoint[],
  rps: number,
): PinnedRun {
  return {
    atMs: system.timeMs,
    rps,
    p99: barP99(system),
    goodput: system.goodputRps,
    errorRate: system.errorRate,
    // The engine reuses its array; the samples are copied so the pin cannot
    // move when the live run does.
    history: history.map((p) => ({ ...p })),
  };
}

/** "Pinned at 30s, 300/s". */
export function pinLabel(pin: PinnedRun): string {
  return `Pinned at ${Math.floor(pin.atMs / 1000)}s, ${formatRate(pin.rps)}`;
}

export type PinTone = 'better' | 'worse' | 'same';

export interface PinRow {
  name: 'p99' | 'Goodput' | 'Errors';
  /** Glossary id for the name. */
  term: string;
  then: string;
  now: string;
  tone: PinTone;
}

/** A p99 as the bar prints it, including its outage wording. */
function p99Text(p99: number | null, errorRate: number): string {
  return p99 === null && errorRate > 0 ? 'no replies' : formatMs(p99);
}

/**
 * Whether a reading has really moved, rather than drifted. Two runs of the
 * same design never read the same: at 50/s the bar's goodput, counted over
 * one second, swings 43 to 49 on its own, and p99, taken from the slowest
 * one in a hundred over five seconds, moves as much. Calling that "worse" in
 * red would teach a student that noise is a regression.
 */
type Moved = (then: number, now: number) => boolean;

const relative = (then: number, now: number) => {
  const scale = Math.max(Math.abs(then), Math.abs(now));
  return scale === 0 ? 0 : Math.abs(now - then) / scale;
};

/** A fifth either way. */
const p99Moved: Moved = (a, b) => relative(a, b) >= 0.2;

/**
 * A count over a one-second window spreads by about its square root, so
 * only a gap of three of those is a change; and never under a tenth.
 */
const goodputMoved: Moved = (a, b) =>
  Math.abs(b - a) > 3 * Math.sqrt(Math.max(a, b)) && relative(a, b) >= 0.1;

/** A fifth either way, or failing where nothing failed before. */
const errorsMoved: Moved = (a, b) =>
  (a === 0 || b === 0 || relative(a, b) >= 0.2) && a !== b;

/** Lower is better, higher is better, or no verdict. */
function toneOf(
  then: number | null,
  now: number | null,
  same: boolean,
  lowerIsBetter: boolean,
  moved: Moved,
): PinTone {
  if (same || then === null || now === null || then === now) return 'same';
  // An outage on one side only is always a change.
  const outage = then === Infinity || now === Infinity;
  if (!outage && !moved(then, now)) return 'same';
  return now < then === lowerIsBetter ? 'better' : 'worse';
}

/**
 * The pinned figures beside the live ones. Goodput is only judged when the
 * load is the one that was pinned: at a different load more getting through
 * says nothing about the design.
 */
export function compareRows(
  pin: PinnedRun,
  system: SystemStats,
  rps: number,
): PinRow[] {
  const p99Now = barP99(system);
  const p99Then = p99Text(pin.p99, pin.errorRate);
  const p99Live = p99Text(p99Now, system.errorRate);
  // An outage on either side is the worst a p99 can be.
  const p99Rank = (v: number | null, err: number) =>
    v === null ? (err > 0 ? Infinity : null) : v;

  const gThen = formatRate(pin.goodput);
  const gNow = formatRate(system.goodputRps);
  const eThen = formatPct(pin.errorRate);
  const eNow = formatPct(system.errorRate);

  return [
    {
      name: 'p99',
      term: 'p99',
      then: p99Then,
      now: p99Live,
      tone: toneOf(
        p99Rank(pin.p99, pin.errorRate),
        p99Rank(p99Now, system.errorRate),
        p99Then === p99Live,
        true,
        p99Moved,
      ),
    },
    {
      name: 'Goodput',
      term: 'goodput',
      then: gThen,
      now: gNow,
      tone: toneOf(
        pin.goodput,
        system.goodputRps,
        gThen === gNow || rps !== pin.rps,
        false,
        goodputMoved,
      ),
    },
    {
      name: 'Errors',
      term: 'error-rate',
      then: eThen,
      now: eNow,
      tone: toneOf(pin.errorRate, system.errorRate, eThen === eNow, true, errorsMoved),
    },
  ];
}

/**
 * The pinned samples that fall inside the window a chart is drawing, by run
 * time. Outside it they would be clamped onto the chart's edges and drawn as
 * a false vertical line.
 */
export function pinInWindow(
  pin: PinnedRun | null | undefined,
  tStart: number,
  tEnd: number,
): readonly HistoryPoint[] {
  if (!pin) return [];
  return pin.history.filter((p) => p.t >= tStart && p.t <= tEnd);
}
