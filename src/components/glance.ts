/**
 * The glance line: a node's name and primary value, counter-scaled so they
 * stay readable when a touch screen is zoomed out past DETAIL_ZOOM.
 *
 * Auto-fit on a phone lands between 0.38 and 0.7, where the full card drops
 * its numbers and the name renders at 5 or 6 screen px. A student looking at
 * a phone then sees boxes, not a system under load. Below DETAIL_ZOOM on a
 * coarse pointer the card instead draws two lines sized in SCREEN px: the
 * name at 11 and the value at 12, so "99% busy" reads at any fitted zoom.
 *
 * Pure arithmetic, kept out of Canvas.tsx so it can be tested without
 * mounting the canvas.
 */

import { DETAIL_ZOOM, FIT_MIN_NARROW } from './fit';

/** Screen px of the three pieces of the glance line. */
export const GLANCE_NAME_PX = 11;
export const GLANCE_VALUE_PX = 12;
export const GLANCE_CAP_PX = 10;

/** The card's world height above its meter, which the two lines share. */
const TOP = 8;
const METER_Y = 80;

/**
 * World px per screen px for the glance line, or 0 for no glance line.
 *
 * Clamped at the phone fit floor: further out than that the two lines no
 * longer fit above the meter, so they shrink with the zoom like everything
 * else. Quantised to 0.05 so a pinch re-renders the cards at a few dozen
 * steps rather than on every frame.
 */
export function glanceScale(k: number, coarse: boolean): number {
  if (!coarse || !(k > 0) || k >= DETAIL_ZOOM) return 0;
  const s = 1 / Math.max(k, FIT_MIN_NARROW);
  return Math.round(s * 20) / 20;
}

export interface GlanceLayout {
  /** Font sizes in world px. */
  nameSize: number;
  valueSize: number;
  capSize: number;
  /** The name's central baseline, matching .cv-node-name. */
  nameY: number;
  /** The value's alphabetic baseline. */
  valueY: number;
  /** The gap between value and caption, in world px. */
  capGap: number;
}

export function glanceLayout(s: number): GlanceLayout {
  const nameSize = GLANCE_NAME_PX * s;
  const valueSize = GLANCE_VALUE_PX * s;
  return {
    nameSize,
    valueSize,
    capSize: GLANCE_CAP_PX * s,
    nameY: TOP + nameSize * 0.6,
    // Under the name's 1.2 line box, then one ascent of the mono figures.
    valueY: Math.min(
      TOP + nameSize * 1.2 + valueSize * 0.9,
      METER_Y - valueSize * 0.25,
    ),
    capGap: 4 * s,
  };
}
