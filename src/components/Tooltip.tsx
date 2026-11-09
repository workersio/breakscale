import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY_BY_ID, type GlossaryEntry } from '../content/glossary';
import { usePreference } from '../content/preferences';
import './Tooltip.css';

/* ==========================================================================
   Explanation tooltips.

   The native `title` attribute is not good enough for a teaching tool. It
   waits about a second, cannot be styled, never appears for keyboard users,
   and does nothing at all on a touch screen. Every one of those matters when
   the entire point is that a confused student can find out what a word means.

   ARCHITECTURE: ONE OVERLAY, MANY CHEAP TRIGGERS.

   The obvious build — each <Term> owns its own useState, refs, timers and
   portal — is the wrong one here. This app re-renders its whole readout tree
   ten times a second while the simulation runs, and a screen carries dozens
   of terms. Paying for six hooks and a subscription per term, sixty times a
   second, to service the ONE tooltip that can be open at a time, is waste
   that shows up as jank on the machines students actually use.

   So the state lives in a module-level controller instead. A <Term> is a
   plain <span> with event handlers: no state, no effects, no refs, no id
   generation, nothing to reconcile beyond its own children. Its handlers are
   stable module functions, so React sees identical props across re-renders.
   Exactly one <TooltipLayer/> subscribes to the controller and renders the
   single open panel. Real work is proportional to tooltips OPEN, not to
   tooltips PRESENT.

   The trigger keeps its own identity in `data-term`, which the controller
   reads back off the DOM. That is what lets the trigger stay stateless.
   ========================================================================== */

/* ------------------------------------------------------------------ *
 * Timing
 * ------------------------------------------------------------------ */

/** Delay before opening, so sweeping across the UI does not strobe tooltips. */
const OPEN_DELAY_MS = 400;

/**
 * Once one tooltip has been open, its neighbours open immediately. Re-waiting
 * four tenths of a second per term makes comparing two numbers feel broken,
 * which is precisely the thing a student does most in this app.
 */
const GRACE_MS = 500;

/**
 * Delay before closing. Long enough that the pointer can cross the gap into
 * the panel to reach a "see also" link, short enough not to feel sticky.
 */
const CLOSE_DELAY_MS = 140;

/**
 * How long after a focus opens a tooltip a scroll still counts as the one
 * that focus caused. Smooth scrolling runs a few frames; a reader scrolling
 * on purpose does not start within a quarter second of tabbing.
 */
const FOCUS_SCROLL_MS = 250;

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Keep the panel clear of the viewport edge by this much. */
const VIEWPORT_MARGIN = 8;
/** Gap between the trigger and the panel, leaving room for the arrow. */
const OFFSET = 10;
/**
 * Half the arrow square's side. Published to CSS as `--tip-arrow` so the
 * stylesheet and the placement maths cannot drift apart.
 */
const ARROW = 6;
/** The arrow never rides closer than this to a panel corner. */
const ARROW_INSET = 16;
/** Must match `max-width` on `.tip` in Tooltip.css. */
const PANEL_MAX_W = 300;

type Side = 'top' | 'bottom' | 'left' | 'right';

interface Placement {
  left: number;
  top: number;
  side: Side;
  /** Arrow offset along the panel's cross axis, in panel-local px. */
  arrowOffset: number;
}

/* ------------------------------------------------------------------ *
 * Controller
 *
 * A tiny external store. Components subscribe with useSyncExternalStore,
 * which is the supported way to read module state without each subscriber
 * paying for an effect that re-runs on every render.
 * ------------------------------------------------------------------ */

interface OpenState {
  entry: GlossaryEntry;
  trigger: HTMLElement;
  /**
   * How it was opened. Keyboard and touch openings are "sticky": they ignore
   * pointerleave, because there is no pointer to leave. Only an explicit
   * dismissal closes them.
   */
  source: 'hover' | 'focus' | 'touch';
}

const listeners = new Set<() => void>();
let state: OpenState | null = null;
let openTimer: number | undefined;
let closeTimer: number | undefined;
let lastCloseAt = 0;
/** When the current tooltip opened, so a scroll its own focus caused is told apart. */
let openedAt = 0;
/** Set while the pointer is inside the open panel itself. */
let pointerInPanel = false;

/**
 * Where "see also" links go. The shell registers the glossary panel's opener
 * here once, which keeps <Term> free of a prop that would otherwise have to
 * be threaded through every call site in the app.
 */
let navigateHandler: ((id: string) => void) | null = null;

/**
 * Registers the handler that "see also" links call. Pass null to unregister.
 * Returns nothing; the shell owns the lifetime.
 */
export function setGlossaryNavigate(fn: ((id: string) => void) | null): void {
  navigateHandler = fn;
}

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): OpenState | null {
  return state;
}

function clearTimers(): void {
  if (openTimer !== undefined) window.clearTimeout(openTimer);
  if (closeTimer !== undefined) window.clearTimeout(closeTimer);
  openTimer = undefined;
  closeTimer = undefined;
}

/*
 * The engaged state is written straight onto the trigger's DOM node rather
 * than being derived from React state. That is what keeps <Term> stateless:
 * marking the one open trigger must not re-render the other forty.
 */
function markTrigger(el: HTMLElement | undefined, on: boolean): void {
  if (!el) return;
  if (on) el.dataset.open = 'true';
  else delete el.dataset.open;
}

function commitOpen(next: OpenState): void {
  clearTimers();
  if (state?.trigger === next.trigger && state.source === next.source) return;
  markTrigger(state?.trigger, false);
  state = next;
  openedAt = Date.now();
  markTrigger(next.trigger, true);
  emit();
}

function closeNow(): void {
  clearTimers();
  if (!state) return;
  markTrigger(state.trigger, false);
  state = null;
  pointerInPanel = false;
  lastCloseAt = Date.now();
  emit();
}

/**
 * Closes and returns focus to whichever trigger was open, so Escape from a
 * tooltip does not strand the keyboard user at the top of the document.
 */
function dismissAndRestoreFocus(): void {
  const trigger = state?.trigger;
  closeNow();
  trigger?.focus();
}

function scheduleOpen(next: OpenState): void {
  clearTimers();
  // Inside the grace window the reader is already reading tooltips, so making
  // them wait again would just feel unresponsive.
  const delay = Date.now() - lastCloseAt < GRACE_MS ? 0 : OPEN_DELAY_MS;
  if (delay === 0) {
    commitOpen(next);
    return;
  }
  openTimer = window.setTimeout(() => {
    openTimer = undefined;
    commitOpen(next);
  }, delay);
}

function scheduleClose(): void {
  clearTimers();
  closeTimer = window.setTimeout(() => {
    closeTimer = undefined;
    // The pointer may have landed in the panel during the grace period.
    if (pointerInPanel) return;
    closeNow();
  }, CLOSE_DELAY_MS);
}

/** Cancels a pending open without disturbing an already-open tooltip. */
function cancelPendingOpen(): void {
  if (openTimer !== undefined) {
    window.clearTimeout(openTimer);
    openTimer = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Trigger handlers
 *
 * Module-level and therefore referentially stable, so a <Term> that
 * re-renders at 10Hz hands React the exact same function objects every
 * time and nothing downstream is invalidated.
 * ------------------------------------------------------------------ */

function entryOf(el: HTMLElement): GlossaryEntry | undefined {
  const id = el.dataset.term;
  return id ? GLOSSARY_BY_ID.get(id) : undefined;
}

function onTriggerPointerEnter(e: React.PointerEvent<HTMLElement>): void {
  // A touch tap also emits pointerenter. Let the click handler own touch so
  // the tooltip toggles rather than sticking open behind the finger.
  if (e.pointerType === 'touch') return;
  const el = e.currentTarget;
  const entry = entryOf(el);
  if (!entry) return;
  scheduleOpen({ entry, trigger: el, source: 'hover' });
}

function onTriggerPointerLeave(e: React.PointerEvent<HTMLElement>): void {
  if (e.pointerType === 'touch') return;
  cancelPendingOpen();
  // A tooltip opened by keyboard or tap is not dismissed by a stray pointer
  // wandering off the trigger; only its own kind of dismissal closes it.
  if (state && state.trigger === e.currentTarget && state.source !== 'hover') {
    return;
  }
  scheduleClose();
}

function onTriggerFocus(e: React.FocusEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const entry = entryOf(el);
  if (!entry) return;
  // Keyboard focus is deliberate, so it opens immediately. Tabbing to a term
  // and then waiting almost half a second reads as the app being broken.
  commitOpen({ entry, trigger: el, source: 'focus' });
}

function onTriggerBlur(e: React.FocusEvent<HTMLElement>): void {
  cancelPendingOpen();
  // Focus moving INTO the panel (to reach a "see also" link) must not close
  // the thing being reached.
  const next = e.relatedTarget as Node | null;
  if (next && panelEl?.contains(next)) return;
  if (state && state.trigger === e.currentTarget) closeNow();
}

/*
 * Whether the tooltip was already open when the current press began.
 *
 * A press on a focusable span runs pointerdown, then focus, then click. Focus
 * opens the tooltip, so by the time the click arrived it saw an open tooltip
 * on its own trigger and toggled it shut: the first tap on every term did
 * nothing at all. The toggle has to ask what was open before the press, not
 * what the press itself just opened.
 */
let pressTrigger: HTMLElement | null = null;
let pressFoundOpen = false;

function onTriggerPointerDown(e: React.PointerEvent<HTMLElement>): void {
  pressTrigger = e.currentTarget;
  // A hover-opened tooltip does not count. The pointer opened it on the way
  // to the click, inside the grace window with no delay at all, so a click
  // that closed it would read as the click doing nothing. Clicking pins it.
  pressFoundOpen = state?.trigger === e.currentTarget && state.source !== 'hover';
}

/**
 * Touch has no hover, so a tap is the only gesture available. It toggles:
 * tap to read, tap again to dismiss. `onClick` rather than a pointer handler
 * because it fires for mouse, touch, pen and the keyboard's Enter/Space
 * activation of a button-like element alike.
 */
function onTriggerClick(e: React.MouseEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const entry = entryOf(el);
  if (!entry) return;
  // A click with no press behind it (assistive tech, a synthesised click)
  // falls back to asking what is open now. `detail === 0` is such a click
  // even when a press on this term was dragged off earlier and never clicked,
  // which would otherwise leave that press's answer standing.
  const fromPress = pressTrigger === el && e.detail !== 0;
  const wasOpen = fromPress ? pressFoundOpen : state?.trigger === el;
  pressTrigger = null;
  if (wasOpen) {
    closeNow();
    return;
  }
  // `detail === 0` means the click was synthesised by the keyboard rather
  // than produced by a pointer, so it keeps the sticky 'focus' source.
  commitOpen({
    entry,
    trigger: el,
    source: e.detail === 0 ? 'focus' : 'touch',
  });
}

function onTriggerKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key === 'Enter' || e.key === ' ') {
    // Space would scroll the nearest scroll container.
    e.preventDefault();
    const el = e.currentTarget;
    const entry = entryOf(el);
    if (!entry) return;
    if (state && state.trigger === el) closeNow();
    else commitOpen({ entry, trigger: el, source: 'focus' });
  }
}

/* ------------------------------------------------------------------ *
 * Term
 * ------------------------------------------------------------------ */

export interface TermProps {
  /**
   * Glossary entry id. An unknown id renders the children completely
   * unchanged and attaches nothing, so a typo degrades to plain text rather
   * than to a dead affordance that promises an explanation it cannot give.
   */
  id: string;
  children: ReactNode;
  /** Extra classes on the trigger span. */
  className?: string;
  /**
   * Drops the dotted underline while keeping the tooltip. For the few places
   * where the surrounding element already reads as a label and a second
   * underline would only add noise. Still focusable, still explains.
   */
  bare?: boolean;
}

/**
 * Wraps a term and attaches its glossary explanation.
 *
 * Renders a <span>, so it is safe inside a paragraph, a table cell, a button
 * or a label — but NOT inside an <svg>. Canvas readouts are explained through
 * the inspector and the glossary panel instead.
 *
 * Costs one span and no hooks. Safe to use dozens of times on a tree that
 * re-renders at 10Hz.
 */
export function Term({ id, children, className, bare = false }: TermProps) {
  const enabled = usePreference('tooltips');
  const entry = GLOSSARY_BY_ID.get(id);

  /*
   * With tooltips switched off this path has to be genuinely free. Returning
   * the children bare means no cursor change, no hover tint, no focus stop
   * and no listeners: a <Term> costs exactly what the text inside it costs.
   * The glossary panel is unaffected, so every explanation is still one click
   * away.
   *
   * An unknown id degrades the same way, which is why the glossary wiring test
   * exists: silence here is indistinguishable from a missing entry.
   */
  if (!enabled || !entry) return <>{children}</>;

  /*
   * One shared description node per glossary id, rendered once by
   * <TooltipLayer/> rather than once per <Term>. Several terms on a screen
   * may share an id — p99 appears in the inspector and in the metrics strip
   * — and duplicate element ids would be invalid. Pointing every instance at
   * one node is both valid and cheaper.
   */
  return (
    <span
      data-term={id}
      className={`term${bare ? ' term-bare' : ''}${className ? ` ${className}` : ''}`}
      tabIndex={0}
      /*
       * NOT role="button". A button announces "collapsed / expanded" and
       * implies an action, when the only thing on offer is a description.
       * The accessible NAME therefore stays the visible text — critically,
       * so a screen reader still reads the number a student is pointing at
       * instead of having it replaced by a label. The description node is a
       * separate element outside this span, so it is never folded into the
       * name and never read twice.
       *
       * It is also always present. Pointing aria-describedby at the floating
       * panel instead would leave the reference dangling whenever the
       * tooltip is shut, which is almost always — a screen reader user would
       * then get no hint that an explanation exists at all, and
       * discoverability is the entire point of the feature.
       */
      aria-describedby={descId(id)}
      onPointerEnter={onTriggerPointerEnter}
      onPointerLeave={onTriggerPointerLeave}
      onPointerDown={onTriggerPointerDown}
      onFocus={onTriggerFocus}
      onBlur={onTriggerBlur}
      onClick={onTriggerClick}
      onKeyDown={onTriggerKeyDown}
    >
      {children}
    </span>
  );
}

/** Id of the shared hidden description node for a glossary entry. */
function descId(id: string): string {
  return `term-desc-${id}`;
}

/* ------------------------------------------------------------------ *
 * Positioning
 * ------------------------------------------------------------------ */

/**
 * Chooses a side and a position that keep the whole panel on screen.
 *
 * This app is a fixed-viewport layout with panels hard against every edge,
 * so the two cases that break naive positioning are real and routine: a term
 * in the rightmost inspector field, and a term in the bottom metrics strip.
 *
 * The order is deliberate. Vertical placement is tried first because a panel
 * above or below a term keeps the term itself readable; horizontal is the
 * fallback for a term in a short viewport where neither vertical side fits.
 * Whatever is chosen, the result is clamped, so the panel is on screen even
 * in a viewport too small for any side to fit properly.
 */
function place(t: DOMRect, pw: number, ph: number): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const fitsAbove = t.top - OFFSET - ph >= VIEWPORT_MARGIN;
  const fitsBelow = t.bottom + OFFSET + ph <= vh - VIEWPORT_MARGIN;
  const fitsRight = t.right + OFFSET + pw <= vw - VIEWPORT_MARGIN;
  const fitsLeft = t.left - OFFSET - pw >= VIEWPORT_MARGIN;

  let side: Side;
  if (fitsAbove) side = 'top';
  else if (fitsBelow) side = 'bottom';
  else if (fitsLeft) side = 'left';
  else if (fitsRight) side = 'right';
  // Nothing fits outright: take the side with the most room and let the
  // clamp below do what it can.
  else side = t.top >= vh - t.bottom ? 'top' : 'bottom';

  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - pw - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - ph - VIEWPORT_MARGIN);
  const clampX = (x: number) => Math.min(Math.max(x, VIEWPORT_MARGIN), maxLeft);
  const clampY = (y: number) => Math.min(Math.max(y, VIEWPORT_MARGIN), maxTop);

  const cx = t.left + t.width / 2;
  const cy = t.top + t.height / 2;

  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    left = clampX(cx - pw / 2);
    top = side === 'top' ? t.top - OFFSET - ph : t.bottom + OFFSET;
  } else {
    left = side === 'left' ? t.left - OFFSET - pw : t.right + OFFSET;
    top = cy - ph / 2;
  }

  /*
   * Clamp BOTH axes unconditionally, including the axis the chosen side was
   * supposed to satisfy.
   *
   * The reason is the last branch above: when no side fits, `side` is a
   * best-effort guess and its own axis is not guaranteed. Clamping only the
   * cross axis let the panel run off the top of a short viewport, where it is
   * not merely misplaced but completely invisible — a failure that looks
   * exactly like the tooltip never opening. Better a panel that overlaps its
   * trigger than one the student cannot see at all.
   */
  left = clampX(left);
  top = clampY(top);

  /*
   * The arrow tracks the TRIGGER even after the panel has been shifted, so
   * it keeps pointing at the thing being explained. Clamped away from the
   * corners, where an arrow would collide with the border radius.
   *
   * If the trigger has been shifted so far that the arrow cannot honestly
   * point at it, arrowOffset goes negative and the layer omits the arrow
   * rather than drawing one that points at nothing.
   */
  const along = side === 'top' || side === 'bottom' ? cx - left : cy - top;
  const span = side === 'top' || side === 'bottom' ? pw : ph;
  const arrowOffset =
    along < ARROW_INSET || along > span - ARROW_INSET ? -1 : Math.round(along);

  return { left: Math.round(left), top: Math.round(top), side, arrowOffset };
}

/* ------------------------------------------------------------------ *
 * TooltipLayer
 * ------------------------------------------------------------------ */

/** The live panel element, so blur can ask whether focus moved into it. */
let panelEl: HTMLDivElement | null = null;

/**
 * Renders the single open tooltip. Mount ONCE, near the root of the app.
 *
 * Portals to <body>, which is what stops a panel with `overflow` from
 * clipping it — and every rail and strip in this app scrolls internally, so
 * an absolutely positioned child would otherwise be cut in half.
 */
export function TooltipLayer() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  const setPanel = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    panelEl = el;
  }, []);

  /*
   * Measure and position after layout but before paint, so the panel is
   * never visible at the wrong coordinates for even one frame.
   */
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const panel = ref.current;
    if (!panel) return;
    setPlacement(
      place(
        open.trigger.getBoundingClientRect(),
        panel.offsetWidth,
        panel.offsetHeight,
      ),
    );
  }, [open]);

  /*
   * Global dismissals. Escape closes and restores focus. Scrolling or
   * resizing dismisses rather than chasing the trigger: cheaper, and a panel
   * that follows a scrolling readout is more distracting than one that goes
   * away. A pointerdown anywhere else closes too, which is what gives touch
   * users a way out — they have no Escape key and no pointerleave.
   */
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Claimed here so the same keystroke does not also clear the canvas
      // selection or close a dialog behind the tooltip.
      e.stopPropagation();
      e.preventDefault();
      dismissAndRestoreFocus();
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelEl?.contains(target)) return;
      if (open.trigger.contains(target)) return; // the toggle handles itself
      closeNow();
    };

    const onDismiss = () => closeNow();

    /*
     * Tabbing to a term below the fold scrolls its panel to bring it into
     * view, and that scroll lands just after focus opened the tooltip. Closing
     * on it meant the keyboard never saw an explanation for any term it had
     * to scroll to, so the scroll a focus caused is followed instead.
     */
    const onScroll = () => {
      const panel = ref.current;
      if (open.source === 'focus' && Date.now() - openedAt < FOCUS_SCROLL_MS && panel) {
        setPlacement(
          place(
            open.trigger.getBoundingClientRect(),
            panel.offsetWidth,
            panel.offsetHeight,
          ),
        );
        return;
      }
      closeNow();
    };

    // Capture phase throughout: these must win over anything that stops
    // propagation on its way up, and the canvas does exactly that.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open]);

  /* Never leave a tooltip behind if the layer itself unmounts. */
  useEffect(() => () => clearTimers(), []);

  const entry = open?.entry;
  const see = entry
    ? (entry.see ?? [])
        .map((sid) => GLOSSARY_BY_ID.get(sid))
        .filter((e): e is GlossaryEntry => e !== undefined)
    : [];

  return (
    <>
      <TermDescriptions />
      {entry && open
        ? createPortal(
            <div
              ref={setPanel}
              role="tooltip"
              className={`tip tip-${placement?.side ?? 'top'}`}
              style={{
                left: placement?.left ?? 0,
                top: placement?.top ?? 0,
                /* Laid out but not painted on the measuring pass, then
                   revealed in place. It has to be in flow at full width to
                   be measurable, so display:none is not an option. */
                visibility: placement ? 'visible' : 'hidden',
                maxWidth: PANEL_MAX_W,
                ['--tip-arrow' as string]: `${ARROW}px`,
              }}
              onPointerEnter={() => {
                pointerInPanel = true;
                clearTimers();
              }}
              onPointerLeave={() => {
                pointerInPanel = false;
                if (open.source === 'hover') scheduleClose();
              }}
            >
              {placement && placement.arrowOffset >= 0 ? (
                <span
                  className="tip-arrow"
                  aria-hidden="true"
                  style={
                    placement.side === 'top' || placement.side === 'bottom'
                      ? { left: placement.arrowOffset }
                      : { top: placement.arrowOffset }
                  }
                />
              ) : null}

              <p className="tip-term">{entry.term}</p>
              <p className="tip-short">{entry.short}</p>
              <p className="tip-why">{entry.why}</p>

              {see.length > 0 && navigateHandler ? (
                <p className="tip-see">
                  <span className="tip-see-label">See also</span>
                  {see.map((other) => (
                    <button
                      key={other.id}
                      type="button"
                      className="tip-see-link"
                      onClick={() => {
                        const go = navigateHandler;
                        closeNow();
                        go?.(other.id);
                      }}
                    >
                      {other.term}
                    </button>
                  ))}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Shared description nodes
 * ------------------------------------------------------------------ */

/**
 * One hidden description per glossary entry, rendered once for the whole
 * app. Every <Term> with that id points its aria-describedby here.
 *
 * Static content, so it is memoised to a constant element and never
 * re-renders — it costs one pass at mount and nothing thereafter, even while
 * the layer above it opens and closes at speed.
 */
const DESCRIPTIONS = (
  <div className="sr-only" aria-hidden="false">
    {[...GLOSSARY_BY_ID.values()].map((e) => (
      <span key={e.id} id={`term-desc-${e.id}`}>
        {e.term}. {e.short}. Press Enter for the full explanation.
      </span>
    ))}
  </div>
);

function TermDescriptions() {
  return DESCRIPTIONS;
}

/* ------------------------------------------------------------------ *
 * Escape hatch
 * ------------------------------------------------------------------ */

/**
 * Force any open tooltip shut. For the shell to call when it opens a dialog
 * or the glossary panel, so a tooltip is never left floating over a surface
 * that has just taken over the screen.
 */
export function closeTooltip(): void {
  closeNow();
}

/* ------------------------------------------------------------------ *
 * Test surface
 *
 * The placement maths is the part most likely to break silently — a panel
 * off the bottom of the screen looks like nothing at all rather than like a
 * bug — so it is exercised directly. Exported under a __ name to make it
 * obvious that it is not part of the component's public API.
 * ------------------------------------------------------------------ */

export const __placeForTest = place;

export const TOOLTIP_GEOMETRY = {
  VIEWPORT_MARGIN,
  OFFSET,
  ARROW,
  ARROW_INSET,
  PANEL_MAX_W,
} as const;
