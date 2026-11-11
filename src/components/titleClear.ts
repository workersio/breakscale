/**
 * Clearing box titles from under a card that floats over the canvas, such
 * as the "Find the problem" answer. All rects are in screen px.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Pan {
  dx: number;
  dy: number;
}

/** The room kept between the card and the nearest title, in px. */
export const TITLE_GAP = 8;

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function shifted(b: Box, p: Pan): Box {
  return {
    left: b.left + p.dx,
    top: b.top + p.dy,
    right: b.right + p.dx,
    bottom: b.bottom + p.dy,
  };
}

/**
 * Whether the box the answer names (if any) sits whole inside `view` and
 * clear of the card. A view that loses it is worse than a covered title.
 */
export function keepsInView(keep: Box | null, view: Box, card: Box): boolean {
  if (!keep) return true;
  return (
    !overlaps(keep, card) &&
    keep.left >= view.left &&
    keep.right <= view.right &&
    keep.top >= view.top &&
    keep.bottom <= view.bottom
  );
}

/**
 * The smallest pan, down or right, that leaves no title under `card` and
 * keeps `keep` (the box the answer names, if any) whole inside `view` and
 * clear of the card. `{ dx: 0, dy: 0 }` when nothing is covered; null when
 * neither pan works, which leaves a refit to the caller.
 *
 * Only down and right: the card sits in the top-left corner, so moving the
 * diagram away from it is the only direction that helps.
 */
export function titleClearPan(
  card: Box,
  titles: readonly Box[],
  view: Box,
  keep: Box | null,
): Pan | null {
  const covered = titles.filter((t) => overlaps(t, card));
  if (covered.length === 0) return { dx: 0, dy: 0 };
  let top = Infinity;
  let left = Infinity;
  for (const t of covered) {
    top = Math.min(top, t.top);
    left = Math.min(left, t.left);
  }
  const fits = (p: Pan) => {
    if (titles.some((t) => overlaps(shifted(t, p), card))) return false;
    return keepsInView(keep && shifted(keep, p), view, card);
  };
  const options = [
    { dx: 0, dy: card.bottom + TITLE_GAP - top },
    { dx: card.right + TITLE_GAP - left, dy: 0 },
  ]
    .filter(fits)
    .sort((a, b) => a.dx + a.dy - (b.dx + b.dy));
  return options[0] ?? null;
}
