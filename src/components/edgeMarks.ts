import type { Pt } from './edgeRoute';

/**
 * Where the small marks on a wire go: the retry loop and the loss ticks.
 *
 * Both sit on the wire's mid leg, the one the router puts the label on, which
 * is the only part of a wire guaranteed to lie in the clear corridor between
 * the two cards. The rate label takes the space above the label point and the
 * reduced-motion outcome bar the space just below it, so the retry loop goes
 * toward the caller and the loss ticks toward the target, on the side away
 * from the rate label.
 *
 * Pure geometry, no imports beyond the point type, so it tests in node.
 */

export interface MidLeg {
  /** Unit vector along the leg, in the direction requests travel. */
  ux: number;
  uy: number;
  /** Unit normal pointing away from the rate label: down, or to the right. */
  nx: number;
  ny: number;
  /** Room along the leg from the label point back to its start, and on. */
  back: number;
  ahead: number;
}

/** How far along the leg from the label point the marks want to sit. */
export const MARK_OFFSET = 30;
/** Clearance kept between a mark and the end of its leg, where fillets bend. */
const LEG_MARGIN = 14;

/**
 * The leg of `points` that holds `label`, or null when none does (a route
 * with fewer than two points).
 */
export function midLeg(points: readonly Pt[], label: Pt): MidLeg | null {
  let best: MidLeg | null = null;
  let bestOff = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const ux = dx / len;
    const uy = dy / len;
    const t = (label.x - a.x) * ux + (label.y - a.y) * uy;
    if (t < -0.5 || t > len + 0.5) continue;
    // Distance off the leg: the router's legs are axis-aligned, so the
    // label sits exactly on one of them.
    const off = Math.abs((label.x - a.x) * uy - (label.y - a.y) * ux);
    if (off >= bestOff) continue;
    bestOff = off;
    const horizontal = Math.abs(ux) >= Math.abs(uy);
    best = {
      ux,
      uy,
      nx: horizontal ? 0 : 1,
      ny: horizontal ? 1 : 0,
      back: Math.max(0, t),
      ahead: Math.max(0, len - t),
    };
  }
  return bestOff <= 1 ? best : null;
}

/** Distance from the label point to a mark, kept clear of the leg's ends. */
export function markOffset(room: number): number {
  return Math.max(0, Math.min(MARK_OFFSET, room - LEG_MARGIN));
}
