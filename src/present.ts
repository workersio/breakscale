import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* ------------------------------------------------------------------ *
 * Presenting mode: the canvas and the live numbers, big, for a room.
 *
 * A session preference like the play speed: in no link, no saved file and
 * no layout, so a reload always comes back to the normal app. P toggles it.
 * While it is on, X, W and R crash, slow and fix the part in hand (the one
 * selected, or the one keyboard focus is on), so a teacher can break a
 * design without opening a panel in front of the class. Those three keys do
 * nothing outside presenting, where nobody has learned them.
 * ------------------------------------------------------------------ */

export type PresentAction = 'toggle' | 'crash' | 'slow' | 'fix';

/** A field is being typed into, so no single letter belongs to the app. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
  );
}

/** What a key press means here, or null for a key this mode leaves alone. */
export function presentKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>,
  presenting: boolean,
): PresentAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return null;
  const k = e.key.toLowerCase();
  if (k === 'p') return 'toggle';
  if (!presenting) return null;
  if (k === 'x') return 'crash';
  if (k === 'w') return 'slow';
  if (k === 'r') return 'fix';
  return null;
}

/* ---- full screen, which only the reader can ask for ---- */

const subscribeFullscreen = (cb: () => void) => {
  document.addEventListener('fullscreenchange', cb);
  return () => document.removeEventListener('fullscreenchange', cb);
};
const isFullscreen = () => document.fullscreenElement !== null;
const notFullscreen = () => false;

/** Whether this browser can go full screen at all. iPhone Safari cannot. */
export function canFullscreen(): boolean {
  return typeof document !== 'undefined' && document.fullscreenEnabled === true;
}

export function toggleFullscreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  } catch {
    // Refused (an iframe without permission): the mode works without it.
  }
}

export function useFullscreen(): boolean {
  return useSyncExternalStore(subscribeFullscreen, isFullscreen, notFullscreen);
}

/**
 * The part keyboard focus is on, by id, or null. Tab already walks the
 * diagram's parts; presenting lets the part under focus be the one X, W
 * and R act on, so nothing has to be clicked.
 */
export function useFocusedPart(enabled: boolean): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const a = document.activeElement;
      const node =
        a instanceof Element ? a.closest('[data-hit="node"][data-id]') : null;
      setId(node?.getAttribute('data-id') ?? null);
    };
    read();
    document.addEventListener('focusin', read);
    document.addEventListener('focusout', read);
    return () => {
      document.removeEventListener('focusin', read);
      document.removeEventListener('focusout', read);
    };
  }, [enabled]);
  return enabled ? id : null;
}

/**
 * The mode's state and its keys. `onAction` is read through a ref, so the
 * listener is installed once and always runs the latest handler.
 */
export function usePresenting(
  onFault: (kind: 'crash' | 'slow' | 'fix') => void,
  onChange?: (presenting: boolean) => void,
): {
  presenting: boolean;
  togglePresenting: () => void;
  stopPresenting: () => void;
} {
  const [presenting, setPresenting] = useState(false);
  const live = useRef(presenting);
  const faultRef = useRef(onFault);
  const changeRef = useRef(onChange);
  useEffect(() => {
    faultRef.current = onFault;
    changeRef.current = onChange;
  });

  /* Read and written through the ref so two presses in one frame (a key
     and a click) cannot both see the old value. */
  const set = useCallback((next: boolean) => {
    if (live.current === next) return;
    live.current = next;
    setPresenting(next);
    changeRef.current?.(next);
  }, []);
  const togglePresenting = useCallback(() => set(!live.current), [set]);
  const stopPresenting = useCallback(() => set(false), [set]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog (the palette, the shortcuts, a picker) owns the keys.
      if (document.querySelector('[aria-modal="true"]')) return;
      const act = presentKeyAction(e, live.current);
      if (act === null) return;
      e.preventDefault();
      if (act === 'toggle') set(!live.current);
      else faultRef.current(act);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  /* Leaving the mode leaves full screen too: the mode is what full screen
     was asked for. Only on the change from on to off, so a page that was
     already full screen at load is left alone. */
  const was = useRef(presenting);
  useEffect(() => {
    if (was.current && !presenting && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    was.current = presenting;
  }, [presenting]);

  return { presenting, togglePresenting, stopPresenting };
}
