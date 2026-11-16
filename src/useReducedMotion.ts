import { useSyncExternalStore } from 'react';

/**
 * Has the reader asked for less motion?
 *
 * CSS already honours the query for transitions. This is for motion that is
 * driven from script, which a stylesheet cannot switch off.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function read(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** No window: assume motion is fine, the browser default. */
function serverSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, serverSnapshot);
}
