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
 * The zoom a wide screen fits at when it can: the last one at which a card
 * draws its full body, numbers and sparkline included. A diagram that fits
 * at this zoom with the usual margin is framed there and no further out.
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
 * The cards still show their numbers this far out: the canvas draws a
 * counter-scaled glance line below DETAIL_ZOOM (glance.ts), sized to stay
 * readable down to exactly this floor.
 */
export const FIT_MIN_NARROW = 0.38;

/**
 * The auto-fit floor on a wide screen, when 0.7 would leave boxes off
 * screen or under a panel.
 *
 * This was 0.7 for examples, and a wide example ran past the edge: measured
 * at 1024 with the components rail open, 13 of 26 opened with boxes cut
 * off, and Stripe needed 42%. A diagram that opens cut off reads as a
 * smaller system than it is. So a diagram too wide for 0.7 takes a tighter
 * margin and may go down to MINIMAL_ZOOM. Not lower: 0.5 is the last zoom
 * at which a card still shows its name, its health colour and its meter,
 * and between 0.5 and 0.7 the glance line keeps its main number. Below 0.5
 * the shell folds the components rail instead (see onFitClipped).
 */
export const FIT_MIN_TIGHT = MINIMAL_ZOOM;

/**
 * The floor for a fit the reader asked for: the Fit button, the zoom
 * readout and Shift+1. They asked to see the whole diagram, so it is shown
 * whole even past the point where a card can say much. On a phone the
 * auto floor already sits at 0.38, and Fit pressed on a diagram that was
 * still wider than the screen there used to return the same view and look
 * broken.
 */
export const FIT_MIN_EXPLICIT = 0.25;

/** 1.5 stops a 3-node preset becoming a billboard. */
export const FIT_MAX = 1.5;

/** The zoom that frames a `bw` by `bh` diagram in `view` with `margin`. */
function rawFit(bw: number, bh: number, view: FitRect, margin: number): number {
  const raw = Math.min((view.width - margin * 2) / bw, (view.height - margin * 2) / bh);
  // The same rounding zoomAt applies, so a fit and a keyboard zoom can never
  // report two spellings of the same percentage.
  return Math.round(raw * 1000) / 1000;
}

export interface FitHow {
  /** The reader asked for this fit; see FIT_MIN_EXPLICIT. */
  explicit?: boolean;
  /**
   * Use the phone's floor and margin. Defaults to a surface no wider than
   * NARROW_FIT_WIDTH; a phone held sideways is wider than that and still a
   * phone, so the shell says so.
   */
  narrow?: boolean;
}

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
 * and that is still a desktop, where the phone's narrow floor never applies.
 *
 * A diagram still wider than the view at the floor starts at the left
 * margin, instead of being centred, and one still taller starts at the top. Centred, a wide example on a phone
 * showed the middle of a flow with neither end on screen. Every diagram
 * reads left to right from its traffic source, so the left end is the one
 * to keep, and the edge cues (EdgeCues.tsx) say the rest is a pan to the
 * right.
 *
 * Returns null for a rect with no area, which is a canvas not laid out yet.
 */
export function fitViewport(
  bounds: FitBounds,
  surface: FitRect,
  view: FitRect,
  how: FitHow = {},
): FitView | null {
  if (view.width <= 0 || view.height <= 0) return null;
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const narrow = how.narrow ?? surface.width <= NARROW_FIT_WIDTH;
  let margin = narrow ? FIT_MARGIN_NARROW : fitMarginFor(view.width);
  let floor = FIT_MIN_NARROW;
  let raw = rawFit(bw, bh, view, margin);
  if (!narrow) {
    floor = FIT_MIN;
    if (raw < FIT_MIN) {
      // Too wide for the numbers at the usual margin. A tighter frame may
      // still keep them; if not, see FIT_MIN_TIGHT.
      margin = FIT_MARGIN_NARROW;
      floor = FIT_MIN_TIGHT;
      raw = rawFit(bw, bh, view, margin);
    }
  }
  if (how.explicit) floor = Math.min(floor, FIT_MIN_EXPLICIT);
  const k = Math.min(FIT_MAX, Math.max(floor, raw));
  // Past the view itself, not merely into the margin: a diagram that only
  // eats into the margin is all on screen, and centred is still right.
  const spills = bw * k > view.width + 0.5;
  // Too tall as well, the top is kept for the same reason: centred, the
  // first row went under the controls along the canvas's top.
  const spillsY = bh * k > view.height + 0.5;
  return {
    k,
    x:
      view.left -
      surface.left +
      (spills ? margin : (view.width - bw * k) / 2) -
      bounds.minX * k,
    y:
      view.top -
      surface.top +
      (spillsY ? margin : (view.height - bh * k) / 2) -
      bounds.minY * k,
  };
}

/** Does `bounds` at zoom `k` run past `view` either way? */
export function fitClips(bounds: FitBounds, view: FitRect, k: number): boolean {
  return (
    (bounds.maxX - bounds.minX) * k > view.width + 0.5 ||
    (bounds.maxY - bounds.minY) * k > view.height + 0.5
  );
}

/** Air kept between the fitted diagram and a control floating over it. */
const CHROME_GAP = 8;
/** A control along a side edge floats this far in, plus that air. */
const EDGE_INSET = 12 + CHROME_GAP;

/**
 * `view` with the controls that float over the canvas taken out of it: the
 * rail toggles, the gesture hint and "Find the problem" along the top, the
 * ledger and the zoom row along the foot. They are opaque, and a fit that
 * ran under them put a card's name under a button.
 *
 * Each control is cut away along whichever side costs the diagram least: a
 * control in the top half can push the top down, one in the bottom half can
 * pull the foot up, and one near a side edge can push that side in instead.
 * `size` is the diagram's size in world px, which is what decides; a wide
 * diagram gives up height more cheaply than width. Taking the controls out
 * never leaves less than half the view either way; past that the view is
 * returned as it was.
 */
export function clearOfChrome(
  view: FitRect,
  chrome: readonly ScreenBox[],
  size: { w: number; h: number } = { w: 1, h: 0 },
): FitRect {
  let l = view.left;
  let t = view.top;
  let r = view.left + view.width;
  let b = view.top + view.height;
  const midY = view.top + view.height / 2;
  const edge = view.width / 4;
  const scale = (w: number, h: number) =>
    Math.min(w / Math.max(1, size.w), size.h > 0 ? h / size.h : Infinity);
  for (const c of chrome) {
    if (c.right <= c.left || c.bottom <= c.top) continue;
    if (c.right <= l || c.left >= r || c.bottom <= t || c.top >= b) continue;
    const options: [number, number, number, number][] = [];
    if ((c.top + c.bottom) / 2 < midY)
      options.push([l, Math.max(t, c.bottom + CHROME_GAP), r, b]);
    else options.push([l, t, r, Math.min(b, c.top - CHROME_GAP)]);
    // Measured from the edge rather than from where the control is now: it
    // may still be sliding along with a rail that is opening or closing.
    const across = c.right - c.left + EDGE_INSET;
    if (c.left - view.left < edge)
      options.push([Math.max(l, view.left + across), t, r, b]);
    if (view.left + view.width - c.right < edge)
      options.push([l, t, Math.min(r, view.left + view.width - across), b]);
    let best = options[0]!;
    for (const o of options) {
      if (
        scale(o[2] - o[0], o[3] - o[1]) > scale(best[2] - best[0], best[3] - best[1])
      ) {
        best = o;
      }
    }
    [l, t, r, b] = best;
  }
  if (r - l < view.width / 2 || b - t < view.height / 2) return view;
  return { left: l, top: t, width: r - l, height: b - t };
}

/** How much a card shows at zoom `k`: 2 everything, 1 a glance line, 0 its name. */
export function detailBand(k: number): 0 | 1 | 2 {
  return k >= DETAIL_ZOOM ? 2 : k >= MINIMAL_ZOOM ? 1 : 0;
}

/** A box in client px. */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Half a pixel of slack, so rounding never reads as a box past the edge. */
const SLACK = 0.5;

/** Which sides of `view` the content `box` runs past, if any. */
export function overflowOf(box: ScreenBox, view: ScreenBox) {
  const left = box.left < view.left - SLACK;
  const right = box.right > view.right + SLACK;
  const up = box.top < view.top - SLACK;
  const down = box.bottom > view.bottom + SLACK;
  return { left, right, any: left || right || up || down };
}

/** How much of the visible width one press of an edge cue pans. */
const CUE_STEP = 0.8;

/**
 * The pan, in client px, for a press of the edge cue on `side`: most of a
 * screen toward that side, and no further than it takes to bring the
 * content's far edge in with the fit margin. Positive moves the content
 * right, which shows more of what was off the left.
 */
export function cuePan(
  side: 'left' | 'right',
  box: ScreenBox,
  view: ScreenBox,
): number {
  const width = view.right - view.left;
  const margin = fitMarginFor(width);
  const step = width * CUE_STEP;
  if (side === 'right') {
    const need = box.right - (view.right - margin);
    return need > 0 ? -Math.min(step, need) : 0;
  }
  const need = view.left + margin - box.left;
  return need > 0 ? Math.min(step, need) : 0;
}
