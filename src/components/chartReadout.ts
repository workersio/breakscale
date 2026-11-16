/**
 * Pure parts of the chart readout: which sample a pointer or a key press
 * lands on, and how its time is written.
 */

/**
 * The index of the item whose key is closest to `target`, or -1 for an
 * empty list. The keys must not decrease, which holds for every series the
 * strip draws: samples are appended in time order.
 */
export function nearestBy<T>(
  items: readonly T[],
  key: (item: T) => number,
  target: number,
): number {
  const n = items.length;
  if (n === 0 || !Number.isFinite(target)) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first key at or past the target; the one before may be nearer.
  if (lo > 0 && target - key(items[lo - 1]!) <= key(items[lo]!) - target) return lo - 1;
  return lo;
}

/**
 * A sample's run time, as the readout heads it: "at 12.25s". Samples land
 * every 250ms, so two decimals say exactly which one it is, and trailing
 * zeros are dropped so a whole second reads "at 13s".
 */
export function formatAt(tMs: number): string {
  if (!Number.isFinite(tMs)) return '';
  const s = Math.round(tMs / 10) / 100;
  return `at ${s.toFixed(2).replace(/\.?0+$/, '')}s`;
}

/** Where the readout is aimed. */
export type HoverAim =
  /** A mouse or a finger over the plot, in px from its left edge. The
      sample under it changes as the run scrolls past. */
  | { kind: 'pointer'; px: number }
  /** One sample, by its time. A key press or a lifted finger picks it, and
      it stays on that sample until it scrolls out of the window. */
  | { kind: 'sample'; t: number; by: 'key' | 'touch' };

/** How far left of the oldest sample a pointer still reads it, in px. */
const EMPTY_SLACK_PX = 8;

/** The sample an aim lands on, or -1 for none. */
export function aimedIndex<T extends { t: number }>(
  samples: readonly T[],
  aim: HoverAim | null,
  xPx: (t: number) => number,
): number {
  if (aim === null || samples.length === 0) return -1;
  if (aim.kind === 'pointer') {
    // Left of the oldest sample is a run that had not started: nothing there
    // to read, so the legend stays live rather than snapping to the oldest.
    if (aim.px < xPx(samples[0]!.t) - EMPTY_SLACK_PX) return -1;
    return nearestBy(samples, (s) => xPx(s.t), aim.px);
  }
  const first = samples[0]!.t;
  const last = samples[samples.length - 1]!.t;
  // Scrolled out of the window, or the run was reset under it.
  if (aim.t < first || aim.t > last) return -1;
  return nearestBy(samples, (s) => s.t, aim.t);
}

/**
 * The sample a key moves to from `from` (-1 for none yet), or null when the
 * key is not one the readout uses. The first press starts at the newest.
 */
export function steppedIndex(key: string, from: number, count: number): number | null {
  if (count === 0) return null;
  const last = count - 1;
  const at = from < 0 ? last : from;
  switch (key) {
    case 'ArrowLeft':
      return from < 0 ? last : Math.max(0, at - 1);
    case 'ArrowRight':
      return Math.min(last, at + 1);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
