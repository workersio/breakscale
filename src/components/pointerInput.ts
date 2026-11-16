/**
 * Pointer-type-aware input decisions, kept pure so they can be unit tested.
 *
 * The canvas has ONE pointer router (Canvas.tsx, `.cv-surface`); this module
 * is that router's decision table, not a second event layer. Everything here
 * takes plain values in and returns plain values out. The only mutable thing
 * any function touches is the touch Map that Canvas owns and passes in, and
 * the mutations are limited to set/delete of the entry being reported.
 */

/* ------------------------------------------------------------------ *
 * Drag threshold
 * ------------------------------------------------------------------ */

/**
 * Screen-space distance a press may travel and still count as a click,
 * per pointer type.
 *
 * A mouse rests on a desk, so 4px separates intent from noise. A fingertip
 * or a pen tip is held in the air by a whole arm, and both jitter several
 * pixels during a deliberate tap; at 4px that tap promotes to a micro-drag,
 * the selection never happens, and the canvas feels broken in exactly the
 * lecture-hall setting it is built for. 10px is Excalidraw's number for the
 * same problem, arrived at in production.
 */
export const DRAG_THRESHOLD_MOUSE = 4;
export const DRAG_THRESHOLD_COARSE = 10;

export function dragThresholdFor(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen'
    ? DRAG_THRESHOLD_COARSE
    : DRAG_THRESHOLD_MOUSE;
}

/* ------------------------------------------------------------------ *
 * Press routing
 * ------------------------------------------------------------------ */

/**
 * What a pointerdown's button means.
 *
 *   'gesture'  primary press: routes by what was hit.
 *   'pan'      mouse middle button: forced pan.
 *   'none'     ignore outright. This is what keeps a pen's barrel button
 *              (button 2) and eraser tip (button 5) from being misread as a
 *              normal press, and what keeps right-click inert.
 */
export type PressAction = 'gesture' | 'pan' | 'none';

export function pressAction(button: number, pointerType: string): PressAction {
  if (button === 0) return 'gesture';
  if (button === 1 && pointerType === 'mouse') return 'pan';
  return 'none';
}

/* ------------------------------------------------------------------ *
 * Palm rejection
 * ------------------------------------------------------------------ */

/**
 * Contact size above which a touch is treated as a resting palm rather than
 * a fingertip, in CSS px on either axis.
 *
 * A fingertip reports roughly 20-35px on hardware that reports size at all;
 * a palm reports 60px and up. 48 sits between them with the margin on the
 * finger's side, because rejecting a legitimate touch is a worse failure
 * than letting an occasional palm through: a rejected finger looks like a
 * dead app, a stray palm is at worst an accidental pan the user watches
 * happen. Hardware that does not measure contact size reports width/height
 * as 0 or 1 and is never size-rejected.
 */
export const PALM_CONTACT_PX = 48;

/**
 * Whether a touch-down should be discarded as a palm.
 *
 * Two signals, either sufficient:
 *  - the pen is currently in contact: the hand holding it is on the glass,
 *    so every simultaneous touch is a palm or a knuckle (pen priority);
 *  - the contact patch is wider or taller than any fingertip.
 */
export function isPalmTouch(
  pointerType: string,
  width: number,
  height: number,
  penIsDown: boolean,
): boolean {
  if (pointerType !== 'touch') return false;
  if (penIsDown) return true;
  return Math.max(width || 0, height || 0) >= PALM_CONTACT_PX;
}

/* ------------------------------------------------------------------ *
 * Multi-pointer tracking and pinch
 * ------------------------------------------------------------------ */

export interface PointerPoint {
  x: number;
  y: number;
}

/** Live touch contacts, keyed by pointerId, in surface-relative coords. */
export type TouchMap = Map<number, PointerPoint>;

export interface PinchState {
  /** The two pointerIds the pinch is measured between. */
  a: number;
  b: number;
  /** Finger distance at pinch start. Scale targets are ratios against it. */
  d0: number;
  /** Viewport scale at pinch start. */
  k0: number;
  /** Midpoint at the previous frame; pan is its per-frame delta. */
  lastMid: PointerPoint;
}

export function midpoint(a: PointerPoint, b: PointerPoint): PointerPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a: PointerPoint, b: PointerPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Start a pinch from the first two tracked touches, or report null when
 * there are not two. The two fingers landing essentially on top of each
 * other would make every later ratio explode, so a degenerate start distance
 * is floored at 1px.
 */
export function beginPinch(touches: TouchMap, k0: number): PinchState | null {
  if (touches.size < 2) return null;
  const it = touches.entries();
  const [ia, pa] = it.next().value as [number, PointerPoint];
  const [ib, pb] = it.next().value as [number, PointerPoint];
  return {
    a: ia,
    b: ib,
    d0: Math.max(1, distance(pa, pb)),
    k0,
    lastMid: midpoint(pa, pb),
  };
}

export interface PinchFrame {
  /** Current midpoint, surface coords: the zoom pivot. */
  mid: PointerPoint;
  /** Midpoint travel since the last frame: the pan delta. */
  dx: number;
  dy: number;
  /**
   * ABSOLUTE target scale, computed from the initial distance and scale
   * rather than incrementally, so a long pinch cannot accumulate drift and
   * releasing at the starting spread always lands back on k0 exactly.
   */
  k: number;
}

/**
 * One frame of a live pinch. Null when either finger is no longer tracked.
 * The caller applies the frame and then advances `pinch.lastMid` to `mid`.
 */
export function pinchFrame(pinch: PinchState, touches: TouchMap): PinchFrame | null {
  const pa = touches.get(pinch.a);
  const pb = touches.get(pinch.b);
  if (!pa || !pb) return null;
  const mid = midpoint(pa, pb);
  const d = Math.max(1, distance(pa, pb));
  return {
    mid,
    dx: mid.x - pinch.lastMid.x,
    dy: mid.y - pinch.lastMid.y,
    k: pinch.k0 * (d / pinch.d0),
  };
}

/**
 * A pointer left the screen (pointerup or pointercancel): drop it from the
 * map, and end the pinch if it was one of the pinch's two fingers. Returns
 * the pinch that survives, which is either the same object or null. The
 * remaining finger of an ended pinch deliberately starts nothing: its
 * pending gesture was cancelled when the pinch began, and inventing a new
 * pan from its stale position would jump the viewport.
 */
export function endPointer(
  touches: TouchMap,
  pinch: PinchState | null,
  pointerId: number,
): PinchState | null {
  touches.delete(pointerId);
  if (pinch && (pinch.a === pointerId || pinch.b === pointerId)) return null;
  return pinch;
}

/* ------------------------------------------------------------------ *
 * Grid snap
 * ------------------------------------------------------------------ */

/**
 * Does this drag land on the grid?
 *
 * Two inputs, and they are different kinds of thing. `snapOn` is the standing
 * preference, which persists and is what the G key and the Settings switch
 * both write. `ctrlHeld` is a momentary override for the drag in progress and
 * changes nothing that outlives it.
 *
 * Ctrl only ever loosens. Holding it with the preference already off does not
 * turn snapping back on, which would be a strange thing for a bypass to do.
 *
 * Here rather than inline in Canvas for the same reason the rest of this
 * module is: it is a decision the pointer router makes, and pinning it in a
 * test should not require mounting the canvas.
 */
export function snapsToGrid(snapOn: boolean, ctrlHeld: boolean): boolean {
  return snapOn && !ctrlHeld;
}

/* ------------------------------------------------------------------ *
 * Long-press
 * ------------------------------------------------------------------ */

/**
 * How long a finger or pen must rest before the press opens the context
 * menu. 500ms is what Android and iOS use for the same gesture, so it is the
 * delay a reader's hand already expects.
 */
export const LONG_PRESS_MS = 500;

/**
 * Whether a press of this pointer type can become a long-press. A mouse has
 * a right button for the same menu, and a held mouse button is how a slow
 * drag starts, so a mouse never long-presses.
 */
export function longPressable(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

export interface LongPress {
  readonly pointerId: number;
  /** Stop the timer. Safe to call after it fired, and more than once. */
  cancel: () => void;
}

/**
 * Arm the long-press timer for one press. The caller decides everything else:
 * the press moving past its drag threshold, a second finger landing, the lift
 * and a pointercancel each call `cancel`, and `fire` re-checks that the press
 * it was armed for is still the one in progress before acting on it.
 *
 * The one piece of state with a clock in this module, kept here so the
 * surface handlers carry a start and a cancel rather than timer bookkeeping.
 */
export function startLongPress(
  pointerId: number,
  fire: () => void,
  delayMs: number = LONG_PRESS_MS,
): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    fire();
  }, delayMs);
  return {
    pointerId,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
