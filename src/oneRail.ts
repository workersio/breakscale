import { useSyncExternalStore } from 'react';

/**
 * Room for one rail beside the canvas, not two.
 *
 * A tablet held upright is 768 to 834px wide. The components rail and the
 * inspector together took 568px of that, and "What just happened" and the
 * tour card, laid out for the space between them, slid under the rail.
 * Here only one of the two is open at a time: the rail starts closed, and
 * opening either puts the other away. A phone has its own version of this
 * rule (its panels are sheets), so the shell asks this only off a phone.
 */
export const ONE_RAIL_QUERY = '(max-width: 899px) and (orientation: portrait)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(ONE_RAIL_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function isOneRail(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(ONE_RAIL_QUERY).matches;
}

function serverSnapshot(): boolean {
  return false;
}

export function useOneRail(): boolean {
  return useSyncExternalStore(subscribe, isOneRail, serverSnapshot);
}

/**
 * Whether the components rail is drawn. `wanted` is the reader's choice
 * (which is what gets saved); with room for one rail, a shown inspector
 * covers it, without writing over that choice.
 */
export function libraryShown(
  wanted: boolean,
  oneRail: boolean,
  inspectorShown: boolean,
): boolean {
  return wanted && !(oneRail && inspectorShown);
}
