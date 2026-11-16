import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { NodeKind } from '../sim/types';
import { GLOSSARY_BY_ID } from '../content/glossary';
import { KIND_NAME, KIND_TERM } from './nodeVisuals';
import { openGlossaryEntry } from './Tooltip';

/* ------------------------------------------------------------------ *
 * The palette's "what is this?" card.
 *
 * A student who has never met a sidecar proxy cannot pick one by name, so
 * each component row explains itself: what it is, a product they may have
 * heard of, and when to reach for it, with a way into the glossary.
 *
 * The row's own gestures are untouched. A click still adds, a drag still
 * carries, and the card only listens alongside them:
 *   - hover opens it after the same short delay as a tooltip;
 *   - keyboard focus opens it at once, and "?" moves into it;
 *   - on a touch screen a long press opens it, and the click that ends
 *     that press is swallowed so reading never litters the canvas.
 * A press or a drag closes a hovered card, so it never sits over the
 * canvas while a component is being placed.
 * ------------------------------------------------------------------ */

/** Same rhythm as the tooltips, so the two read as one system. */
const OPEN_DELAY_MS = 400;
const GRACE_MS = 500;
const CLOSE_DELAY_MS = 140;
/** Long enough not to fire on a tap, short enough not to feel stuck. */
const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll or a drag. */
const SLOP_PX = 8;
const MARGIN = 8;
const GAP = 8;

type Source = 'hover' | 'focus' | 'touch';

interface OpenCard {
  kind: NodeKind;
  anchor: HTMLElement;
  source: Source;
}

export interface RowCardHandlers {
  onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
  onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
  'aria-describedby': string | undefined;
}

export interface PaletteCardApi {
  /** Handlers and the description link for one component row. */
  rowProps: (kind: NodeKind) => RowCardHandlers;
  /** Call first in the row's click: true means a long press just ended, so do not add. */
  consumeClick: (kind: NodeKind) => boolean;
  /** Close whatever is open, for a drag starting. */
  close: () => void;
  /** Escape on a row: true when it closed a card and the key is spent. */
  dismiss: () => boolean;
  /** "?" on a row: opens its card if need be and moves focus to the link. */
  focusCard: (kind: NodeKind, row: HTMLElement) => boolean;
  card: ReactNode;
}

/** Keys that move along the rail, handed back to it from inside a card. */
const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * `onNavigate` moves along the rail from `row` for an arrow, Home or End
 * pressed inside the card.
 */
export function usePaletteCard(
  enabled: boolean,
  onNavigate?: (key: string, row: HTMLElement) => void,
): PaletteCardApi {
  const [open, setOpen] = useState<OpenCard | null>(null);
  /** Where the card sits, for the card it was measured for. */
  const [placed, setPlaced] = useState<{
    for: OpenCard;
    left: number;
    top: number;
  } | null>(null);
  /** Bumped by scroll and resize so the card follows its row. */
  const [tick, setTick] = useState(0);
  const descId = useId();

  const openRef = useRef<OpenCard | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const learnRef = useRef<HTMLButtonElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const pressTimer = useRef<number | undefined>(undefined);
  const pressAt = useRef<{ x: number; y: number } | null>(null);
  const lastCloseAt = useRef(0);
  const inCard = useRef(false);
  /** The row a press is about to focus, so that focus does not open the card. */
  const pressFocus = useRef<HTMLElement | null>(null);
  /** Set while focus is handed back to a row on purpose. */
  const quietFocus = useRef(false);
  /** The kind whose long press opened the card, until its click is swallowed. */
  const longPressed = useRef<NodeKind | null>(null);
  /** "?" asked for the link before the card had rendered it. */
  const focusOnOpen = useRef(false);

  const commit = useCallback((next: OpenCard | null) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (!next && openRef.current) lastCloseAt.current = Date.now();
    if (!next) inCard.current = false;
    openRef.current = next;
    setOpen(next);
  }, []);

  const close = useCallback(() => {
    window.clearTimeout(pressTimer.current);
    commit(null);
  }, [commit]);

  const scheduleClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (!inCard.current) commit(null);
    }, CLOSE_DELAY_MS);
  }, [commit]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(pressTimer.current);
    },
    [],
  );

  /* While a card is open: a press anywhere else closes it, which is the way
     out on a touch screen, and scrolling or resizing moves it with its row. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (cardRef.current?.contains(t) || open.anchor.contains(t)) return;
      commit(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && open.source !== 'focus') commit(null);
    };
    const follow = () => setTick((n) => n + 1);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [open, commit]);

  /* Beside the row when the rail leaves room to its right, which it does on a
     desktop; under it (or over it) when the rail is the whole width, as on a
     phone. Measured before paint, so it never flashes in the wrong place. */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!open || !card) return;
    // A row filtered out by the search: the palette closes the card then.
    if (!open.anchor.isConnected) return;
    const r = open.anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(Math.max(v, lo), Math.max(lo, hi));
    let left: number;
    let top: number;
    if (r.right + GAP + w <= vw - MARGIN) {
      left = r.right + GAP;
      top = clamp(r.top + r.height / 2 - h / 2, MARGIN, vh - h - MARGIN);
    } else {
      left = clamp(r.left + MARGIN * 2, MARGIN, vw - w - MARGIN);
      top =
        r.bottom + GAP + h <= vh - MARGIN
          ? r.bottom + GAP
          : clamp(r.top - GAP - h, MARGIN, vh - h - MARGIN);
    }
    setPlaced({ for: open, left: Math.round(left), top: Math.round(top) });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      learnRef.current?.focus();
    }
  }, [open, tick, commit]);

  const rowProps = useCallback(
    (kind: NodeKind): RowCardHandlers => ({
      onPointerEnter: (e) => {
        if (!enabled || e.pointerType === 'touch') return;
        const anchor = e.currentTarget;
        window.clearTimeout(closeTimer.current);
        if (openRef.current?.anchor === anchor) return;
        window.clearTimeout(openTimer.current);
        // Already reading cards: the neighbour opens at once.
        const quick =
          openRef.current !== null || Date.now() - lastCloseAt.current < GRACE_MS;
        const next: OpenCard = { kind, anchor, source: 'hover' };
        if (quick) commit(next);
        else openTimer.current = window.setTimeout(() => commit(next), OPEN_DELAY_MS);
      },
      onPointerLeave: (e) => {
        if (e.pointerType === 'touch') return;
        window.clearTimeout(openTimer.current);
        const o = openRef.current;
        if (o && o.anchor === e.currentTarget && o.source === 'hover') scheduleClose();
      },
      onPointerDown: (e) => {
        longPressed.current = null;
        pressFocus.current = e.currentTarget;
        window.clearTimeout(openTimer.current);
        // Pressing to add or to drag: the card would only be in the way.
        if (openRef.current?.source === 'hover') commit(null);
        if (!enabled || e.pointerType !== 'touch') return;
        const anchor = e.currentTarget;
        pressAt.current = { x: e.clientX, y: e.clientY };
        window.clearTimeout(pressTimer.current);
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = undefined;
          longPressed.current = kind;
          commit({ kind, anchor, source: 'touch' });
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        const at = pressAt.current;
        if (pressTimer.current === undefined || !at) return;
        if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > SLOP_PX) {
          window.clearTimeout(pressTimer.current);
          pressTimer.current = undefined;
        }
      },
      onPointerUp: () => {
        window.clearTimeout(pressTimer.current);
        pressTimer.current = undefined;
      },
      onPointerCancel: () => {
        window.clearTimeout(pressTimer.current);
        pressTimer.current = undefined;
      },
      onFocus: (e) => {
        const el = e.currentTarget;
        const fromPress = pressFocus.current === el;
        pressFocus.current = null;
        if (quietFocus.current) {
          quietFocus.current = false;
          return;
        }
        if (!enabled || fromPress) return;
        commit({ kind, anchor: el, source: 'focus' });
      },
      onBlur: (e) => {
        pressFocus.current = null;
        const next = e.relatedTarget as Node | null;
        if (next && cardRef.current?.contains(next)) return;
        const o = openRef.current;
        if (o && o.anchor === e.currentTarget && o.source !== 'hover') commit(null);
      },
      onContextMenu: (e) => {
        // The long press already answered; the system menu would cover it.
        if (longPressed.current === kind || openRef.current?.source === 'touch') {
          e.preventDefault();
        }
      },
      'aria-describedby': open?.kind === kind ? descId : undefined,
    }),
    [enabled, commit, scheduleClose, open, descId],
  );

  const consumeClick = useCallback((kind: NodeKind) => {
    if (longPressed.current !== kind) return false;
    longPressed.current = null;
    return true;
  }, []);

  const dismiss = useCallback(() => {
    if (!openRef.current) return false;
    commit(null);
    return true;
  }, [commit]);

  const focusCard = useCallback(
    (kind: NodeKind, row: HTMLElement) => {
      if (!enabled || !GLOSSARY_BY_ID.get(KIND_TERM[kind])?.intro) return false;
      if (openRef.current?.anchor === row && learnRef.current) {
        learnRef.current.focus();
        return true;
      }
      focusOnOpen.current = true;
      commit({ kind, anchor: row, source: 'focus' });
      return true;
    },
    [enabled, commit],
  );

  /** Back to the row without the focus reopening anything. */
  const returnToRow = useCallback(() => {
    const anchor = openRef.current?.anchor;
    commit(null);
    if (anchor?.isConnected) {
      quietFocus.current = true;
      anchor.focus();
      quietFocus.current = false;
    }
  }, [commit]);

  const pos = placed && placed.for === open ? placed : null;
  const intro = open ? GLOSSARY_BY_ID.get(KIND_TERM[open.kind])?.intro : undefined;
  const name = open ? KIND_NAME[open.kind] : '';

  const card =
    open && intro
      ? createPortal(
          <div
            ref={cardRef}
            className="tip pal-card"
            data-chrome=""
            style={{
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              // Laid out but not painted until it has been measured.
              visibility: pos ? 'visible' : 'hidden',
            }}
            onPointerEnter={() => {
              inCard.current = true;
              window.clearTimeout(closeTimer.current);
            }}
            onPointerLeave={() => {
              inCard.current = false;
              if (openRef.current?.source === 'hover') scheduleClose();
            }}
            onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
              const row = openRef.current?.anchor;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                returnToRow();
                return;
              }
              // The arrows keep walking the rail from inside the card, the
              // way they did from the row.
              if (row && onNavigate && NAV_KEYS.has(e.key)) {
                e.preventDefault();
                e.stopPropagation();
                returnToRow();
                onNavigate(e.key, row);
              }
            }}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (
                next &&
                (cardRef.current?.contains(next) || open.anchor.contains(next))
              ) {
                return;
              }
              commit(null);
            }}
          >
            <p className="tip-term">{name}</p>
            <div id={descId}>
              <p className="pal-card-what">{intro.what}</p>
              <p className="pal-card-line">
                <span className="pal-card-k">Example: </span>
                {intro.example}
              </p>
              <p className="pal-card-line">
                <span className="pal-card-k">When to use it: </span>
                {intro.useWhen}
              </p>
            </div>
            <p className="pal-card-more">
              <button
                ref={learnRef}
                type="button"
                className="tip-see-link"
                aria-label={`Learn more about ${name}`}
                onClick={() => {
                  const id = KIND_TERM[open.kind];
                  // Focus goes back to the row first, so closing the
                  // glossary returns it there rather than to the page.
                  returnToRow();
                  openGlossaryEntry(id);
                }}
              >
                Learn more
              </button>
            </p>
          </div>,
          document.body,
        )
      : null;

  return { rowProps, consumeClick, close, dismiss, focusCard, card };
}
