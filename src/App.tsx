import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  AnimationEvent,
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  CSSProperties,
  DragEvent,
  ReactNode,
} from 'react';
import type { NodeConfig, NodeKind, SimNode, SimSnapshot, Topology } from './sim/types';
import { useCoarsePointer } from './useCoarsePointer';
import { useGithubStars, useCountUp, formatStars } from './useGithubStars';
import { Engine } from './sim/engine';
import { PRESETS, makeNode } from './sim/presets';
import { CHALLENGES, challengeById } from './sim/challenges';
import { FIXED_DURING_CHALLENGE, applyLoad, evaluate } from './sim/challenge';
import { ChallengePanel } from './components/Challenge';
import { Challenges } from './components/Challenges';
import type { Preset } from './sim/presets';
import Canvas, {
  GRID,
  NODE_H,
  NODE_W,
  SPARK_LEN,
  readoutFor,
  sourceBacklogs,
} from './components/Canvas';
import { Inspector, TrafficControl } from './components/Inspector';
import { Metrics } from './components/Metrics';
import { Palette } from './components/Palette';
import { Glossary } from './components/Glossary';
import { Shortcuts } from './components/Shortcuts';
import { Examples } from './components/Examples';
import { cloneSubgraph, isTopology, selectionSubgraph } from './clipboard';
import type { ClipboardSubgraph } from './clipboard';
import {
  NOTE_DEFAULT_WIDTH,
  NOTE_MAX_CHARS,
  SECTION_MIN_HEIGHT,
  SECTION_MIN_WIDTH,
  NOTE_MAX_SCALE,
  NOTE_MAX_WIDTH,
  NOTE_MIN_SCALE,
  NOTE_MIN_WIDTH,
  SECTION_TONE_COUNT,
  isNote,
  isSection,
  sanitizeAnnotations,
} from './sim/annotations';
import type { Annotation, AnnotationFont, Note } from './sim/annotations';
import { NEW_NOTE_TEXT } from './components/annotationLayout';
import type { AnnotationTool } from './components/Palette';
import { TooltipLayer, setGlossaryNavigate } from './components/Tooltip';
import { togglePreference, usePreference } from './content/preferences';
import { Settings } from './components/Settings';
import { MainMenu } from './components/MainMenu';
import { Designs } from './components/Designs';
import { getDesign, saveDesign } from './savedDesigns';
import { downloadBackup, restoreBackup } from './backup';
import { PanelResizer } from './components/PanelResizer';
import { applyTheme } from './theme/applyTheme';
import { usePresence } from './components/presence';
import { SessionHistory, syncEngine } from './history';
import type { HistoryEntry, HistorySnapshot } from './history';
import {
  ShareLinkTooLargeError,
  buildShareUrl,
  decodeTopology,
  hasShareHash,
} from './share';
import {
  ShareStoreError,
  fetchStored,
  hasStore,
  hasStoredLink,
  storeTopology,
} from './share/store';
import { Share, type ShareState } from './components/Share';
import { DESIGN_FILE_ACCEPT, downloadDesign, readDesignFile } from './designFile';
import { downloadBlob, svgToPng } from './imageExport';
import './App.css';

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'breakscale.session.v1';

/* ------------------------------------------------------------------ *
 * Layout persistence
 *
 * Which panels are open is kept separate from the session: clearing a
 * topology should never reset a student's layout, and vice versa.
 *
 * The inspector is deliberately NOT in here. It is selection-driven (see
 * the inspector state in App), and persisting "hidden" would mean a
 * student who dismissed it once could select nodes forever after and
 * never see their settings again, with nothing on screen to explain why.
 * ------------------------------------------------------------------ */

const LAYOUT_KEY = 'breakscale.layout.v1';

/**
 * How far a sheet must be pulled down before releasing closes it.
 *
 * 64px is roughly a thumb's comfortable travel and well past the slop of a
 * tap that happened to move. Short of it the sheet springs back, which is
 * the feedback that tells a reader the gesture exists at all.
 */
const SHEET_DISMISS_PX = 64;

/** The gap below the floating bar, before whatever clears it. Matches --sp-3. */
const BAR_GAP_PX = 12;

interface LayoutPrefs {
  /** The left component rail. */
  library: boolean;
  /** The bottom charts strip. */
  metrics: boolean;
  /**
   * Panel sizes in px, dragged from the seam between a panel and the canvas.
   *
   * Stored because a student who widened the rail to read long component
   * names meant it, and having to redo it every visit would teach them not
   * to bother. Clamped on the way in as well as on the way out: a number
   * that arrives out of range from edited storage would otherwise render a
   * rail wider than the window with no way to grab its handle.
   */
  railW: number;
  insW: number;
  stripH: number;
}

/**
 * Size limits, in px. The minimums are the point at which a panel stops
 * being able to show its own content; the maximums stop a panel from taking
 * the window and leaving no canvas to look at.
 */
export const PANEL_LIMITS = {
  railW: { min: 180, max: 420, base: 224 },
  insW: { min: 260, max: 520, base: 320 },
  stripH: { min: 140, max: 420, base: 220 },
} as const;

export type PanelKey = keyof typeof PANEL_LIMITS;

const clampPanel = (key: PanelKey, v: unknown): number => {
  const { min, max, base } = PANEL_LIMITS[key];
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(Math.round(v), min), max)
    : base;
};

/**
 * First run: the rail is open because it is the app's verbs — components
 * to add and examples to load — and a canvas with no visible way to act
 * on it is a dead end. The charts start closed: the top bar already
 * carries p99, goodput, errors and dropped, so the strip is depth to be
 * opened when a headline number needs explaining, not a fixture.
 */
/**
 * Is the shell narrow enough that panels have to be sheets?
 *
 * Matches the 720px breakpoint in App.css, and is stated here as well
 * because two things need it that CSS cannot do: panels must become
 * MUTUALLY EXCLUSIVE (two stacked sheets would bury the canvas the sheets
 * exist to explain), and the components rail must not boot open, which is a
 * default rather than a style.
 *
 * A media query rather than a device or touch test. The question is how much
 * room the shell has, and a small desktop window has exactly the same
 * problem as a phone; a tablet in landscape has neither.
 */
const PHONE_QUERY = '(max-width: 720px)';

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function isPhone(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(PHONE_QUERY).matches;
}

/** Server snapshot: no window, so never the phone layout. */
function isPhoneServer(): boolean {
  return false;
}

const DEFAULT_LAYOUT: LayoutPrefs = {
  library: true,
  metrics: false,
  railW: PANEL_LIMITS.railW.base,
  insW: PANEL_LIMITS.insW.base,
  stripH: PANEL_LIMITS.stripH.base,
};

function loadLayout(): LayoutPrefs {
  /* The components rail opens on a desktop because a blank canvas with no
     visible way to act on it is a dead end. On a phone the same default is
     the opposite of helpful: the rail is a sheet, so it opens ON TOP of the
     canvas and the first thing a reader sees is a list of components with a
     sliver of diagram behind it. They arrive from a link to LOOK at
     something, so the canvas gets the screen and the rail is a tap away. */
  const base: LayoutPrefs = isPhone()
    ? { ...DEFAULT_LAYOUT, library: false }
    : DEFAULT_LAYOUT;

  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return base;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return base;
    const p = parsed as Partial<LayoutPrefs>;
    return {
      /* A rail opened on a desktop must not reopen as a sheet on a phone:
         the same person on the same account gets a covered canvas on the
         device where it hurts most. */
      library: isPhone()
        ? false
        : typeof p.library === 'boolean'
          ? p.library
          : base.library,
      metrics: typeof p.metrics === 'boolean' ? p.metrics : base.metrics,
      railW: clampPanel('railW', p.railW),
      insW: clampPanel('insW', p.insW),
      stripH: clampPanel('stripH', p.stripH),
    };
  } catch {
    // Blocked or corrupt storage: the default layout, never a crash.
    return base;
  }
}

function saveLayout(layout: LayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Persistence is a convenience; losing it must stay invisible.
  }
}

/**
 * One shape for the three panel-toggle glyphs: a frame with the edge that
 * panel lives on marked. The icon states position, the accessible name and
 * `title` state content, so together the button says "the thing over here".
 */
function PanelGlyph({ edge }: { edge: 'left' | 'right' | 'bottom' }) {
  const d = edge === 'left' ? 'M9 4v16' : edge === 'right' ? 'M15 4v16' : 'M4 14h16';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d={d} />
    </svg>
  );
}

/**
 * Presence wrapper for one collapsible shell panel.
 *
 * THE STRUCTURAL FIX for panel motion. The shell used to render each panel
 * conditionally, so a closing panel was out of the DOM a frame before any
 * transition could run; there was literally nothing left to animate. This
 * wrapper keeps the panel mounted through its exit (usePresence), and the
 * panel slides from its own edge via TRANSFORM keyframes in App.css.
 *
 * Why transform, not an animated width or grid track: the canvas's
 * world-to-screen maths reads its viewport rect, so a layout that changes on
 * every animation frame would make an in-progress node drag drift and force
 * a re-fit per frame. The slots are absolutely positioned OVER the stage
 * (App.css), so in fact no state of this animation, and not even the slot's
 * mount or unmount, can change the canvas's rect: the diagram holds the same
 * screen pixels through any toggle, including one mid-drag, and the slide is
 * a pure transform that invalidates no layout at all.
 *
 * While closing the slot is `inert`: the leaving panel cannot take focus and
 * is invisible to a screen reader, and at animationend it unmounts outright,
 * so nothing hidden lingers in the DOM and an idle shell pays nothing.
 *
 * Children are FROZEN during the exit: the last element rendered while open
 * keeps rendering until unmount. The inspector needs this, because the
 * selection that justified its content is often already gone by the time it
 * slides out, and re-rendering it empty mid-exit would flash a blank panel.
 *
 * The entrance animation is skipped on the slot's very first appearance at
 * app boot (a panel restored from the saved layout is simply present, and
 * content that is simply present does not get an entrance), and plays on
 * every toggle after that.
 */
function PanelSlot({
  open,
  edge,
  children,
  onDismiss,
}: {
  open: boolean;
  edge: 'left' | 'right' | 'bottom';
  children: ReactNode;
  /**
   * Close this panel from inside it. Phone only: on a desktop a rail sits
   * BESIDE the canvas and dismissing it by touching the canvas would fight
   * every drag; as a sheet it sits OVER the canvas, so the canvas showing
   * through is the obvious way out and a sheet that ignores it feels stuck.
   * Omitted, the sheet has no scrim and no handle.
   */
  onDismiss?: () => void;
}) {
  const { mounted, closing, unmount } = usePresence(open);

  /**
   * Swipe-down-to-close.
   *
   * Tracked on the handle only, not the whole sheet: the panels scroll
   * internally, and a downward drag anywhere on a scrolling list means
   * scroll, not dismiss. A grabber at the top is the one place where down
   * can only mean "put this away", which is why every sheet on every phone
   * puts one there.
   *
   * The sheet follows the finger while dragging (no transition, so it tracks
   * exactly) and commits past a threshold; released short of it, it springs
   * back. Distance rather than velocity: a slow deliberate pull and a flick
   * both read as intent, and a velocity gate makes the slow one feel broken.
   */
  const dragRef = useRef<{ id: number; startY: number } | null>(null);
  const [dragY, setDragY] = useState(0);

  /* Escape closes a sheet, the way it closes every other temporary layer in
     this app. Phone only, because onDismiss is what makes it a sheet: on a
     desktop the same key would collapse a rail the reader deliberately
     opened and left open. */
  useEffect(() => {
    if (!onDismiss || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss, open]);

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!onDismiss) return;
    dragRef.current = { id: e.pointerId, startY: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a convenience; the move handler still tracks without it.
    }
  };

  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    // Down only. An upward pull is not a gesture here, and letting it lift
    // the sheet off its edge would expose the canvas underneath it.
    setDragY(Math.max(0, e.clientY - d.startY));
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    const travelled = Math.max(0, e.clientY - d.startY);
    setDragY(0);
    if (travelled > SHEET_DISMISS_PX) onDismiss?.();
  };

  const lastChildren = useRef(children);
  if (open) lastChildren.current = children;

  // "Has this slot ever been toggled": false until `open` first differs from
  // its value at mount, true forever after. A slot that has never toggled is
  // showing boot state and gets no entrance; one that has animates every
  // appearance. Render-phase adjustment, same pattern as usePresence.
  const [bootOpen] = useState(open);
  const [toggled, setToggled] = useState(false);
  if (!toggled && open !== bootOpen) setToggled(true);

  // The entrance class is REMOVED once its animation completes, symmetric
  // with the exit handler. A finished keyframe replays nothing, so leaving
  // the class cost little at runtime, but any remount (HMR, a key change)
  // would replay the slide on content that was simply present.
  const [entered, setEntered] = useState(false);
  const prevOpen = useRef(open);
  if (prevOpen.current !== open) {
    prevOpen.current = open;
    if (open) setEntered(false);
  }

  if (!mounted) return null;

  const state = closing ? ' is-closing' : toggled && !entered ? ' is-entering' : '';

  return (
    <>
      {/* The way out. Covers the canvas the sheet is sitting on, so a tap
          anywhere off the sheet closes it, and dims what is behind so the
          sheet reads as the layer in front. Hidden above the breakpoint by
          CSS, where the panels are rails and there is nothing to dismiss. */}
      {onDismiss ? (
        <div
          className={`app-scrim${closing ? ' is-closing' : ''}`}
          onPointerDown={onDismiss}
          aria-hidden="true"
        />
      ) : null}
      <div
        className={`app-slot app-slot-${edge}${state}`}
        inert={closing || undefined}
        /* Following the finger is a transform, like the slide itself, so it
           invalidates no layout and cannot move the canvas underneath. */
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
        onAnimationEnd={(e: AnimationEvent<HTMLDivElement>) => {
          // Only the slot's own animations count. Animations on children (a
          // chart transition, a button) bubble through here too.
          if (e.target !== e.currentTarget) return;
          if (closing) unmount();
          else setEntered(true);
        }}
      >
        {onDismiss ? (
          <div
            className="app-grabber"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            role="button"
            tabIndex={-1}
            aria-label="Close panel"
            onClick={onDismiss}
          >
            <span className="app-grabber-bar" />
          </div>
        ) : null}
        {open ? children : lastChildren.current}
      </div>
    </>
  );
}

/** Snapshot rate for React. The engine still advances every animation frame. */
const SNAPSHOT_HZ = 10;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;

/**
 * Largest frame delta we hand the engine. A backgrounded tab produces one
 * enormous delta on return; without this the sim would try to catch up on
 * minutes of simulated time in a single frame.
 */
const MAX_FRAME_MS = 100;

/**
 * One press of Step advances this much simulated time. The engine exposes no
 * step() of its own — only advance(dt) — so a step is simply one manual frame
 * at a size big enough to visibly move the state.
 */
const STEP_MS = 100;

/**
 * Sparkline cadence. 1Hz x 60 samples = the same 60s window the charts show.
 * The engine emits history every 250ms; sampling at 1Hz keeps the node
 * sparkline and the metrics charts describing the same span of time.
 */
const SPARK_INTERVAL_MS = 1000;

/*
 * The series each node kind's sparkline plots is `readoutFor(...).spark`:
 * the SAME per-kind primary metric the canvas headlines, taken from the same
 * function, so the trend line under a number is a trend line OF that number.
 * A local per-kind switch lived here before and had already drifted from the
 * canvas's choices for most kinds (everything defaulted to utilisation,
 * which is hardwired 0 for every gate and controller kind).
 */

interface Session {
  topology: Topology;
  rps: number;
  presetId: string | null;
}

/*
 * Structural validation of the stored session lives in clipboard.ts
 * (isTopology), because the clipboard paste path validates the exact same
 * shape and two hand-maintained copies of a 33-kind allowlist would drift.
 */

function loadSession(): Session {
  const fallback: Session = {
    topology: PRESETS[0]!.topology,
    rps: clientRps(PRESETS[0]!.topology),
    presetId: PRESETS[0]!.id,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const s = parsed as Partial<Session>;
    if (!isTopology(s.topology)) return fallback;
    const rps = Number.isFinite(s.rps) ? (s.rps as number) : clientRps(s.topology);
    // isTopology validates what the ENGINE dereferences; annotations are
    // presentation data it never sees, so they cross the trust boundary
    // through their own sanitizer. Anything malformed is dropped entry by
    // entry rather than costing the student the whole restored session.
    const annotations = sanitizeAnnotations(
      (s.topology as { annotations?: unknown }).annotations,
    );
    return {
      topology: {
        nodes: s.topology.nodes,
        edges: s.topology.edges,
        ...(annotations.length > 0 ? { annotations } : {}),
      },
      rps: Math.min(5000, Math.max(0, rps)),
      presetId: typeof s.presetId === 'string' ? s.presetId : null,
    };
  } catch {
    // Corrupt JSON, blocked storage (private mode, disabled cookies) — any
    // failure here falls back to the first preset rather than breaking boot.
    return fallback;
  }
}

function saveSession(session: Session): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota exceeded or storage unavailable. Persistence is a convenience,
    // never a correctness requirement, so this is silent by design.
  }
}

/**
 * Is this tab opening a share link?
 *
 * Read once, synchronously, before the first render. Decoding it is
 * asynchronous (inflating is stream-based), so the app boots on the stored
 * session and swaps the shared design in when it arrives; this flag is what
 * holds the session WRITE back in the meantime, so a recipient who opens
 * someone else's link and closes the tab still has their own work waiting
 * for them next time.
 */
function shareHashPresent(): boolean {
  try {
    return (
      hasShareHash(window.location.hash) ||
      hasStoredLink(window.location.search, window.location.hash)
    );
  } catch {
    // No DOM (a test importing App), or a locked-down location object.
    return false;
  }
}

/** Every traffic source on the canvas. Presets routinely have several. */
function findClients(t: Topology): SimNode[] {
  return t.nodes.filter((n) => n.kind === 'client');
}

/**
 * Total offered load: the SUM over every client node. The header used to
 * mirror a separate `rps` state cell that only the slider wrote, which came
 * apart two ways — a multi-client preset offered more than the header
 * admitted (Spotify: goodput 5.7k/s under "Offered load 5k"), and deleting
 * then re-adding a client left the header frozen on the old value while the
 * new client sent 50/s. Deriving from the topology makes the number a fact.
 */
function clientRps(t: Topology): number {
  let sum = 0;
  for (const c of findClients(t)) sum += c.config.rps;
  return sum;
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export default function App() {
  // Read storage once, before the first paint, so the app never flashes a
  // preset and then swaps to the restored session.
  const [initial] = useState(loadSession);

  /**
   * "A share link is on the URL and has not been dealt with yet."
   *
   * While this is true the session is not written to storage. The
   * recipient's own design stays exactly as they left it until they
   * actually change something on the shared one, which is the whole of the
   * read-only promise this feature makes.
   */
  const [sharePending, setSharePending] = useState(shareHashPresent);

  /** The share dialog, and whatever the link build has got to so far. */
  const [shareOpen, setShareOpen] = useState(false);
  const [shareState, setShareState] = useState<ShareState>({ status: 'idle' });

  const [topology, setTopology] = useState<Topology>(initial.topology);
  const [rps, setRps] = useState<number>(initial.rps);
  const [presetId, setPresetId] = useState<string | null>(initial.presetId);
  /**
   * Canvas selection. Node ids and edge ids share this one set; an edge id is
   * `from->to`, which can never collide with a node id, so the namespace is
   * unambiguous and a single set covers both.
   *
   * The Inspector still edits exactly one node, so `selectedNode` below
   * resolves the set down to a single node — a multi-selection simply shows
   * the empty inspector rather than an arbitrary member.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [running, setRunning] = useState(true);

  /**
   * The glossary side sheet.
   *
   * `glossaryFocusId` is the entry to land on. It is cleared when the sheet
   * closes so that reopening from the top bar starts at the top of the list
   * rather than resuming wherever the last "see also" link happened to go.
   */
  /* The theme is applied to <html>, which is outside React, so this is a
     genuine external-system synchronisation rather than derived state. */
  const themeChoice = usePreference('theme');
  useEffect(() => {
    applyTheme(themeChoice);
  }, [themeChoice]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryFocusId, setGlossaryFocusId] = useState<string | undefined>(undefined);

  /** The keyboard shortcuts dialog. Ctrl+/ and the top-bar button. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [designsOpen, setDesignsOpen] = useState(false);

  /**
   * Whether the canvas has reached storage yet.
   *
   * Work has always persisted and the app has never said so, which left a
   * student with no way to know whether closing the tab would cost them the
   * last twenty minutes. Starts 'saved', because what is on screen at boot
   * came out of storage in the first place.
   */
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved');
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const [examplesOpen, setExamplesOpen] = useState(false);
  const [challengesOpen, setChallengesOpen] = useState(false);

  /**
   * The challenge being attempted, by id, or null for the free sandbox.
   *
   * Only the id is held: the brief itself is a module constant, and storing
   * a copy would let a challenge edited in source drift from one already in
   * progress. Not persisted, because a brief resumed days later with a
   * half-finished design and no memory of the goal is worse than starting it
   * again.
   */
  const [challengeId, setChallengeId] = useState<string | null>(null);

  /* ---------------- panel layout ---------------- */

  const [layout, setLayout] = useState<LayoutPrefs>(loadLayout);

  const phone = useSyncExternalStore(subscribePhone, isPhone, isPhoneServer);
  const coarse = useCoarsePointer();
  /* The real count names the link; the tweened one is only ever drawn, so a
     screen reader is never read a number the animation happened to be
     passing through. */
  const starCount = useGithubStars();
  const stars = useCountUp(starCount);

  /**
   * Where the bar actually ends, so everything that must clear it can.
   *
   * `--bar-clear` was a constant (84px, 116px on a phone), which held while
   * the bar was one row of a known height. It stopped holding the moment the
   * bar could WRAP: at 412px it stands 223px tall and the constant put the
   * components toggle underneath it. A number that has to be re-guessed
   * every time the bar's contents change is a number that will be wrong
   * again, so it is measured instead.
   *
   * Measured, not derived from the breakpoint: the bar's height depends on
   * what wrapped, which depends on the text, the font and the width. Only
   * the element knows.
   */
  const barRef = useRef<HTMLElement | null>(null);
  const [barBottom, setBarBottom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    /* The bar's BOTTOM edge, not its height.
    
       The bar floats: it sits --sp-3 down from the top, so its height alone
       is short by that offset and the panels started flush against it with
       no gap at all. Reading the bottom of its rect includes the offset
       whatever that offset happens to be, which is the point of measuring
       rather than restating the arithmetic. */
    const measure = () => setBarBottom(Math.round(el.getBoundingClientRect().bottom));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();

    /* A phone's address bar collapsing resizes the VIEWPORT without resizing
       the header, so the ResizeObserver above never fires while everything
       measured against the window shifts underneath it. visualViewport is
       the event that reports it; `resize` covers orientation changes and any
       browser without it. */
    const vv = window.visualViewport;
    vv?.addEventListener('resize', measure);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      vv?.removeEventListener('resize', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  /* On a phone a panel is a sheet over the canvas, so opening one closes the
     other: two stacked sheets would cover the diagram they exist to explain,
     and the reader would have no way to see the effect of what they changed.
     On a desktop the two are rails on opposite edges and coexist happily. */
  const [inspectorHidden, setInspectorHidden] = useState(false);

  /* On a phone the three panels are SHEETS stacked over the canvas, so only
     one may be open: two of them cover the diagram they exist to explain,
     and the reader loses the thing they changed it to see. The inspector is
     part of this too, and was not before, which is how three could stack.
     On a desktop they are rails on three different edges and coexist. */
  const toggleLibrary = useCallback(() => {
    setLayout((l) => ({
      ...l,
      library: !l.library,
      metrics: !l.library && phone ? false : l.metrics,
    }));
    if (phone) setInspectorHidden(true);
  }, [phone]);

  const toggleMetrics = useCallback(() => {
    setLayout((l) => ({
      ...l,
      metrics: !l.metrics,
      library: !l.metrics && phone ? false : l.library,
    }));
    if (phone) setInspectorHidden(true);
  }, [phone]);

  useEffect(() => {
    saveLayout(layout);
  }, [layout]);

  /**
   * The inspector is selection-driven, the way Excalidraw's properties
   * panel is: nothing selected means nothing to configure, so the panel is
   * simply absent and the canvas has the width. `inspectorHidden` is the
   * manual override on top of that — pressing I (or the floating toggle)
   * dismisses the panel for the CURRENT selection, and the effect below
   * clears the override on the next selection gesture. That gives "get
   * this out of my way while I look" without creating a mode a student
   * has to remember: selecting something is always enough to bring the
   * settings back. Deliberately not persisted, for the same reason.
   */

  useEffect(() => {
    if (selectedIds.size > 0) setInspectorHidden(false);
  }, [selectedIds]);

  const toggleInspector = useCallback(() => setInspectorHidden((h) => !h), []);

  /**
   * The selection, split into the three things it can hold. Node ids and
   * edge ids share `selectedIds` with annotation ids; nodes and annotations
   * are identified by lookup and whatever remains is an edge. Kept in ONE
   * memo so the Inspector can never be handed a node list and an edge count
   * computed from different renders.
   */
  const { selectedNodes, selectedEdgeCount } = useMemo(() => {
    if (selectedIds.size === 0) {
      return { selectedNodes: EMPTY_NODES, selectedEdgeCount: 0, selectedAnnCount: 0 };
    }
    const nodes = topology.nodes.filter((n) => selectedIds.has(n.id));
    const anns = (topology.annotations ?? []).filter((a) => selectedIds.has(a.id));
    return {
      selectedNodes: nodes,
      // Whatever in the set is neither a node nor an annotation is an edge.
      selectedEdgeCount: selectedIds.size - nodes.length - anns.length,
      selectedAnnCount: anns.length,
    };
  }, [topology.nodes, topology.annotations, selectedIds]);

  /**
   * "Something the INSPECTOR can talk about is selected." Annotations are
   * deliberately excluded: a selected note has nothing to configure, and
   * opening an empty inspector for it would teach that selection sometimes
   * produces a blank panel.
   */
  const hasSelection = selectedNodes.length + selectedEdgeCount > 0;
  const inspectorVisible = hasSelection && !inspectorHidden;

  /**
   * The uncovered-canvas sentinel (see .stage-safe in App.css): an inert div
   * the shell keeps inset to the part of the canvas no floating panel
   * covers. The canvas measures it when aiming the camera (fit, palette
   * placement, paste, keyboard zoom), so content is always framed into the
   * visible area; it never triggers a camera move by changing.
   */
  const stageSafeRef = useRef<HTMLDivElement | null>(null);

  const openGlossary = useCallback((id?: string) => {
    setGlossaryFocusId(id);
    setGlossaryOpen(true);
  }, []);

  const closeGlossary = useCallback(() => {
    setGlossaryOpen(false);
    setGlossaryFocusId(undefined);
  }, []);

  /**
   * Where a tooltip's "see also" links go.
   *
   * Registered once with the tooltip module rather than threaded down as a
   * prop, which is what lets <Term> stay a props-free wrapper at every one of
   * its call sites. Unregistered on unmount so a stale closure can never
   * outlive this shell.
   */
  useEffect(() => {
    setGlossaryNavigate(openGlossary);
    return () => setGlossaryNavigate(null);
  }, [openGlossary]);

  /**
   * What the menu offers.
   *
   * Ordered by how often a student reaches for it: an example is how most
   * sessions start, the glossary is what they need mid-run, and the
   * shortcuts and settings are consulted rarely. Bindings are printed here
   * as well as in the shortcuts dialog, so a key can be learned from the
   * menu without opening a second thing to read about the first.
   */
  const menuItems = useMemo(
    () => [
      {
        label: 'Your designs',
        icon: 'M4 4a2 2 0 0 1 2-2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM13 2v5h5M9 13h6M9 17h6',
        onSelect: () => setDesignsOpen(true),
      },
      {
        label: 'Challenges',
        icon: 'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0z',
        onSelect: () => setChallengesOpen(true),
      },
      {
        label: 'Examples',
        icon: 'M3 4a1 1 0 0 1 1-1h6v7H3zM14 3h6a1 1 0 0 1 1 1v5h-7zM3 13h7v8H4a1 1 0 0 1-1-1zM14 13h7v7a1 1 0 0 1-1 1h-6z',
        onSelect: () => setExamplesOpen(true),
      },
      {
        label: 'Glossary',
        icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
        ...(coarse ? {} : { hint: '?' }),
        onSelect: () => openGlossary(),
      },
      /* Dropped entirely on a touch device: a list of key bindings is not
         "less useful" without a keyboard, it is inapplicable, and a menu
         that offers it is describing an app the reader does not have. The
         binding printed beside the Glossary row goes for the same reason. */
      ...(coarse
        ? []
        : [
            {
              label: 'Keyboard shortcuts',
              icon: 'M2 5.5A2.5 2.5 0 0 1 4.5 3h15A2.5 2.5 0 0 1 22 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 18.5zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M9 13h6M7 17h10',
              hint: 'Ctrl+/',
              onSelect: () => setShortcutsOpen(true),
            },
          ]),
      {
        label: 'Settings',
        icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
        onSelect: () => setSettingsOpen(true),
      },
    ],
    [openGlossary, coarse],
  );

  /**
   * The engine is a mutable simulation owned outside React's render cycle.
   * Held in state with a lazy initializer rather than a ref written during
   * render: the instance must exist for the very first render (so a snapshot
   * is available immediately), and this keeps the render phase pure. The
   * value is never replaced, so it behaves as a stable instance —
   * StrictMode's double render reuses the same engine.
   */
  const [engine] = useState(() => new Engine(initial.topology));

  /**
   * Seeded from the engine's initial state rather than set by an effect, so
   * the very first paint already shows the loaded system instead of an empty
   * canvas followed by a second render.
   */
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(() => engine.snapshot());

  /**
   * Live mirrors of the play/pause state. The rAF loop is started once and
   * reads these on each frame, so toggling pause never tears down and
   * rebuilds the loop (which would drop the accumulated frame timing).
   */
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  /* ---------------- per-node sparkline history ----------------
   *
   * `SimSnapshot.history` is system-wide — `HistoryPoint` carries no node id —
   * so there is no per-node series in the engine to draw, and src/sim is not
   * ours to change. The ring buffer therefore lives here.
   *
   * Sampled when the engine's own clock crosses a 1000ms boundary rather than
   * on a wall-clock timer, so the trace stays correct while paused, while
   * single-stepping, and after a tab-away. 60 samples at 1Hz is the same 60s
   * window the charts below the canvas show.
   */
  const sparkRef = useRef(new Map<string, Float32Array>());
  const sparkTickRef = useRef(-1);
  const [spark, setSpark] = useState<ReadonlyMap<string, Float32Array>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!snapshot) return;
    const tick = Math.floor(snapshot.system.timeMs / SPARK_INTERVAL_MS);
    if (tick === sparkTickRef.current) return;
    // A reset moves the clock backwards; drop the stale trace rather than
    // splicing new samples onto the tail of the previous run.
    const rewound = tick < sparkTickRef.current;
    sparkTickRef.current = tick;

    const prev = sparkRef.current;
    const next = new Map<string, Float32Array>();
    // Pull-based consumers headline the backlog of the buffers feeding them.
    const backlogs = sourceBacklogs(topology, snapshot.nodes);

    for (const n of topology.nodes) {
      const s = snapshot.nodes[n.id];
      const old = rewound ? undefined : prev.get(n.id);
      // NaN, not 0, marks "not yet sampled". A zero-filled buffer made a
      // young trace draw a long false flat line along the baseline and then
      // jump vertically to the first real sample, which read as a broken
      // axis rather than as data. Spark skips non-finite slots entirely.
      const buf = new Float32Array(SPARK_LEN).fill(Number.NaN);
      if (old) buf.set(old.subarray(1));
      buf[SPARK_LEN - 1] = s
        ? readoutFor(n.kind, s, n.config, backlogs.get(n.id) ?? 0).spark
        : 0;
      next.set(n.id, buf);
    }

    // Entries for removed nodes are dropped by virtue of rebuilding from the
    // current topology, so the map cannot leak across preset loads.
    sparkRef.current = next;
    setSpark(next);
  }, [snapshot, topology.nodes]);

  /* ---------------- the simulation loop ---------------- */

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sinceSnapshot = 0;
    let cancelled = false;

    const frame = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(frame);

      const dt = now - last;
      last = now;

      if (!runningRef.current) return;

      // Clamp so a long tab-away does not replay minutes of simulated time.
      engine.advance(Math.min(dt, MAX_FRAME_MS));

      // React re-renders at ~10Hz, not once per frame. The engine keeps
      // full temporal resolution regardless.
      sinceSnapshot += dt;
      if (sinceSnapshot >= SNAPSHOT_INTERVAL_MS) {
        sinceSnapshot = 0;
        setSnapshot(engine.snapshot());
      }
    };

    raf = requestAnimationFrame(frame);

    return () => {
      // StrictMode double-invokes this effect in development. `cancelled`
      // guarantees the frame scheduled by the discarded run cannot queue a
      // successor after its cleanup, so only one loop is ever live.
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [engine]);

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    // A share link is still being decoded, or has just been opened and not
    // yet edited. Writing here would overwrite the recipient's own saved
    // design with someone else's before they had touched anything.
    if (sharePending) return;
    // Debounced: dragging a node or a slider must not write on every frame.
    // Between a change and the write, the work genuinely is not saved yet,
    // and the indicator says so rather than reassuring early.
    setSaveState('saving');
    const id = window.setTimeout(() => {
      saveSession({ topology, rps, presetId });
      setSaveState('saved');
    }, 400);
    return () => window.clearTimeout(id);
  }, [topology, rps, presetId, sharePending]);

  /* ---------------- undo / redo ---------------- */

  /**
   * History of full `{ topology, selectedIds, rps, presetId }` snapshots.
   * The stacks live in SessionHistory (a plain object, unit-tested on its
   * own); this state cell exists only to re-render when they change, and
   * canUndo/canRedo below are DERIVED from the stacks on every render, never
   * cached, so the buttons can never disagree with the stack contents.
   */
  const [, setHistVersion] = useState(0);
  const [history] = useState(
    () =>
      new SessionHistory({
        onChange: () => {
          setHistVersion((v) => v + 1);
          // An entry landing is the definition of "the reader changed
          // something", so it is also the moment a design opened from a
          // share link stops being someone else's and starts being theirs.
          // Saving resumes from here; see sharePending.
          setSharePending((p) => (p ? false : p));
        },
      }),
  );
  const canUndo = history.canUndo;
  const canRedo = history.canRedo;

  /**
   * The state a history entry captures, as of the LAST COMMITTED RENDER.
   * Written in an effect, so inside an event handler this is still the
   * pre-edit state: exactly what a baseline snapshot wants.
   */
  const snapRef = useRef<HistorySnapshot>({
    topology: initial.topology,
    selectedIds: new Set<string>(),
    rps: initial.rps,
    presetId: initial.presetId,
  });
  // Layout effect, not a passive one: the mirror must be current before the
  // NEXT event handler runs (a pointerup reading the final drag position),
  // and passive effects offer no such ordering guarantee.
  useLayoutEffect(() => {
    snapRef.current = { topology, selectedIds, rps, presetId };
  }, [topology, selectedIds, rps, presetId]);

  /**
   * The topology as of the LAST EVENT HANDLER, not the last committed render.
   *
   * snapRef above is refreshed by a layout effect, which only helps if React
   * renders between two handlers. Pointer moves are continuous-priority
   * events: React schedules their re-render through the scheduler, so a fast
   * flick can deliver pointerup BEFORE the render for the final pointermove
   * has committed. endGesture would then compare the drag's baseline against
   * a pre-drag snapshot, conclude the gesture went nowhere, and drop the
   * entry — a fast node drag became invisible to undo and left a stale redo
   * stack behind. Verified with a real three-event drag in a background tab.
   *
   * Every handler that writes the topology writes this ref in the same
   * synchronous breath, so a gesture's end always sees the state its own
   * moves produced, whether or not React has caught up.
   */
  const topoLiveRef = useRef<Topology>(initial.topology);
  useLayoutEffect(() => {
    topoLiveRef.current = topology;
  }, [topology]);

  /**
   * Toast naming what was undone or redone. On a large canvas the reverted
   * change can be off screen (a preset load, a node deleted at the far
   * edge), and without the toast an off-screen undo is indistinguishable
   * from a dead keypress; a two-second label is the cheapest possible proof
   * that something happened. `id` keys the element so consecutive undos
   * restart the entrance animation instead of freezing on one message.
   */
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const toastSeq = useRef(0);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const applyEntry = useCallback(
    (entry: HistoryEntry, verb: 'Undid' | 'Redid') => {
      // The engine first, via the same non-resetting paths a forward edit
      // uses: updateNodeConfig for a config-only difference, setTopology for
      // structure. Nothing here resets the simulation or its metrics.
      syncEngine(engine, snapRef.current.topology, entry.topology);
      setTopology(entry.topology);
      setSelectedIds(new Set(entry.selectedIds));
      setRps(entry.rps);
      setPresetId(entry.presetId);
      toastSeq.current += 1;
      setToast({ text: `${verb} ${entry.label}`, id: toastSeq.current });
    },
    [engine],
  );

  const handleUndo = useCallback(() => {
    const entry = history.undo(snapRef.current);
    if (entry) applyEntry(entry, 'Undid');
  }, [history, applyEntry]);

  const handleRedo = useCallback(() => {
    const entry = history.redo(snapRef.current);
    if (entry) applyEntry(entry, 'Redid');
  }, [history, applyEntry]);

  /* ---------------- structural edits ---------------- */

  /**
   * Structural changes (add/remove nodes or edges, moves) must be pushed
   * into the engine wholesale. The engine preserves per-node state for ids
   * it already knows, so editing the graph does not disturb in-flight work.
   */
  const applyTopology = useCallback(
    (next: Topology) => {
      topoLiveRef.current = next;
      setTopology(next);
      engine.setTopology(next);
      // Refresh the snapshot immediately so a topology edit made while PAUSED
      // shows the new node's readouts at once, instead of blank rows sitting
      // next to headline numbers from the previous run until the next tick.
      setSnapshot(engine.snapshot());
      setPresetId(null);
    },
    [engine],
  );

  const handleMoveNode = useCallback(
    (id: string, x: number, y: number) => {
      // Inside a pointer drag the history baseline was captured at promotion
      // (handleMoveStart below) and will commit at gesture end, so the
      // per-frame stream stays out of history entirely. A move arriving
      // OUTSIDE a gesture is an arrow-key nudge; key-repeat makes that a
      // stream too, so it takes the debounced path and one nudge burst
      // settles into one entry.
      if (!history.inGesture) history.touch('move', snapRef.current);
      // Position is presentation only — the engine does not care, so this
      // skips setTopology and avoids clearing the active preset badge.
      // Computed eagerly from the live mirror (and written back to it) so a
      // pointerup arriving before React commits still sees this move.
      const t = topoLiveRef.current;
      const next = {
        ...t,
        nodes: t.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      };
      topoLiveRef.current = next;
      setTopology(next);
    },
    [history],
  );

  /** One drag is ONE history entry: baseline at promotion, commit at end.
   *  The canvas names the gesture ('move', 'resize') so the undo toast can
   *  say what it undid; unnamed callers stay a 'move'. */
  const handleMoveStart = useCallback(
    (label?: string) => {
      history.beginGesture(label ?? 'move', snapRef.current);
    },
    [history],
  );

  const handleMoveEnd = useCallback(() => {
    // The topology from the live mirror, never from snapRef alone: a flick's
    // pointerup can outrun the render for its last pointermove, and endGesture
    // fed the stale mirror would drop the entry as a no-op (see topoLiveRef).
    history.endGesture({ ...snapRef.current, topology: topoLiveRef.current });
  }, [history]);

  /* ---------------- annotations: notes and sections ----------------
   *
   * PRESENTATION ONLY. Every writer here goes through setAnnotations, which
   * updates React state and the live mirror and NOTHING else: the engine is
   * never told (it has no field to be told in), the snapshot is not
   * refreshed, and the active preset badge survives, exactly as it does for
   * a node move. History granularity matches nodes 1:1 — one drag or resize
   * is one entry at the gesture boundary, a creation or text edit is one
   * discrete commit.
   */

  const setAnnotations = useCallback((next: Annotation[]) => {
    const t = topoLiveRef.current;
    const nt: Topology = { ...t, annotations: next };
    topoLiveRef.current = nt;
    setTopology(nt);
  }, []);

  /** `kind-N` ids of the same shape freshId in clipboard.ts mints, scanned
   *  against the live list because a restored session's ids predate this
   *  tab's counters. */
  const freshAnnId = useCallback((prefix: 'note' | 'section'): string => {
    const used = new Set((topoLiveRef.current.annotations ?? []).map((a) => a.id));
    let n = 1;
    while (used.has(`${prefix}-${n}`)) n += 1;
    return `${prefix}-${n}`;
  }, []);

  const handleMoveAnnotation = useCallback(
    (id: string, x: number, y: number) => {
      // Same shape as handleMoveNode: inside a pointer drag the baseline
      // was captured at promotion; a move arriving outside a gesture is a
      // future streamed path and takes the debounced entry.
      if (!history.inGesture) history.touch('move', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) =>
          a.id === id ? { ...a, x, y } : a,
        ),
      );
    },
    [history, setAnnotations],
  );

  const handleResizeNote = useCallback(
    (id: string, x: number, width: number) => {
      if (!history.inGesture) history.touch('resize', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) => {
          if (a.id !== id || !isNote(a)) return a;
          const next: Note = {
            ...a,
            x,
            // Clamped here as well as in the canvas, because this is the
            // boundary the model is written through: a width that only
            // the gesture bounded could still arrive out of range from a
            // future caller.
            width: Math.min(Math.max(width, NOTE_MIN_WIDTH), NOTE_MAX_WIDTH),
          };
          // Dragging a side is what pins a note's width: from here on it
          // wraps there, as Eraser's text does once resized. Deleted rather
          // than set false, so the field stays absent from share links and
          // history compares it as absent.
          delete next.autoResize;
          return next;
        }),
      );
    },
    [history, setAnnotations],
  );

  const handleScaleNote = useCallback(
    (id: string, x: number, width: number, scale: number) => {
      if (!history.inGesture) history.touch('resize', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) => {
          if (a.id !== id || !isNote(a)) return a;
          const next: Note = {
            ...a,
            x,
            width: Math.min(Math.max(width, NOTE_MIN_WIDTH), NOTE_MAX_WIDTH),
            scale: Math.min(Math.max(scale, NOTE_MIN_SCALE), NOTE_MAX_SCALE),
          };
          // Back at 1 is the absence of a scale, not a scale of one: storing
          // it would put a redundant field in every share link.
          if (next.scale === 1) delete next.scale;
          return next;
        }),
      );
    },
    [history, setAnnotations],
  );

  const handleResizeSection = useCallback(
    (id: string, x: number, y: number, w: number, h: number) => {
      if (!history.inGesture) history.touch('resize', snapRef.current);
      setAnnotations(
        (topoLiveRef.current.annotations ?? []).map((a) =>
          a.id === id && isSection(a)
            ? {
                ...a,
                x,
                y,
                width: Math.max(w, SECTION_MIN_WIDTH),
                height: Math.max(h, SECTION_MIN_HEIGHT),
              }
            : a,
        ),
      );
    },
    [history, setAnnotations],
  );

  const handleCreateNote = useCallback(
    (x: number, y: number): string => {
      const anns = topoLiveRef.current.annotations ?? [];
      const id = freshAnnId('note');
      history.commit('add note', snapRef.current);
      setAnnotations([
        ...anns,
        {
          id,
          kind: 'note',
          text: NEW_NOTE_TEXT,
          x,
          y,
          width: NOTE_DEFAULT_WIDTH,
          size: 'md',
          // Born hugging its text; a side drag pins the width.
          autoResize: true,
        },
      ]);
      setSelectedIds(new Set([id]));
      return id;
    },
    [freshAnnId, history, setAnnotations],
  );

  const handleCreateSection = useCallback(
    (x: number, y: number, w: number, h: number) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const id = freshAnnId('section');
      history.commit('add section', snapRef.current);
      setAnnotations([
        ...anns,
        {
          id,
          kind: 'section',
          label: 'Section',
          x,
          y,
          width: Math.max(w, SECTION_MIN_WIDTH),
          height: Math.max(h, SECTION_MIN_HEIGHT),
          // Rotate through the palette so adjacent frames differ by default.
          tone: anns.filter(isSection).length % SECTION_TONE_COUNT,
        },
      ]);
      setSelectedIds(new Set([id]));
    },
    [freshAnnId, history, setAnnotations],
  );

  const handleEditNote = useCallback(
    (id: string, text: string) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'note') return;
      const next = text.slice(0, NOTE_MAX_CHARS);
      if (!next.trim()) {
        // An emptied note is removed outright: invisible and unselectable,
        // it would otherwise be litter the reader cannot find to delete.
        history.commit('delete', snapRef.current);
        setAnnotations(anns.filter((a) => a.id !== id));
        setSelectedIds((sel) => {
          if (!sel.has(id)) return sel;
          const out = new Set(sel);
          out.delete(id);
          return out;
        });
        return;
      }
      if (next === cur.text) return;
      history.commit('note edit', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, text: next } : a)));
    },
    [history, setAnnotations],
  );

  const handleEditSectionLabel = useCallback(
    (id: string, label: string) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'section') return;
      const next = label.slice(0, 200);
      if (next === cur.label) return;
      history.commit('label edit', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, label: next } : a)));
    },
    [history, setAnnotations],
  );

  const handleSetNoteSize = useCallback(
    (id: string, size: Note['size']) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'note' || cur.size === size) return;
      history.commit('note size', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, size } : a)));
    },
    [history, setAnnotations],
  );

  const handleSetNoteStyle = useCallback(
    (
      id: string,
      change: {
        font?: AnnotationFont;
        tone?: number | null;
        bold?: 'toggle';
        italic?: 'toggle';
        underline?: 'toggle';
      },
    ) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'note') return;

      const next: Note = { ...cur };
      if (change.font) next.font = change.font;
      // Absent rather than false when off, so a note that was never styled
      // stores nothing and a share link stays as short as it can be.
      for (const flag of ['bold', 'italic', 'underline'] as const) {
        if (change[flag] !== 'toggle') continue;
        if (cur[flag]) delete next[flag];
        else next[flag] = true;
      }
      if (change.tone !== undefined) {
        if (change.tone === null) delete next.tone;
        else
          next.tone =
            ((Math.floor(change.tone) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) %
            SECTION_TONE_COUNT;
      }
      history.commit('note style', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? next : a)));
    },
    [history, setAnnotations],
  );

  const handleSetSectionTone = useCallback(
    (id: string, tone: number) => {
      const anns = topoLiveRef.current.annotations ?? [];
      const cur = anns.find((a) => a.id === id);
      if (!cur || cur.kind !== 'section' || cur.tone === tone) return;
      // Wrapped rather than clamped, matching sanitizeAnnotations, so a shade
      // index can never land outside the palette and render an unstyled frame.
      const next =
        ((Math.floor(tone) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) %
        SECTION_TONE_COUNT;
      history.commit('section shade', snapRef.current);
      setAnnotations(anns.map((a) => (a.id === id ? { ...a, tone: next } : a)));
    },
    [history, setAnnotations],
  );

  /** Palette click (no drop point): place at the centre of the current
   *  view, the same aim handlePaletteAdd uses for components. */
  const handlePaletteAnnotation = useCallback(
    (tool: AnnotationTool) => {
      // Arm the tool; do not place a shape. A section dropped at the view
      // centre lands on whatever is already there, and a node that ends up
      // inside its bounds is silently carried along the next time the frame
      // is dragged. Arming lets the student draw the frame around what they
      // meant, which is the only way the canvas can know what they meant.
      if (armToolRef.current) {
        armToolRef.current(tool);
        return;
      }
      // No canvas mounted to arm (the rail can outlive it during a layout
      // change). Falling back to placing one is better than the click doing
      // nothing at all.
      const centre = viewCenterRef.current?.() ?? { x: 240, y: 200 };
      const gx = (v: number) => Math.round(v / GRID) * GRID;
      if (tool === 'note') {
        handleCreateNote(gx(centre.x - NOTE_DEFAULT_WIDTH / 2), gx(centre.y));
      } else {
        handleCreateSection(gx(centre.x - 160), gx(centre.y - 112), 320, 224);
      }
    },
    [handleCreateNote, handleCreateSection],
  );

  const handleAddNode = useCallback(
    (kind: NodeKind, x: number, y: number) => {
      // Read the live mirror, not the React binding: two adds in quick
      // succession both run against the closure's pre-add snapshot, so the
      // second would build on a topology missing the first node and drop
      // it (see topoLiveRef, and #47 which found the stale closure first).
      // The mirror also supplies the ids already on the canvas, so a fresh
      // page load cannot mint an id a restored design is using (makeNode).
      const t = topoLiveRef.current;
      const node = makeNode(kind, x, y, undefined, new Set(t.nodes.map((n) => n.id)));
      history.commit('add', snapRef.current);
      applyTopology({
        ...t,
        nodes: [...t.nodes, node],
      });
      setSelectedIds(new Set([node.id]));
    },
    [applyTopology, history],
  );

  /**
   * Filled by the canvas with a "world point at the centre of the current
   * view" getter. A palette CLICK has no drop point of its own; the old
   * placement (max x + 220) marched monotonically rightward, so after a few
   * clicks each new node — entrance animation and all — landed entirely
   * outside the viewport and the click looked like a no-op. Measured: two
   * palette clicks on the company preset created nodes at screen y ≈ -257.
   */
  const viewCenterRef = useRef<(() => { x: number; y: number }) | null>(null);
  const armToolRef = useRef<((tool: AnnotationTool) => void) | null>(null);
  const exportSvgRef = useRef<(() => string | null) | null>(null);
  const [armedTool, setArmedTool] = useState<AnnotationTool | null>(null);

  /**
   * Node id to display name, for the request trace.
   *
   * Keyed off the node list rather than the snapshot, because the strip
   * re-renders ten times a second and these names change only when someone
   * renames or deletes a component.
   */
  const nodeNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const n of topology.nodes) out[n.id] = n.label;
    return out;
  }, [topology.nodes]);

  /** Palette click (no drop point): place at the centre of the current view. */
  const handlePaletteAdd = useCallback(
    (kind: NodeKind) => {
      const centre = viewCenterRef.current?.();
      if (!centre) {
        // No canvas yet (should not happen in practice): old fallback.
        const maxX = topology.nodes.reduce((m, n) => Math.max(m, n.x), 0);
        handleAddNode(kind, maxX + 220, 200);
        return;
      }
      // Centre the node on the view, snapped to the grid. A small ring of
      // nearby offsets dodges an exact pile-up from repeated clicks, but the
      // search never leaves the neighbourhood: on a dense diagram the node
      // simply lands at the centre and overlaps, which the student can see
      // and fix — a node placed "helpfully" outside the viewport cannot be.
      const cx = Math.round((centre.x - NODE_W / 2) / GRID) * GRID;
      const cy = Math.round((centre.y - NODE_H / 2) / GRID) * GRID;
      const occupied = (px: number, py: number) =>
        topology.nodes.some(
          (n) => Math.abs(n.x - px) < NODE_W && Math.abs(n.y - py) < NODE_H,
        );
      const STEP = GRID * 4;
      const ring: [number, number][] = [
        [0, 0],
        [STEP, STEP],
        [-STEP, STEP],
        [STEP, -STEP],
        [-STEP, -STEP],
        [2 * STEP, 0],
        [0, 2 * STEP],
        [-2 * STEP, 0],
        [0, -2 * STEP],
      ];
      const spot = ring.find(([dx, dy]) => !occupied(cx + dx, cy + dy)) ?? [0, 0];
      handleAddNode(kind, cx + spot[0], cy + spot[1]);
    },
    [handleAddNode, topology.nodes],
  );

  const handleConnect = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const id = `${fromId}->${toId}`;
      if (topology.edges.some((e) => e.id === id)) return;
      history.commit('connection', snapRef.current);
      applyTopology({
        ...topology,
        edges: [...topology.edges, { id, from: fromId, to: toId, weight: 1 }],
      });
    },
    [applyTopology, topology, history],
  );

  /**
   * Delete a whole selection in ONE topology edit.
   *
   * Deleting N items with N sequential single-item calls is a bug waiting to
   * happen: each call closes over the topology as it was at render time, so
   * the second delete would resurrect what the first removed. Partitioning
   * up front and filtering once is both correct and cheaper.
   */
  const handleDeleteSelection = useCallback(
    (
      nodeIds: readonly string[],
      edgeIds: readonly string[],
      annotationIds: readonly string[] = [],
    ) => {
      if (nodeIds.length === 0 && edgeIds.length === 0 && annotationIds.length === 0) {
        return;
      }
      const dropNodes = new Set(nodeIds);
      const dropEdges = new Set(edgeIds);
      const dropAnns = new Set(annotationIds);
      // ONE entry for the whole selection, orphaned edges included: the
      // filter below is a single topology edit, so its baseline is too.
      history.commit('delete', snapRef.current);

      // An annotation-only delete stays a presentation edit: the engine is
      // not disturbed and the preset badge survives, matching every other
      // annotation path. Anything structural goes through applyTopology.
      if (nodeIds.length === 0 && edgeIds.length === 0) {
        setAnnotations((topology.annotations ?? []).filter((a) => !dropAnns.has(a.id)));
      } else {
        applyTopology({
          ...topology,
          nodes: topology.nodes.filter((n) => !dropNodes.has(n.id)),
          edges: topology.edges.filter(
            (e) =>
              // Explicitly deleted, or orphaned by a node that just went away.
              !dropEdges.has(e.id) && !dropNodes.has(e.from) && !dropNodes.has(e.to),
          ),
          ...(topology.annotations
            ? {
                annotations: topology.annotations.filter((a) => !dropAnns.has(a.id)),
              }
            : {}),
        });
      }
      setSelectedIds((cur) => {
        if (cur.size === 0) return cur;
        const next = new Set(cur);
        for (const id of dropNodes) next.delete(id);
        for (const id of dropEdges) next.delete(id);
        for (const id of dropAnns) next.delete(id);
        return next;
      });
    },
    [applyTopology, setAnnotations, topology, history],
  );

  /** The Inspector's single-node delete routes through the same path. */
  const handleDeleteNode = useCallback(
    (id: string) => handleDeleteSelection([id], []),
    [handleDeleteSelection],
  );

  /**
   * Delete every node in a multi-selection. Routes through the same single
   * topology edit as everything else, so orphaned edges go with it.
   */
  const handleDeleteMany = useCallback(
    (ids: readonly string[]) => handleDeleteSelection(ids, []),
    [handleDeleteSelection],
  );

  /* ---------------- duplicate & paste ---------------- */

  /**
   * Append a cloned subgraph in ONE topology edit and make the clones the
   * new selection (nodes and internal edges both), which is what lets a
   * repeated Ctrl+D walk copies across the canvas. Shared by Ctrl+D,
   * alt-drag and paste so the three cannot disagree about what a copy is.
   */
  const appendClones = useCallback(
    (clones: ClipboardSubgraph) => {
      applyTopology({
        ...topology,
        nodes: [...topology.nodes, ...clones.nodes],
        edges: [...topology.edges, ...clones.edges],
      });
      const next = new Set<string>();
      for (const n of clones.nodes) next.add(n.id);
      for (const e of clones.edges) next.add(e.id);
      setSelectedIds(next);
    },
    [applyTopology, topology],
  );

  /**
   * Ctrl+D: duplicate the selection two grid steps down-right. The offset is
   * small enough that the copy reads as "yours, here" and large enough that
   * it never lands exactly on its source and looks like nothing happened.
   */
  const handleDuplicate = useCallback(() => {
    const sub = selectionSubgraph(topology, selectedIds);
    if (!sub) return;
    // ONE entry for the whole duplicate, selection included.
    history.commit('duplicate', snapRef.current);
    appendClones(cloneSubgraph(sub, topology, GRID * 2, GRID * 2));
  }, [topology, selectedIds, history, appendClones]);

  /**
   * Alt+drag: the same duplication as Ctrl+D, but born under the pointer as
   * a drag. Called by the canvas once at drag promotion; clones are placed
   * exactly on their sources (offset 0) because the drag itself supplies the
   * displacement, and the return value tells the canvas which clones the
   * gesture now carries. History: this opens a gesture the canvas's
   * onMoveEnd closes, so the entire duplicate-and-drag is one undo step
   * whose baseline predates the clones.
   */
  const handleDuplicateForDrag = useCallback(
    (primaryId: string) => {
      if (!topology.nodes.some((n) => n.id === primaryId)) return null;
      // Same scope rule as a plain drag: grabbing a member of a
      // multi-selection copies the whole selection, anything else copies
      // just the grabbed node.
      const scope: ReadonlySet<string> =
        selectedIds.has(primaryId) && selectedIds.size > 1
          ? selectedIds
          : new Set([primaryId]);
      const sub = selectionSubgraph(topology, scope);
      if (!sub) return null;
      const clones = cloneSubgraph(sub, topology, 0, 0);
      // cloneSubgraph preserves order, so source i maps to clone i.
      let primary: string | null = null;
      const group: { id: string; x: number; y: number }[] = [];
      for (let i = 0; i < sub.nodes.length; i++) {
        const clone = clones.nodes[i]!;
        if (sub.nodes[i]!.id === primaryId) primary = clone.id;
        else group.push({ id: clone.id, x: clone.x, y: clone.y });
      }
      if (!primary) return null;
      history.beginGesture('duplicate', snapRef.current);
      appendClones(clones);
      return { id: primary, group };
    },
    [topology, selectedIds, history, appendClones],
  );

  /**
   * Ctrl+V: a validated subgraph off the system clipboard, aimed at the
   * pointer. The payload's ids are whatever the copy carried (possibly from
   * another tab) and are never trusted: cloneSubgraph mints fresh ones
   * against the live topology. The bounding-box centre lands on the pointer,
   * moved by a grid-snapped delta so the subgraph's internal offsets survive
   * exactly and grid-aligned content stays aligned.
   */
  const handlePaste = useCallback(
    (sub: ClipboardSubgraph, at: { x: number; y: number }) => {
      if (sub.nodes.length === 0) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of sub.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
        if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
      }
      const dx = Math.round((at.x - (minX + maxX) / 2) / GRID) * GRID;
      const dy = Math.round((at.y - (minY + maxY) / 2) / GRID) * GRID;
      history.commit('paste', snapRef.current);
      appendClones(cloneSubgraph(sub, topology, dx, dy));
    },
    [topology, history, appendClones],
  );

  /* ---------------- live config edits ---------------- */

  /**
   * Knob changes are applied to the running engine in place. No reset: the
   * whole point is watching the system respond to a change under load.
   */
  const handleConfigChange = useCallback(
    (id: string, patch: Partial<NodeConfig>) => {
      // A slider fires this every frame, so the history side is debounced:
      // the first frame captures the pre-edit baseline, and the entry lands
      // once the value settles. One knob gesture, one undo step.
      history.touch('setting change', snapRef.current);
      engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // No slider sync needed: the header's offered load is DERIVED from the
      // topology's client nodes, so a per-node rps knob updates it for free.
    },
    [engine, history],
  );

  /**
   * Apply ONE patch to MANY nodes. Deliberately not a loop over
   * handleConfigChange: each call would close over the topology as it was at
   * render time, so the second write would resurrect the first node's old
   * config. The engine is told node-by-node (its API is per-node and applies
   * in place, so that part is safe to iterate), but React state is rebuilt in
   * a single pass over one `Set`.
   */
  const handleConfigChangeMany = useCallback(
    (ids: readonly string[], patch: Partial<NodeConfig>) => {
      if (ids.length === 0) return;
      history.touch('setting change', snapRef.current);
      const targets = new Set(ids);
      for (const id of targets) engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          targets.has(n.id) ? { ...n, config: { ...n.config, ...patch } } : n,
        ),
      }));
      // No slider sync needed: the header derives offered load from the
      // topology, so editing any client's rps here updates it for free.
    },
    [engine, history],
  );

  const handleRename = useCallback(
    (id: string, label: string) => {
      // Fired per keystroke; debounced the same way a slider is, so one
      // typed name settles into one entry.
      history.touch('rename', snapRef.current);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) => (n.id === id ? { ...n, label } : n)),
      }));
    },
    [history],
  );

  /**
   * The top-bar slider sets the TOTAL offered load. One client gets the value
   * outright; several are scaled proportionally so a preset's deliberate
   * traffic mix survives the drag, with the remainder placed on the first
   * client so the distributed parts always sum to exactly `next`.
   */
  const handleRpsChange = useCallback(
    (next: number) => {
      setRps(next);
      const clients = findClients(topology);
      if (clients.length === 0) return;
      if (clients.length === 1) {
        handleConfigChange(clients[0]!.id, { rps: next });
        return;
      }
      const total = clients.reduce((s, c) => s + c.config.rps, 0);
      const shares = clients.map((c) =>
        Math.max(
          0,
          Math.round(next * (total > 0 ? c.config.rps / total : 1 / clients.length)),
        ),
      );
      const spread = shares.reduce((s, v) => s + v, 0);
      shares[0] = Math.max(0, shares[0]! + (next - spread));
      // One history baseline, one engine pass, one topology write.
      history.touch('setting change', snapRef.current);
      const byId = new Map(clients.map((c, i) => [c.id, shares[i]!]));
      for (const [id, rps] of byId) engine.updateNodeConfig(id, { rps });
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) =>
          byId.has(n.id) ? { ...n, config: { ...n.config, rps: byId.get(n.id)! } } : n,
        ),
      }));
    },
    [handleConfigChange, topology, history, engine],
  );

  /* ---------------- presets & reset ---------------- */

  /**
   * State backing the lost-per-second derivation further down (see the
   * cumulativeLost memo). Declared here because reset and preset load must
   * zero it SYNCHRONOUSLY: leaving it to the effect meant the old run's
   * "Dropped 104k/s" sat on screen next to p99 0ms until the next effect
   * pass — indefinitely, while paused.
   */
  const lostPrevRef = useRef<number | null>(null);
  const lostPrevTimeRef = useRef(0);
  const [lostRps, setLostRps] = useState(0);

  const resetLostRate = useCallback(() => {
    lostPrevRef.current = null;
    lostPrevTimeRef.current = 0;
    setLostRps(0);
  }, []);

  /**
   * Bumped when the diagram is replaced wholesale, so the canvas re-frames
   * the new content. Node edits never bump it: the camera belongs to the
   * student, and add/delete/undo must not move it.
   */
  const [fitNonce, setFitNonce] = useState(0);

  /**
   * Replace the whole design, as one history entry.
   *
   * Loading an example and opening a file are the same act from the
   * student's side: the diagram they were looking at is gone and another
   * one is in its place. They share this so they can never drift into
   * disagreeing about what "replace" means, and in particular so an
   * imported design is undoable on exactly the terms an example load is.
   * The caller owns the copy it passes; this takes it as given.
   */
  const replaceDesign = useCallback(
    (fresh: Topology, nextPresetId: string | null, label: string) => {
      // ONE entry, captured before the load, so a student who replaces a
      // half-built system can undo back to what they had.
      history.commit(label, snapRef.current);
      setTopology(fresh);
      setRps(clientRps(fresh));
      setPresetId(nextPresetId);
      setSelectedIds(new Set<string>());
      topoLiveRef.current = fresh;
      engine.setTopology(fresh);
      engine.reset();
      resetLostRate();
      setSnapshot(engine.snapshot());
      setFitNonce((n) => n + 1);
    },
    [engine, history, resetLostRate],
  );

  /**
   * Open a saved design.
   *
   * Through replaceDesign, so it lands with the same single history entry a
   * preset load or a file import does: a student who opens the wrong one can
   * undo straight back to what they had.
   */
  const handleOpenSaved = useCallback(
    (id: string) => {
      const saved = getDesign(id);
      if (!saved) {
        toastSeq.current += 1;
        setToast({ text: 'That design is no longer saved.', id: toastSeq.current });
        return;
      }
      replaceDesign(structuredClone(saved.topology), null, 'open design');
      toastSeq.current += 1;
      setToast({ text: `Opened ${saved.name}`, id: toastSeq.current });
    },
    [replaceDesign],
  );

  const handleBackup = useCallback(() => {
    downloadBackup();
    toastSeq.current += 1;
    setToast({ text: 'Downloaded everything', id: toastSeq.current });
  }, []);

  /**
   * Restore replaces what this browser holds, so it asks first.
   *
   * A confirm() rather than a bespoke dialog: this is destructive and rare,
   * the browser's own prompt is the one a reader already trusts for exactly
   * this, and a custom modal here would be new furniture for a question
   * asked once.
   */
  const handleRestorePick = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so choosing the SAME file twice fires again.
    e.target.value = '';
    if (!file) return;

    let text: string;
    try {
      text = await file.text();
    } catch {
      toastSeq.current += 1;
      setToast({ text: 'That file could not be read.', id: toastSeq.current });
      return;
    }

    if (
      !window.confirm(
        'Restoring replaces every saved design and setting in this browser with the ones in the file. Continue?',
      )
    ) {
      return;
    }

    const result = restoreBackup(text);
    toastSeq.current += 1;
    if (!result.ok) {
      setToast({ text: result.error, id: toastSeq.current });
      return;
    }
    // Reloaded rather than patched into the running app: preferences, the
    // layout and the session are all read once at boot, so the only
    // honest way to apply a wholesale replacement is to start again.
    setToast({ text: 'Restored. Reloading...', id: toastSeq.current });
    window.setTimeout(() => window.location.reload(), 400);
  }, []);

  const handleSaveNamed = useCallback((name: string) => {
    const result = saveDesign(name, topoLiveRef.current);
    toastSeq.current += 1;
    if (!result.ok) {
      setToast({ text: result.error, id: toastSeq.current });
      return;
    }
    // The eviction is said out loud. A shelf that silently drops the
    // oldest thing on it is a shelf that loses work.
    setToast({
      text: result.evicted
        ? `Saved ${name}. Removed the oldest, ${result.evicted}.`
        : `Saved ${name}`,
      id: toastSeq.current,
    });
  }, []);

  const handleLoadPreset = useCallback(
    (preset: Preset) => {
      // Deep copy: presets are module-level constants and must never be
      // mutated by editing the loaded system.
      replaceDesign(structuredClone(preset.topology), preset.id, 'example load');
      // Loading an example by hand leaves any brief behind: the design the
      // brief was judging is gone, so continuing to score it would be
      // scoring something else.
      setChallengeId(null);
    },
    [replaceDesign],
  );

  /**
   * Start a brief: load its preset and set the load it is judged at.
   *
   * The load is applied to the topology rather than held beside it, so the
   * slider shows the number the brief actually states and a reader can move
   * it. Turning the traffic down until the goals are met is not a way to
   * cheat, because the goals are only ever read at the stated load.
   */
  const handleStartChallenge = useCallback(
    (id: string) => {
      const challenge = challengeById(id);
      if (!challenge) return;
      const preset = PRESETS.find((p) => p.id === challenge.presetId);
      if (!preset) return;

      /*
       * A brief replaces whatever is on the canvas, so it asks first when
       * that is something the reader made.
       *
       * Undo already recovers it, which is the real safety net, but nobody
       * who has just watched their diagram vanish thinks to press Ctrl+Z.
       * The question is only worth asking when there is something to lose:
       * an unmodified example or an empty canvas is not work, and a prompt
       * on every start would train people to dismiss it before reading.
       *
       * A confirm() for the same reason the restore path uses one. It is
       * destructive, it is rare, and a custom modal would be new furniture
       * for a question asked once.
       */
      const madeSomething = presetId === null && topology.nodes.length > 0;
      if (
        madeSomething &&
        !window.confirm(
          'Starting a challenge replaces what is on the canvas. Your design is not saved anywhere else. Continue?',
        )
      ) {
        return;
      }

      const topo = structuredClone(preset.topology);
      applyLoad(topo, challenge.loadRps);
      replaceDesign(topo, preset.id, 'challenge start');
      setChallengeId(id);
    },
    [replaceDesign, presetId, topology.nodes.length],
  );

  /* The live verdict. Recomputed per snapshot rather than on a timer, so the
     panel and the numbers it quotes always come from the same tick. */
  const challenge = challengeId ? challengeById(challengeId) : undefined;
  const challengeResult = useMemo(
    () => (challenge && snapshot ? evaluate(challenge, snapshot) : null),
    [challenge, snapshot],
  );

  /* ---------------- design files ----------------
   *
   * A share link moves a design between two browsers; a file moves it
   * between two people, and it is the only copy that outlives the browser
   * profile it was drawn in. Both directions live in designFile.ts; what
   * is here is the wiring, plus the one rule that matters on the way in:
   * a file that does not hold up says so and CHANGES NOTHING. A student
   * who opens the wrong file must still be looking at their own work.
   */

  const [importError, setImportError] = useState<string | null>(null);
  useEffect(() => {
    if (!importError) return;
    const t = window.setTimeout(() => setImportError(null), 5000);
    return () => window.clearTimeout(t);
  }, [importError]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Save the diagram as a picture.
   *
   * SVG is the honest default for a diagram (it stays sharp and its text is
   * still text), so PNG is offered beside it rather than instead of it: a
   * slide deck and a chat window both want a raster.
   */
  const handleExportImage = useCallback(
    async (format: 'svg' | 'png') => {
      const svg = exportSvgRef.current?.();
      if (!svg) {
        toastSeq.current += 1;
        setToast({
          text: 'There is nothing on the canvas to export yet.',
          id: toastSeq.current,
        });
        return;
      }
      const stem = presetId
        ? (PRESETS.find((p) => p.id === presetId)?.name ?? 'design')
        : 'design';
      const name = stem
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      try {
        if (format === 'svg') {
          downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
          return;
        }
        const m = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg);
        const w = m ? Number(m[1]) : 1200;
        const h = m ? Number(m[2]) : 800;
        downloadBlob(await svgToPng(svg, w, h), `${name}.png`);
      } catch {
        // A failed export must say so. Silence here reads as a broken button.
        toastSeq.current += 1;
        setToast({ text: 'That picture could not be saved.', id: toastSeq.current });
      }
    },
    [presetId],
  );

  const handleExport = useCallback(() => {
    const preset = PRESETS.find((p) => p.id === presetId);
    downloadDesign(topology, preset?.name ?? null);
  }, [topology, presetId]);

  const importDesign = useCallback(
    async (file: File) => {
      const result = await readDesignFile(file);
      if (!result.ok) {
        setImportError(result.error);
        return;
      }
      // The imported design is no longer any example, so the preset id is
      // cleared: leaving it set would have the Examples gallery claim a
      // file the student opened is the example it was edited from.
      replaceDesign(result.topology, null, 'file import');
      setImportError(null);
      toastSeq.current += 1;
      setToast({
        text: result.name ? `Opened ${result.name}` : 'Opened design',
        id: toastSeq.current,
      });
    },
    [replaceDesign],
  );

  const handleImportPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Cleared so choosing the same file twice in a row fires again; a
      // picker that silently does nothing the second time reads as broken.
      e.target.value = '';
      if (file) void importDesign(file);
    },
    [importDesign],
  );

  /**
   * A design dropped onto the canvas.
   *
   * On the wrapper rather than inside the canvas: the gesture router owns
   * `.cv-surface` and a file drop is not one of its gestures. The
   * dragover handler exists only to call preventDefault, without which
   * the browser navigates away from the app to render the JSON, losing
   * whatever was on the canvas.
   */
  const handleFileDragOver = useCallback((e: DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleFileDrop = useCallback(
    (e: DragEvent) => {
      const file = e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      void importDesign(file);
    },
    [importDesign],
  );

  /* ---------------- share links ---------------- */

  /**
   * Open the design carried on the URL, INSTEAD of the stored session.
   *
   * Runs once. The decode is asynchronous, so the app has already painted
   * the stored session by the time this lands; swapping here rather than
   * blocking the first paint means a link with a mangled payload shows a
   * working app with a sentence explaining itself, never a blank screen.
   * The hash is left on the URL so the recipient can copy the link on to
   * someone else, and `sharePending` stays true until they edit something,
   * which is what keeps their own saved design intact.
   *
   * Anything that fails validation falls through to the ordinary startup
   * path with the toast saying so.
   */
  useEffect(() => {
    if (!sharePending) return;
    let cancelled = false;
    // A stored link keeps its id in the query and its key in the fragment,
    // so it is recognised by the pair rather than by a prefix. Everything
    // after the decode is identical: both routes end in the same validated
    // topology and the same toast.
    const opening = hasStoredLink(window.location.search, window.location.hash)
      ? fetchStored(window.location.search, window.location.hash)
      : decodeTopology(window.location.hash);
    void opening.then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setTopology(result.topology);
        setRps(clientRps(result.topology));
        setPresetId(null);
        setSelectedIds(new Set<string>());
        topoLiveRef.current = result.topology;
        engine.setTopology(result.topology);
        engine.reset();
        resetLostRate();
        setSnapshot(engine.snapshot());
        setFitNonce((n) => n + 1);
        toastSeq.current += 1;
        setToast({ text: 'Opened a shared design', id: toastSeq.current });
        return;
      }
      // Not ours, or ours and broken. Either way the stored session that
      // is already on screen stays, and saving resumes.
      setSharePending(false);
      if (result.status === 'invalid') {
        toastSeq.current += 1;
        setToast({ text: result.message, id: toastSeq.current });
      }
    });
    return () => {
      cancelled = true;
    };
    // Once, at boot. `sharePending` is deliberately absent from the deps:
    // the recipient's first edit clears it, and re-running this then would
    // reload the link over the change they had just made.
  }, [engine, resetLostRate]);

  /**
   * Open the share dialog without building anything. The design is only
   * uploaded once the reader asks for a link, so looking is free and a
   * store write always follows a deliberate click.
   */
  const handleOpenShare = useCallback(() => {
    setShareState({ status: 'idle' });
    setShareOpen(true);
  }, []);

  /**
   * Build the link. Goes to the store first, which is what keeps the URL
   * short whatever the design; where there is no store, or it cannot be
   * reached, the fragment format still carries the whole design.
   */
  const handleCopyLink = useCallback(() => {
    setShareState({ status: 'working' });
    void (async () => {
      // The store first, because it is what keeps a link short enough to
      // survive being pasted. Where there is no store configured, or it
      // cannot be reached, the fragment format still carries the design
      // and is the better answer than no link at all.
      if (hasStore()) {
        try {
          setShareState({
            status: 'ready',
            url: await storeTopology(topology, window.location.href),
          });
          return;
        } catch (e) {
          if (e instanceof ShareStoreError) {
            setShareState({ status: 'failed', message: e.message });
            return;
          }
          // Anything else came from encoding rather than the network, and
          // the fragment path below would hit it too.
        }
      }

      try {
        setShareState({
          status: 'ready',
          url: await buildShareUrl(topology, window.location.href),
        });
      } catch (e) {
        // A design that does not fit is told about, never trimmed to fit.
        // The file export carries any size.
        setShareState({
          status: 'failed',
          message:
            e instanceof ShareLinkTooLargeError
              ? `This design is too big for a link (${e.chars} characters; links stop working past ${e.limit}). Save it to a file instead.`
              : 'Could not build the link.',
        });
      }
    })();
  }, [topology]);

  const handleReset = useCallback(() => {
    engine.reset();
    // Synchronously, not via the derivation effect: Reset must never leave
    // the previous run's Dropped figure standing beside a zeroed clock.
    resetLostRate();
    setSnapshot(engine.snapshot());
  }, [engine, resetLostRate]);

  const handleToggleRun = useCallback(() => setRunning((r) => !r), []);

  /**
   * Advance one fixed tick with the loop stopped. Stepping while running
   * would race the rAF loop and make the delta non-deterministic, so a step
   * always pauses first — the same contract a debugger's step button has.
   */
  const handleStep = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    engine.advance(STEP_MS);
    setSnapshot(engine.snapshot());
  }, [engine]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never steal keys from a field the user is typing into.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      /*
       * Undo / redo. Bound by e.code, not e.key: KeyZ is the physical key in
       * the Z position, so the chord works on layouts (Cyrillic, Greek) where
       * pressing that key produces no letter "z" at all — the exact bug
       * Excalidraw shipped and fixed. Ctrl+Shift+Z and Ctrl+Y are both redo,
       * matching the two conventions users arrive with. Inert in text fields
       * via the guard above, so the browser keeps its own text undo.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyY') {
        e.preventDefault();
        handleRedo();
        return;
      }

      /*
       * Duplicate. By e.code for the same layout reasons as undo, and
       * preventDefault matters doubly here: Ctrl+D is the browser's
       * bookmark chord.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyD') {
        e.preventDefault();
        handleDuplicate();
        return;
      }

      /*
       * The shortcuts dialog, on Ctrl+/ — the settled convention for "show
       * me the keys" in tools whose "?" is already spoken for, and ours is:
       * "?" has toggled the glossary since it shipped, and stealing a taught
       * binding to advertise the other bindings would be self-defeating.
       */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'Slash') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        setRunning((r) => !r);
        return;
      }

      // Step one tick. Ignored with a modifier held so it cannot shadow
      // browser shortcuts like Cmd/Ctrl+S.
      if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleStep();
        return;
      }

      /*
       * The glossary. `?` is the long-standing convention for "show me the
       * reference", and it collides with nothing here: Space is play/pause,
       * S steps, Delete and Escape belong to the canvas. It is also inert
       * inside a text field by the guard at the top of this handler, which
       * matters because `?` is an ordinary character a student may well type
       * into the node-name box or the glossary's own search.
       *
       * Matched on e.key rather than a code plus Shift, so it works on the
       * keyboard layouts where `?` is not Shift+/ at all.
       *
       * It TOGGLES. A student who opened the panel with a key expects the
       * same key to shut it, and hunting for the close button after that is
       * exactly the small friction this whole feature exists to remove.
       */
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (glossaryOpen) closeGlossary();
        else openGlossary();
        return;
      }

      /*
       * Panel toggles. Single letters, like S above, and inert inside a
       * text field by the same guard: C for the components rail, M for the
       * metrics strip, I for the inspector. All three ignore held
       * modifiers so they can never shadow Cmd/Ctrl+C, Cmd/Ctrl+M or
       * Cmd/Ctrl+I in the browser.
       *
       * I is a no-op with nothing selected: the inspector is
       * selection-driven and an empty panel is not worth opening.
       */
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          toggleLibrary();
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          toggleMetrics();
          return;
        }
        if (e.key === 'i' || e.key === 'I') {
          if (hasSelection) {
            e.preventDefault();
            toggleInspector();
          }
          return;
        }
        /*
         * G for the grid snap. It sits with the panel toggles because it
         * obeys the same rules, but it is the one of these you press while
         * a drag is already in flight, which is the whole reason it is a
         * key: it was in Settings, and opening a modal mid-arrangement is
         * not something anyone does.
         *
         * Ctrl held during a drag still bypasses the snap for that drag
         * alone. The two do not fight: this is the standing setting, that
         * is the momentary override.
         */
        if (e.key === 'g' || e.key === 'G') {
          e.preventDefault();
          togglePreference('snapToGrid');
          return;
        }
      }

      // Delete/Backspace, Escape and Ctrl/Cmd+A belong to the canvas, which
      // owns the selection and knows how to partition it. Handling them here
      // too would double-fire.
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleStep,
    handleUndo,
    handleRedo,
    handleDuplicate,
    glossaryOpen,
    openGlossary,
    closeGlossary,
    toggleLibrary,
    toggleMetrics,
    toggleInspector,
    hasSelection,
  ]);

  /* ---------------- derived ---------------- */

  /**
   * The single-node subject. Still resolved separately because the Inspector's
   * `node` prop drives the whole single-node view; `selectedNodes` only takes
   * over when it holds two or more.
   */
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;

  const selectedStats =
    selectedNode && snapshot ? (snapshot.nodes[selectedNode.id] ?? null) : null;

  /**
   * The header's offered load, derived from the topology's client nodes (the
   * sum, so multi-client presets add up) rather than mirrored in a separate
   * state cell that add/delete paths forgot to reconcile. `rps` state remains
   * only as the persisted slider value for session restore.
   */
  const offeredRps = useMemo(() => clientRps(topology), [topology]);

  /**
   * Requests actually lost PER SECOND, derived from the engine's per-reason
   * counters. This is the single source of truth for "dropped": the top bar
   * and the throughput chart previously derived it two different ways
   * (`errorRate * offeredRps` and `offered - goodput`) and disagreed with
   * each other and with the failures panel. Neither derivation is loss —
   * `offered - goodput` counts in-flight work, and the errorRate product
   * rides a smoothed fraction against an instantaneous rate.
   *
   * `failuresByReason` is a LIFETIME COUNT, not a rate: the engine does
   * `this.failures[reason]++` per failure and zeroes it only on reset().
   * Summing it and labelling the total `/s` was wrong three ways — the unit
   * was a lie, the figure could only ever grow, and a recovered system still
   * read hundreds of thousands "dropped per second" because a counter cannot
   * fall. Observed directly: goodput 76/s and ERRORS 0% next to DROPPED
   * 218k/s.
   *
   * Differencing successive samples against elapsed SIM time turns the
   * counter into the rate this claims to be. Sim time is the right clock —
   * it follows pause, step and reset, where a wall clock would invent
   * traffic while the simulation is stopped. This mirrors the identical
   * derivation in Metrics.tsx, which fixed this same bug for the failures
   * panel. The backing refs and state live up beside handleReset, which must
   * zero them synchronously.
   */
  const cumulativeLost = useMemo(() => {
    if (!snapshot) return 0;
    let s = 0;
    for (const v of Object.values(snapshot.failuresByReason)) {
      if (Number.isFinite(v)) s += v;
    }
    return s;
  }, [snapshot]);

  const simTimeMs = snapshot?.system.timeMs ?? 0;

  /**
   * One definition of "the strip is open", shared by the slot and the
   * has-metrics class so the panel and the geometry that clears it (chrome
   * offsets, the safe-area sentinel) can never disagree.
   */
  const metricsVisible = layout.metrics && snapshot !== null;

  useEffect(() => {
    if (!Number.isFinite(simTimeMs)) return;
    const prev = lostPrevRef.current;
    const dtMs = simTimeMs - lostPrevTimeRef.current;

    // First sample, or a reset (sim time or the counter moved backwards):
    // adopt the count as the new baseline and report nothing this frame.
    if (prev === null || dtMs < 0 || cumulativeLost < prev) {
      lostPrevRef.current = cumulativeLost;
      lostPrevTimeRef.current = simTimeMs;
      setLostRps(0);
      return;
    }

    // Sample no faster than 250ms of sim time: below that the divisor is
    // tiny and the quotient is mostly quantisation noise.
    if (dtMs < 250) return;

    const delta = cumulativeLost - prev;
    lostPrevRef.current = cumulativeLost;
    lostPrevTimeRef.current = simTimeMs;
    setLostRps(delta > 0 ? (delta * 1000) / dtMs : 0);
  }, [cumulativeLost, simTimeMs]);

  return (
    <div className="app">
      <header className="app-bar" ref={barRef}>
        <div className="app-island app-island-brand">
          {/* The wordmark is the one place the product speaks in its own
            voice. Two words, sentence case, no abbreviation — a student
            opening this should be able to say what it is out loud. */}
          <div className="app-brand">
            <h1 className="app-title">Breakscale</h1>
            <p className="app-tagline">Build it, load it, watch it break</p>
          </div>

          {/*
            Says the work is safe.

            role=status, so it is announced rather than only drawn: someone
            who cannot see the dot has the same reason to worry about closing
            the tab as someone who can.
          */}
          <p
            className={`app-saved is-${saveState}`}
            role="status"
            title={
              saveState === 'saved'
                ? 'Your work is saved in this browser'
                : 'Saving your work'
            }
          >
            <span className="app-saved-dot" aria-hidden="true" />
            {saveState === 'saved' ? 'Saved' : 'Saving'}
          </p>

          {/*
          Undo / redo. Beside the wordmark, at the editing end of the bar,
          away from the run/pause cluster: these operate on the DIAGRAM, not
          on the simulation. Disabled state is derived from the history
          stacks on every render, so the buttons can never claim emptiness
          while entries exist (the cached-boolean regression Excalidraw
          shipped). Icon-only, because "curved arrow left" is one of the few
          icons with a universally settled meaning, and the title carries the
          shortcut for anyone hovering to check.
        */}
          <div className="app-history">
            <button
              type="button"
              className="btn btn-sm btn-icon"
              disabled={!canUndo}
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              onClick={handleUndo}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-icon"
              disabled={!canRedo}
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              onClick={handleRedo}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m15 14 5-5-5-5" />
                <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
              </svg>
            </button>
          </div>
        </div>

        <div className="app-island app-island-load">
          <TrafficControl
            rps={offeredRps}
            onRpsChange={handleRpsChange}
            running={running}
            onToggleRun={handleToggleRun}
            onStep={handleStep}
            onReset={handleReset}
            system={snapshot?.system ?? EMPTY_SYSTEM}
            lost={lostRps}
            empty={topology.nodes.length === 0}
            noTrafficSource={offeredRps === 0 && findClients(topology).length === 0}
          />
        </div>

        <div className="app-island app-island-menu">
          {/*
          Everything that is reference or setup, behind one button.

          Examples, Shortcuts, Settings and Glossary were four buttons
          competing with the load control and the live readouts. They are all
          reached BETWEEN actions rather than during one, so folding them
          here leaves the bar carrying only what changes while the simulation
          runs, which is the thing a reader is actually watching.
        */}
          {/*
            The one outward link in the bar.

            It sits here rather than in the menu because it is the only thing
            on this surface addressed to someone deciding whether to trust the
            project, and a reader who has to open a menu to find the source
            has usually stopped looking. Chrome, so the canvas ignores it.
          */}
          <a
            className={`btn btn-icon app-source-link${stars !== null ? ' has-stars' : ''}`}
            href="https://github.com/workersio/breakscale"
            target="_blank"
            rel="noreferrer noopener"
            aria-label={
              starCount !== null
                ? `Source on GitHub, ${starCount} stars`
                : 'Source on GitHub'
            }
            title="Source on GitHub"
            data-chrome=""
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 1.5a10.5 10.5 0 0 0-3.32 20.47c.53.1.72-.23.72-.5v-1.8c-2.92.63-3.54-1.41-3.54-1.41-.48-1.21-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.06.08 1.61 1.09 1.61 1.09.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.67-1.4-2.33-.27-4.78-1.17-4.78-5.19 0-1.15.41-2.09 1.08-2.82-.11-.27-.47-1.34.1-2.79 0 0 .88-.28 2.88 1.07a9.9 9.9 0 0 1 5.24 0c2-1.35 2.88-1.07 2.88-1.07.57 1.45.21 2.52.1 2.79.67.73 1.08 1.67 1.08 2.82 0 4.03-2.45 4.92-4.79 5.18.38.33.71.97.71 1.96v2.9c0 .28.19.61.72.5A10.5 10.5 0 0 0 12 1.5z" />
            </svg>
            {/* Absent until the fetch resolves, not rendered empty and filled
                later: a reserved-but-blank slot would shift nothing today but
                invites a layout-shift bug the day the icon gets a neighbour
                that shows before this does. aria-hidden because the accessible
                name above already carries the count. A bare number next to
                the mark reads as nothing in particular, so a small star
                glyph says what it is without a word of copy. */}
            {stars !== null && (
              <span className="app-source-stars" aria-hidden="true">
                <span className="app-source-star-wrap">
                  <svg
                    className="app-source-star-glyph"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 2.5l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7-5.4-4.7 7.1-.7z" />
                  </svg>
                </span>
                {formatStars(stars)}
              </span>
            )}
          </a>

          {/* Labelled, and in the bar rather than three levels down inside
              Settings. Sending a design to someone is a thing people want
              to do often, and a feature nobody can find has not shipped. */}
          <button
            type="button"
            className="btn app-share-btn"
            onClick={handleOpenShare}
            title="Get a link to this design"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
            </svg>
            Share
          </button>

          <div className="app-menu-wrap">
            <button
              type="button"
              className="btn btn-icon app-menu-btn"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Menu"
              title="Examples, settings and help"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <MainMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              items={menuItems}
            />
          </div>
        </div>
      </header>

      {/*
        The has-* classes drive every piece of geometry that must clear an
        open panel: the strip's side insets, the toggle and canvas-chrome
        offsets, and the .stage-safe sentinel (all in App.css). They flip at
        toggle time, while a closing panel is still sliding out, so the
        chrome and the panel move on the same clock.
      */}
      <div
        className={
          'app-body' +
          (layout.library ? ' has-library' : '') +
          (inspectorVisible ? ' has-inspector' : '') +
          (metricsVisible ? ' has-metrics' : '')
        }
        /* The three panel sizes, written here because .app-body is where the
           slots and the strip's insets all read them from. A drag rewrites
           these same properties directly on this element and only commits to
           React at the end, so the canvas does not re-render per frame. */
        style={
          {
            '--rail-w': `${layout.railW}px`,
            '--ins-w': `${layout.insW}px`,
            '--strip-h': `${layout.stripH}px`,
            /* The bar's own height plus the gap it floats in. Falls back to
               the stylesheet's constant until the first measurement lands. */
            ...(barBottom === null
              ? {}
              : { '--bar-clear': `${barBottom + BAR_GAP_PX}px` }),
          } as CSSProperties
        }
      >
        <PanelSlot
          open={layout.library}
          edge="left"
          onDismiss={phone ? toggleLibrary : undefined}
        >
          <Palette
            onAdd={handlePaletteAdd}
            onAddAnnotation={handlePaletteAnnotation}
            armedTool={armedTool}
          />
          <PanelResizer
            edge="left"
            property="--rail-w"
            size={layout.railW}
            min={PANEL_LIMITS.railW.min}
            max={PANEL_LIMITS.railW.max}
            onCommit={(railW) => setLayout((l) => ({ ...l, railW }))}
            onReset={() => setLayout((l) => ({ ...l, railW: PANEL_LIMITS.railW.base }))}
            label="Resize the components rail"
          />
        </PanelSlot>

        <main className="app-stage">
          {/*
            The canvas plus the chrome that floats OVER it. The toggles are
            SIBLINGS of the Canvas, never children of .cv-surface, so the
            canvas gesture router cannot see a press on them; data-chrome is
            belt and braces on top of that, matching the exclusion selector
            the router uses.

            Each panel's toggle lives at the canvas edge the panel occupies
            and stays there in both states, so collapsing something never
            leaves a dead edge: the affordance that closed it is the
            affordance that brings it back, in the same place.
          */}
          {/*
            A design file dropped anywhere on the canvas opens it. The
            handlers sit on this wrapper rather than inside the Canvas
            because a file drop is not one of the pointer router's
            gestures, and because without the dragover preventDefault the
            browser would leave the app to display the JSON.
          */}
          <div
            className="stage-canvas"
            onDragOver={handleFileDragOver}
            onDrop={handleFileDrop}
          >
            <Canvas
              topology={topology}
              snapshot={snapshot}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              onMoveNode={handleMoveNode}
              onMoveStart={handleMoveStart}
              onMoveEnd={handleMoveEnd}
              onConnect={handleConnect}
              onDeleteSelection={handleDeleteSelection}
              onDropNode={handleAddNode}
              onRename={handleRename}
              onDuplicateForDrag={handleDuplicateForDrag}
              onPaste={handlePaste}
              onMoveAnnotation={handleMoveAnnotation}
              onResizeSection={handleResizeSection}
              onResizeNote={handleResizeNote}
              onScaleNote={handleScaleNote}
              onCreateNote={handleCreateNote}
              onCreateSection={handleCreateSection}
              onEditNote={handleEditNote}
              onEditSectionLabel={handleEditSectionLabel}
              onSetNoteSize={handleSetNoteSize}
              onSetSectionTone={handleSetSectionTone}
              onSetNoteStyle={handleSetNoteStyle}
              spark={spark}
              viewCenterRef={viewCenterRef}
              armToolRef={armToolRef}
              exportSvgRef={exportSvgRef}
              onToolChange={setArmedTool}
              fitSignal={fitNonce}
              visibleRef={stageSafeRef}
            />
            {/*
              The uncovered-canvas sentinel. Inert and invisible; a sibling
              of the Canvas, outside .cv-surface, so the gesture router can
              never see it. Its rect is the canvas minus every open panel.
            */}
            <div ref={stageSafeRef} className="stage-safe" aria-hidden="true" />
            {challenge && challengeResult ? (
              <ChallengePanel
                challenge={challenge}
                result={challengeResult}
                onGiveUp={() => setChallengeId(null)}
              />
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-icon stage-toggle stage-toggle-library"
              data-chrome="layout"
              aria-expanded={layout.library}
              aria-label={layout.library ? 'Hide components' : 'Show components'}
              title={layout.library ? 'Hide components (C)' : 'Show components (C)'}
              onClick={toggleLibrary}
            >
              <PanelGlyph edge="left" />
            </button>
            {/*
              Rendered only while something is selected, because that is the
              only time the inspector can exist at all. With nothing
              selected there is no panel AND no button — the affordance for
              the inspector is selection itself, which the empty-canvas copy
              and the palette rows already teach.
            */}
            {hasSelection ? (
              <button
                type="button"
                className="btn btn-sm btn-icon stage-toggle stage-toggle-inspector"
                data-chrome="layout"
                aria-expanded={inspectorVisible}
                aria-label={inspectorVisible ? 'Hide inspector' : 'Show inspector'}
                title={inspectorVisible ? 'Hide inspector (I)' : 'Show inspector (I)'}
                onClick={toggleInspector}
              >
                <PanelGlyph edge="right" />
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-icon stage-toggle stage-toggle-metrics"
              data-chrome="layout"
              aria-expanded={layout.metrics}
              aria-label={layout.metrics ? 'Hide charts' : 'Show charts'}
              title={layout.metrics ? 'Hide charts (M)' : 'Show charts (M)'}
              onClick={toggleMetrics}
            >
              <PanelGlyph edge="bottom" />
            </button>
          </div>
          <PanelSlot
            open={metricsVisible}
            edge="bottom"
            onDismiss={phone ? toggleMetrics : undefined}
          >
            {snapshot ? (
              <Metrics
                snapshot={snapshot}
                nodeNames={nodeNames}
                nodes={topology.nodes}
              />
            ) : null}
            <PanelResizer
              edge="bottom"
              property="--strip-h"
              size={layout.stripH}
              min={PANEL_LIMITS.stripH.min}
              max={PANEL_LIMITS.stripH.max}
              onCommit={(stripH) => setLayout((l) => ({ ...l, stripH }))}
              onReset={() =>
                setLayout((l) => ({ ...l, stripH: PANEL_LIMITS.stripH.base }))
              }
              label="Resize the charts strip"
            />
          </PanelSlot>
        </main>

        <PanelSlot
          open={inspectorVisible}
          edge="right"
          onDismiss={phone ? toggleInspector : undefined}
        >
          <Inspector
            node={selectedNode}
            stats={selectedStats}
            onChange={handleConfigChange}
            onDelete={handleDeleteNode}
            onRename={handleRename}
            selectedNodes={selectedNodes}
            selectedEdgeCount={selectedEdgeCount}
            onChangeMany={handleConfigChangeMany}
            onDeleteMany={handleDeleteMany}
            lockedFields={challenge ? FIXED_DURING_CHALLENGE : undefined}
          />
          <PanelResizer
            edge="right"
            property="--ins-w"
            size={layout.insW}
            min={PANEL_LIMITS.insW.min}
            max={PANEL_LIMITS.insW.max}
            onCommit={(insW) => setLayout((l) => ({ ...l, insW }))}
            onReset={() => setLayout((l) => ({ ...l, insW: PANEL_LIMITS.insW.base }))}
            label="Resize the inspector"
          />
        </PanelSlot>
      </div>

      {/*
        The phone tab bar.

        CSS decides whether this is visible, not JS: it reads the same panel
        state the desktop's edge toggles read, so the two can never disagree
        about whether a panel is open. Above the breakpoint it is
        display:none and costs a reader nothing.

        The inspector tab is disabled rather than hidden when nothing is
        selected. A tab bar whose tabs come and go moves the others under
        the thumb mid-tap, and the disabled state teaches what the tab is
        for: select something and it lights up.
      */}
      <nav className="app-tabbar" aria-label="Panels">
        <button
          type="button"
          className="app-tab"
          aria-expanded={layout.library}
          onClick={toggleLibrary}
        >
          <PanelGlyph edge="left" />
          Build
        </button>
        <button
          type="button"
          className="app-tab"
          aria-expanded={inspectorVisible}
          disabled={!hasSelection}
          onClick={toggleInspector}
        >
          <PanelGlyph edge="right" />
          Inspect
        </button>
        <button
          type="button"
          className="app-tab"
          aria-expanded={layout.metrics}
          onClick={toggleMetrics}
        >
          <PanelGlyph edge="bottom" />
          Charts
        </button>
      </nav>

      {/*
        Mounted ONCE for the whole app. Every <Term> anywhere in the tree is a
        stateless trigger that this single layer renders the panel for, so the
        cost of an explanation is paid per tooltip OPEN rather than per term
        present. Both of these portal to <body>, so their position here is
        about ownership, not stacking.
      */}
      {/*
        Undo/redo receipt. role="status" (polite live region) so a screen
        reader hears the same confirmation a sighted user sees; keyed by id so
        rapid consecutive undos restart the entrance rather than sitting
        still on a message that appears not to change.
      */}
      {toast ? (
        <div key={toast.id} className="app-toast" role="status">
          {toast.text}
        </div>
      ) : null}

      {/*
        A refused import. role="alert" rather than "status" because this
        reports a failure the student needs to notice, and it sits longer
        than the toast does: the sentence names what was wrong with the
        file, and there is nothing else on screen that changed to say so.
        Nothing on the canvas moved, which is the point.
      */}
      {importError ? (
        <div className="app-toast app-toast-error" role="alert">
          {importError}
        </div>
      ) : null}

      <TooltipLayer />
      <Glossary open={glossaryOpen} onClose={closeGlossary} focusId={glossaryFocusId} />
      <Shortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Share
        open={shareOpen}
        state={shareState}
        onClose={() => setShareOpen(false)}
        onShare={handleCopyLink}
        onExport={() => {
          setShareOpen(false);
          handleExport();
        }}
      />
      {/* The real file input, kept off screen. A bare one cannot be styled,
          so the Settings row calls click() on this. It lives beside the
          dialogs rather than in the top bar, which carries only the share
          control. */}
      <input
        ref={fileInputRef}
        type="file"
        className="app-file-input"
        accept={DESIGN_FILE_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleImportPick}
      />
      <input
        ref={backupInputRef}
        type="file"
        className="app-file-input"
        accept=".json,application/json"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleRestorePick}
      />
      <Designs
        open={designsOpen}
        onClose={() => setDesignsOpen(false)}
        onOpen={handleOpenSaved}
        onSave={handleSaveNamed}
        suggestedName={
          presetId ? (PRESETS.find((p) => p.id === presetId)?.name ?? '') : ''
        }
      />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onExport={handleExport}
        onImport={() => fileInputRef.current?.click()}
        onCopyLink={handleOpenShare}
        onExportImage={handleExportImage}
        onBackup={handleBackup}
        onRestore={() => backupInputRef.current?.click()}
      />

      <Examples
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        presets={PRESETS}
        activePresetId={presetId}
        onLoad={handleLoadPreset}
      />
      <Challenges
        open={challengesOpen}
        onClose={() => setChallengesOpen(false)}
        challenges={CHALLENGES}
        onStart={handleStartChallenge}
      />
    </div>
  );
}

/**
 * Stable empty array for the no-selection case. A fresh `[]` each render
 * would give the Inspector a new prop identity every 100ms and defeat any
 * memoisation it does.
 */
const EMPTY_NODES: readonly SimNode[] = [];

/** Shown for the single frame before the first snapshot exists. */
const EMPTY_SYSTEM = {
  timeMs: 0,
  offeredRps: 0,
  goodputRps: 0,
  errorRate: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  totalRequests: 0,
  totalFailed: 0,
};
