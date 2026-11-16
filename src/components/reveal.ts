/**
 * Keep the part being worked on in view, as plain arithmetic.
 *
 * Opening the inspector, a brief or a verdict covers part of the canvas, and
 * the part it covers is often the very box the panel is about: select
 * Database at 1280 and the inspector lands on it. The camera should then
 * move, but as little as it can. A re-fit or a re-centre throws away the
 * view the reader chose; a pan of exactly the distance that clears the panel
 * keeps their zoom and keeps everything else roughly where it was.
 *
 * A diagram that was all on screen is kept all on screen instead, so
 * selecting API Server does not hide the Database beside it; Canvas.tsx
 * (keepWhole) decides that before this pan is asked for.
 *
 * Kept out of Canvas.tsx, beside fit.ts, so it can be tested without
 * mounting the canvas.
 */

/** A box in client px. */
export interface RevealBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RevealPan {
  dx: number;
  dy: number;
}

/** Air left between the box and whatever it is moved clear of. */
export const REVEAL_PAD = 16;

const NONE: RevealPan = { dx: 0, dy: 0 };

function shifted(b: RevealBox, p: RevealPan): RevealBox {
  return {
    left: b.left + p.dx,
    top: b.top + p.dy,
    right: b.right + p.dx,
    bottom: b.bottom + p.dy,
  };
}

function overlaps(a: RevealBox, b: RevealBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * The shift on one axis that brings [lo, hi] inside [min, max]. Too long to
 * fit, it lines up the start: a diagram is read from its left, and a card
 * from its title.
 */
function into(lo: number, hi: number, min: number, max: number): number {
  if (hi - lo > max - min) return min - lo;
  if (lo < min) return min - lo;
  if (hi > max) return max - hi;
  return 0;
}

/**
 * The smallest pan, in client px, that puts `target` inside `room` and clear
 * of every box in `avoid`. Positive moves the content right or down.
 *
 * `room` is the uncovered canvas (the .stage-safe sentinel); `avoid` is the
 * floating cards over it that are not part of that rect ("What just
 * happened", the tour). A box already in the room and clear of them does not
 * move. When no pan clears every card, the box is still brought into the
 * room, which is the part that matters most.
 */
export function revealPan(
  target: RevealBox,
  room: RevealBox,
  avoid: readonly RevealBox[] = [],
  pad = REVEAL_PAD,
): RevealPan {
  const inner: RevealBox = {
    left: room.left + pad,
    top: room.top + pad,
    right: room.right - pad,
    bottom: room.bottom - pad,
  };
  if (inner.right <= inner.left || inner.bottom <= inner.top) return NONE;
  const base: RevealPan = {
    dx: into(target.left, target.right, inner.left, inner.right),
    dy: into(target.top, target.bottom, inner.top, inner.bottom),
  };
  const fits = (p: RevealPan) => {
    const b = shifted(target, p);
    return (
      b.left >= inner.left - 0.5 &&
      b.right <= inner.right + 0.5 &&
      b.top >= inner.top - 0.5 &&
      b.bottom <= inner.bottom + 0.5
    );
  };
  const clear = (p: RevealPan) => {
    const b = shifted(target, p);
    return avoid.every((o) => !overlaps(b, o));
  };
  if (clear(base)) return base;

  // Each card in the way offers four ways past it; the shortest that lands
  // in the room and clear of every card wins.
  const at = shifted(target, base);
  let best: RevealPan | null = null;
  let bestCost = Infinity;
  for (const o of avoid) {
    if (!overlaps(at, o)) continue;
    const options: RevealPan[] = [
      { dx: base.dx + (o.left - pad - at.right), dy: base.dy },
      { dx: base.dx + (o.right + pad - at.left), dy: base.dy },
      { dx: base.dx, dy: base.dy + (o.top - pad - at.bottom) },
      { dx: base.dx, dy: base.dy + (o.bottom + pad - at.top) },
    ];
    for (const p of options) {
      if (!fits(p) || !clear(p)) continue;
      const cost = Math.abs(p.dx) + Math.abs(p.dy);
      if (cost < bestCost) {
        best = p;
        bestCost = cost;
      }
    }
  }
  return best ?? base;
}
