/**
 * Zoom-to-fit, as plain arithmetic.
 *
 * Kept out of Canvas.tsx so the framing can be tested without mounting the
 * canvas. The canvas measures two rects and hands them in: the surface the
 * transform is anchored to, and the part of it no floating panel covers (the
 * .stage-safe sentinel). On a phone during a brief that second rect stops
 * at the top of the challenge sheet, so the sheet's height is already in it.
 */

/** A rect in client px, as getBoundingClientRect reports it. */
export interface FitRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The content's bounds in world px. */
export interface FitBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FitView {
  x: number;
  y: number;
  k: number;
}

/** Below this the body numbers and sparkline drop. */
export const DETAIL_ZOOM = 0.7;
/** Below this only the name, health rule and meter survive. */
export const MINIMAL_ZOOM = 0.5;

/* The auto-fit margin, in CSS px of the visible rect.
 *
 * 64 is generous on a desktop and expensive on a phone: it spends 128 of a
 * 390px width on air, which is a third of the screen. A narrow viewport gets
 * a tighter frame; the diagram still has room to breathe, and more of it
 * lands on screen before the reader has to pan. */
const FIT_MARGIN_WIDE = 64;
const FIT_MARGIN_NARROW = 24;
/** The shell's phone breakpoint, the same 720 the stylesheets use. */
export const NARROW_FIT_WIDTH = 720;

export function fitMarginFor(viewWidth: number): number {
  return viewWidth <= NARROW_FIT_WIDTH ? FIT_MARGIN_NARROW : FIT_MARGIN_WIDE;
}

/**
 * The auto-fit floor on a wide screen.
 *
 * Deliberately DETAIL_ZOOM, not a rounder 0.6. Auto-fit runs on every preset
 * load, so it decides what a student sees first, and at 0.6 the fitted view
 * landed in the 0.6-0.7 band where the body numbers are suppressed,
 * presenting the flagship preset as a row of empty boxes. Never auto-fit to
 * a zoom at which the diagram stops showing its data, when there is room
 * not to.
 */
export const FIT_MIN = DETAIL_ZOOM;

/**
 * The auto-fit floor on a phone.
 *
 * On a 390px screen there is no such room. Even the smallest brief, three
 * cards in a row, is 804 world px wide, so the 0.7 floor left it half off
 * the screen: the student saw one card and a half and could not tell what
 * they were meant to fix. Seeing every part with its name beats seeing one
 * part's numbers. 0.38 is the floor at which that three-card row fits a
 * 360px screen inside the 24px margin (804 x 0.38 = 306 of 312); at 0.45 the
 * outer two cards were cut off there. Anything wider than that is panned.
 *
 * On a touch screen the cards still show their numbers this far out: the
 * canvas draws a counter-scaled glance line below DETAIL_ZOOM (glance.ts),
 * sized to stay readable down to exactly this floor.
 */
export const FIT_MIN_NARROW = 0.38;

/** 1.5 stops a 3-node preset becoming a billboard. */
export const FIT_MAX = 1.5;

/**
 * The view that frames `bounds` inside `view`, expressed against `surface`.
 *
 * Scale and centring both use the VISIBLE rect, so a fit with panels open,
 * or with the challenge sheet up on a phone, frames the diagram inside the
 * uncovered area and never parks a node under an opaque panel. The offset is
 * relative to the surface, which is what the transform is anchored to.
 *
 * The floor is chosen by the SURFACE width, not the visible one: on a
 * desktop with both rails open the visible rect can be narrower than 720,
 * and that is still a desktop, where the 0.7 rule holds.
 *
 * Returns null for a rect with no area, which is a canvas not laid out yet.
 */
export function fitViewport(
  bounds: FitBounds,
  surface: FitRect,
  view: FitRect,
): FitView | null {
  if (view.width <= 0 || view.height <= 0) return null;
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const margin = fitMarginFor(view.width);
  const floor = surface.width <= NARROW_FIT_WIDTH ? FIT_MIN_NARROW : FIT_MIN;
  const raw = Math.min((view.width - margin * 2) / bw, (view.height - margin * 2) / bh);
  // The same rounding zoomAt applies, so a fit and a keyboard zoom can never
  // report two spellings of the same percentage.
  const k = Math.min(FIT_MAX, Math.max(floor, Math.round(raw * 1000) / 1000));
  return {
    k,
    x: view.left - surface.left + (view.width - bw * k) / 2 - bounds.minX * k,
    y: view.top - surface.top + (view.height - bh * k) / 2 - bounds.minY * k,
  };
}
