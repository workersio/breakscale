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
import type {
  NodeConfig,
  NodeKind,
  RouteStats,
  SimNode,
  SimSnapshot,
  Topology,
} from './sim/types';
import { useCoarsePointer } from './useCoarsePointer';
import { useGithubStars, useCountUp, formatStars } from './useGithubStars';
import { useBarFit } from './useBarFit';
import { SpeedMeter, advanceAtSpeed, shortfall, stepSpeed, type Speed } from './speed';
import type { PinnedRun } from './components/pinnedRun';
import { Engine } from './sim/engine';
import { PRESETS, makeNode } from './sim/presets';
import { CHALLENGES, challengeById } from './sim/challenges';
import { captionAt, INCIDENT_BRIEFS, INCIDENTS, incidentById } from './sim/incidents';
import { evaluate, lockedFieldsFor } from './sim/challenge';
import type { Challenge } from './sim/challenge';
import { canonical, designKey, judgedTopology, startDesign } from './sim/judge';
import type { Verdict } from './sim/judge';
import { ChallengePanel } from './components/Challenge';
import { IncidentPanel } from './components/Incidents';
import { BreakPanel } from './components/BreakIt';
import type { Names } from './components/breakCopy';
import { clock, secs } from './components/breakCopy';
import { formatGoalMs, formatGoalPct, formatShareDown } from './components/format';
import { Challenges } from './components/Challenges';
import {
  CHALLENGES_KEY,
  EMPTY_STORE,
  attemptFor,
  badgeFor,
  challengeParam,
  conform,
  freshStart,
  loadChallengeStore,
  nextChallenge,
  saveChallengeStore,
  withActive,
  withAttempt,
  withHints,
  withPass,
} from './challengeWorkspace';
import type { ChallengeStore } from './challengeWorkspace';
import { useChallengeCheck } from './useChallengeCheck';
import { useBreakSearch } from './useBreakSearch';
import { BREAK_END_MS, BREAK_WARMUP_MS, measureSeed, replayOf } from './sim/breakit';
import type { Attack } from './sim/breakit';
import type { Goal } from './sim/challenge';
import type { Preset } from './sim/presets';
import Canvas, {
  GRID,
  NODE_H,
  NODE_W,
  SPARK_LEN,
  readoutFor,
  sourceBacklogs,
} from './components/Canvas';
import { Inspector, TrafficControl, slowable } from './components/Inspector';
import { RouteAlert } from './components/RouteAlert';
import {
  DEFAULT_SLOW_FACTOR,
  asReplacement,
  faultActionsFor,
  formatFactor,
  faultViewFor,
  withEdgeLoss,
  withSchedule,
} from './components/faultWiring';
import { applyFaultChange, undoableFaultActions } from './components/faultUndo';
import { Metrics } from './components/Metrics';
import { Palette } from './components/Palette';
import { Glossary } from './components/Glossary';
import { Shortcuts } from './components/Shortcuts';
import { StripCue } from './components/StripCue';
import { isMac, shortcutLabel } from './modKey';
import { Examples } from './components/Examples';
import {
  buildClipboardText,
  cloneSubgraph,
  isTopology,
  parseClipboardText,
  selectionSubgraph,
} from './clipboard';
import type { ClipboardSubgraph } from './clipboard';
import { CanvasMenu } from './components/CanvasMenu';
import { CommandPalette } from './components/CommandPalette';
import { PresentBar, type PresentPart } from './components/PresentBar';
import { buildCommands, type CommandActions, type CommandFacts } from './appCommands';
import { loadRecent, pushRecent, saveRecent, type Command } from './commands';
import {
  canFullscreen,
  toggleFullscreen,
  useFocusedPart,
  useFullscreen,
  usePresenting,
} from './present';
import { pinRun, trailingWindow } from './components/pinnedRun';
import type { CanvasMenuActions } from './components/CanvasMenu';
import type { CanvasMenuApi } from './components/Canvas';
import type { CanvasMenuRequest } from './components/contextMenuItems';
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
import { sanitizeFaults } from './sim/faults';
import { sanitizeSeed } from './sim/seed';
import { NEW_NOTE_TEXT } from './components/annotationLayout';
import type { AnnotationTool } from './components/Palette';
import { TooltipLayer, setGlossaryNavigate } from './components/Tooltip';
import { FindProblem } from './learn/FindProblem';
import { currentFinding, spotlightOf, type Finding } from './learn/finding';
import { WhatHappened } from './learn/WhatHappened';
import { LearningPath } from './learn/LearningPath';
import {
  stepAfter,
  stepName,
  stepOfBrief,
  usePathProgress,
} from './learn/pathProgress';
import type { PathStep } from './content/learningPath';
import { PassStrip } from './learn/PassStrip';
import { useExampleTask } from './learn/useExampleTask';
import { TaskCard } from './learn/TaskCard';
import { Tour } from './learn/Tour';
import { useTour } from './learn/useTour';
import { setPreference, togglePreference, usePreference } from './content/preferences';
import type { ThemeChoice } from './content/preferences';
import { GLOSSARY } from './content/glossary';
import { KIND_GROUPS, KIND_NAME } from './components/nodeVisuals';
import { EMPTY_BOOT_PARAMS, parseBootParams } from './urlParams';
import type { BootParams } from './urlParams';
import { Settings } from './components/Settings';
import { MainMenu, type MenuItem } from './components/MainMenu';
import { Designs } from './components/Designs';
import { getDesign, saveDesign } from './savedDesigns';
import { downloadBackup, restoreBackup } from './backup';
import { PanelResizer } from './components/PanelResizer';
import { applyTheme } from './theme/applyTheme';
import { usePresence } from './components/presence';
import { SessionHistory, syncEngine } from './history';
import type { FaultApplier, HistoryEntry, HistorySnapshot } from './history';
import { ShareLinkTooLargeError, decodeTopology, hasShareHash } from './share';
import { ID_PARAM, ShareStoreError, fetchStored, hasStoredLink } from './share/store';
import { challengeLink, exampleParam, routedHref } from './urlRoute';
import {
  buildLink,
  designTopology,
  hasReplay,
  replayTopology,
} from './share/replayLink';
import { Share, type ShareKind, type ShareResult } from './components/Share';
import { DESIGN_FILE_ACCEPT, downloadDesign, readDesignFile } from './designFile';
import { downloadBlob, svgToPng } from './imageExport';
import { PHONE_QUERY } from './phoneQuery';
import { isOneRail, libraryShown, useOneRail } from './oneRail';
import { cycleRegion, focusDiagram } from './keyboardNav';
import { revealTarget } from './revealTarget';
import './App.css';
import './App.phone.css';
import './App.present.css';

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/** Every brief the challenge store keeps attempts for, the incidents' too. */
const ALL_BRIEFS: readonly Challenge[] = [...CHALLENGES, ...INCIDENT_BRIEFS];

const STORAGE_KEY = 'breakscale.session.v1';

/**
 * Fixed step for the `?warmup=` boot advances. One simulated frame, so the
 * engine crosses the warmup in the same granularity it would have run at
 * live, and a deterministic seed replays identically at any dt summing to
 * the same total.
 */
const WARMUP_STEP_MS = 1000 / 60;

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

/** Presenting's bar goes to two rows before its load slider is narrower
    than this, so the room can see it move. */
const PRESENT_MIN_SLIDER_PX = 240;

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
 * A media query rather than a device test. The question is how much room the
 * shell has, and a small desktop window has exactly the same problem as a
 * phone; a tablet in landscape has neither. A phone on its side is the one
 * place a pointer test joins in; see phoneQuery.ts.
 */

const SOURCE_URL = 'https://github.com/workersio/breakscale';

function subscribePhone(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/**
 * Too narrow for the components rail, a brief or task card and a diagram
 * between them. Measured at 820px: the canvas left between the rail and a
 * brief was about 220px, and the part the brief was about sat under it.
 */
const CROWDED_QUERY = '(max-width: 1100px)';

function subscribeCrowded(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(CROWDED_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function isCrowded(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(CROWDED_QUERY).matches;
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
  scrim = true,
}: {
  open: boolean;
  edge: 'left' | 'right' | 'bottom';
  children: ReactNode;
  /**
   * Dim the canvas behind the sheet and close it on a tap there. Off for
   * the inspector, whose sheet leaves the diagram above it in use: a tap on
   * another part selects that part, and a tap on empty canvas clears the
   * selection, which closes the sheet anyway.
   */
  scrim?: boolean;
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
      {onDismiss && scrim ? (
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
    const faults = sanitizeFaults(
      (s.topology as { faults?: unknown }).faults,
      s.topology,
    );
    // The seed goes with the faults: the same faults on another seed land in
    // a different run from the one that was recorded or shared.
    const seed = sanitizeSeed((s.topology as { seed?: unknown }).seed);
    return {
      topology: {
        nodes: s.topology.nodes,
        edges: s.topology.edges,
        ...(annotations.length > 0 ? { annotations } : {}),
        ...(faults.length > 0 ? { faults } : {}),
        ...(seed !== undefined ? { seed } : {}),
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
 * The stored session as written, or null when there is none or storage is
 * blocked. Compared, not parsed: it says whether another tab has saved over
 * the session since this one last looked.
 */
function storedSessionRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
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

/**
 * Take a share link off the URL: the fragment, and the query id a stored
 * link pairs with it. For a brief started from a link, so a reload comes back
 * to the brief rather than to the link, which boot would otherwise put first.
 */
function dropShareLink(): void {
  try {
    if (!shareHashPresent()) return;
    const url = new URL(window.location.href);
    url.hash = '';
    url.searchParams.delete(ID_PARAM);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // A locked-down location: the link stays, and a reload opens it again.
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

/**
 * What the clients actually sent over the last second, but only while one of
 * them runs a traffic shape. Then the slider's figure is a base the shape
 * moves around, and this is the number that is really arriving. Null on
 * steady traffic, where the two are the same and a second figure is noise.
 */
function shapedLiveRps(t: Topology, snapshot: SimSnapshot | null): number | null {
  if (snapshot === null) return null;
  let shaped = false;
  let sum = 0;
  for (const c of findClients(t)) {
    if ((c.config.traffic ?? 'steady') !== 'steady') shaped = true;
    sum += snapshot.nodes[c.id]?.arrivalRate ?? 0;
  }
  return shaped ? sum : null;
}

/**
 * Said after opening something from inside a brief, which goes back to the
 * reader's own design and replaces it, as opening it from there would.
 */
const IN_PLACE = 'in place of your design. Undo brings yours back.';

/* What makes two incident scenes the same run: boxes, settings and
   connections, not where the boxes sit. */
const sceneKey = (t: Topology) =>
  canonical({ nodes: t.nodes.map((n) => [n.id, n.kind, n.config]), edges: t.edges });

/** The reader's own design, held while a challenge has the canvas. */
interface Aside extends Session {
  /**
   * It was a share link they had not touched yet. It comes back the same
   * way, still not saved over their own design until they change it.
   */
  shared: boolean;
  /**
   * The stored session when this was set aside. If storage holds something
   * else by the time the reader leaves, another tab has saved newer work of
   * theirs, and that comes back instead of this copy.
   */
  stamp: string | null;
}

/**
 * The challenge store as storage holds it, over what this tab holds. Each
 * write goes to storage at once, so what storage has is never older than
 * memory, only newer where another tab wrote. Memory fills in what storage
 * could not keep, and which brief is open is this tab's.
 */
function mergeStored(mine: ChallengeStore, stored: ChallengeStore): ChallengeStore {
  if (stored === EMPTY_STORE) return mine;
  return {
    active: mine.active,
    attempts: { ...mine.attempts, ...stored.attempts },
    progress: { ...mine.progress, ...stored.progress },
  };
}

/** What the app opens on: whose workspace, and what is in it. */
interface Boot {
  session: Session;
  challengeId: string | null;
  aside: Aside | null;
  store: ChallengeStore;
  /**
   * What to tell the reader once the app is up, when boot moved them out of
   * their own design on a `?challenge=` link. Starting from the picker says
   * the same, so the canvas changing is never a mystery either way.
   */
  notice: string | null;
}

/** What URL boot parameters a read gives, or none when there is no DOM
 * (a test importing the app) or the location object is a stub. */
function readBootParams(): BootParams {
  try {
    return parseBootParams(window.location.search, window.location.hash);
  } catch {
    return EMPTY_BOOT_PARAMS;
  }
}

/** A session set to the named example. Deep copied: presets are module-level
 * constants and must never be mutated by editing the loaded system. The id
 * is known to exist, because parseBootParams only returns ids matched against
 * PRESETS; the fall-back is for the impossible miss alone. */
function presetSessionFor(id: string): Session {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return loadSession();
  const topology = structuredClone(preset.topology);
  return { topology, rps: clientRps(topology), presetId: preset.id };
}

/**
 * Choose the workspace to open.
 *
 * A share link wins over everything, a brief included: someone opening a
 * link wants to see that link. The brief's attempt is kept for next time and
 * the reader's own design stays in storage, unwritten, as it always does
 * under a link. Otherwise a `?challenge=<id>` link starts or resumes that
 * brief, and failing that the brief the reader was in when they left comes
 * back. Inside a brief the reader's own design is what storage holds, since
 * nothing writes it while a brief is open, so that is what is set aside.
 */
function bootWorkspace(): Boot {
  const own = loadSession();
  const store = loadChallengeStore(ALL_BRIEFS);
  if (shareHashPresent()) {
    return {
      session: own,
      challengeId: null,
      aside: null,
      store: withActive(store, null),
      notice: null,
    };
  }
  let linked: string | null = null;
  try {
    linked = challengeParam(window.location.search);
  } catch {
    // No DOM (a test importing App): no link to follow.
  }
  const id = linked && challengeById(linked) ? linked : store.active;
  const challenge = id ? challengeById(id) : undefined;
  if (!challenge) {
    // A ?preset= deep link names a specific example to open: it replaces
    // the whole stored design, exactly what clicking the example in the
    // palette does, rather than only relabelling the last session. It
    // loses to a share link and to a challenge route, which carry a more
    // specific thing to open than "show me an example", and it does not
    // reach inside a brief that a reopening of the app would resume.
    const link = readBootParams();
    if (link.presetId !== null && !id) {
      return {
        session: presetSessionFor(link.presetId),
        challengeId: null,
        aside: null,
        store: withActive(store, null),
        notice: null,
      };
    }
    return {
      session: own,
      challengeId: null,
      aside: null,
      store: withActive(store, null),
      notice: null,
    };
  }
  const attempt = attemptFor(store, challenge);
  const topology = attempt?.topology ?? freshStart(challenge);
  const stamp = storedSessionRaw();
  // Only a link that took the reader out of their own saved design. A
  // reload inside a brief, or a first visit with nothing saved, needs no word.
  const notice =
    id === linked && store.active === null && stamp !== null
      ? attempt
        ? 'Picked up where you left off. Your design is set aside until you leave.'
        : 'Your design is set aside. It comes back when you leave.'
      : null;
  return {
    session: { topology, rps: clientRps(topology), presetId: challenge.presetId },
    challengeId: challenge.id,
    aside: { ...own, shared: false, stamp },
    store: withActive(withAttempt(store, challenge, topology), challenge.id),
    notice,
  };
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

export default function App() {
  /*
   * Deep-link parameters (?preset, ?theme, ?paused, ?warmup), parsed once
   * before the first paint alongside the stored session. A preset parameter
   * replaces the whole stored design — exactly what clicking the example in
   * the palette does — rather than only relabelling whatever session was
   * last on screen, which is what made /?preset=load-balanced show three
   * nodes and no load balancer.
   */
  const [params] = useState(() => {
    try {
      return parseBootParams(window.location.search, window.location.hash);
    } catch {
      // No DOM (a test importing App) or a locked-down location object:
      // boot from storage alone, like any plain visit.
      return EMPTY_BOOT_PARAMS;
    }
  });

  const [boot] = useState(bootWorkspace);
  const initial = boot.session;

  /**
   * "The URL named an example and the reader has not edited it yet."
   *
   * On the same policy as a share link below, the session write is held
   * while this is true: opening /?preset=netflix must not silently replace
   * the reader's own saved design before they have touched anything.
   * Released by the first history entry, exactly like sharePending.
   *
   * Not armed inside a brief: there the canvas is the brief's and saving
   * goes to the attempt store; the hold protects the reader's own design.
   */
  const [urlPreset, setUrlPreset] = useState(
    () => params.presetId !== null && boot.challengeId === null,
  );

  /**
   * "A share link is on the URL and has not been dealt with yet."
   *
   * While this is true the session is not written to storage. The
   * recipient's own design stays exactly as they left it until they
   * actually change something on the shared one, which is the whole of the
   * read-only promise this feature makes.
   */
  /* A share hash outranks a preset param when a URL carries both: the share
     payload is the more specific thing to open. The async decode below
     overwrites the synchronously loaded preset when it lands, so both flags
     start true and the persistence hold covers either. */
  const [sharePending, setSharePending] = useState(shareHashPresent);

  /**
   * The share dialog, and which opening of it this is. The dialog keeps
   * the links it built; a new key on each opening forgets them, so a link
   * built for an earlier version of the design is never offered again.
   */
  const [shareOpen, setShareOpen] = useState(false);
  const [shareSession, setShareSession] = useState(0);
  /**
   * A break's replay, set when the break-it panel opens the dialog, so the
   * dialog's run link is that break and not the run on screen. Null otherwise.
   */
  const [shareRun, setShareRun] = useState<Topology | null>(null);

  const [topology, setTopology] = useState<Topology>(initial.topology);
  /**
   * The design's 1x: its total client rate when it was opened (an example, a
   * file, a share link, a brief), or when the reader said "make this 1x".
   * The slider leaves it alone, so the header can say how far it has been
   * pushed. Saved with the session, never put in a share link, so a shared
   * design's 1x is whatever it was sending when the recipient opened it.
   */
  const [rps, setRps] = useState<number>(initial.rps);
  const [presetId, setPresetId] = useState<string | null>(initial.presetId);
  /** Counts example loads, so opening the same one again restarts its task. */
  const [exampleRun, setExampleRun] = useState(0);
  /** The task card takes focus as it next shows: see TaskCard's takeFocus. */
  const [taskFocus, setTaskFocus] = useState(false);
  const handleTaskFocusTaken = useCallback(() => setTaskFocus(false), []);
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
  // `?paused=1` boots frozen. The screenshot suite needs a frame that does
  // not move between load and capture; a human reads it as a paused player.
  const [running, setRunning] = useState(!params.paused);

  /**
   * The glossary side sheet.
   *
   * `glossaryFocusId` is the entry to land on. It is cleared when the sheet
   * closes so that reopening from the top bar starts at the top of the list
   * rather than resuming wherever the last "see also" link happened to go.
   */
  /* The theme is applied to <html>, which is outside React, so this is a
     genuine external-system synchronisation rather than derived state.

     A `theme` boot parameter is a one-shot override for this page view: it
     wins on mount and is then dropped the moment the reader picks a theme
     in Settings, which persists their choice as normal. It therefore never
     writes the stored preference, and a reload without the parameter boots
     the reader's own theme. `#theme=` is parsed from the hash, which share
     payloads (d1./d2.) cannot collide with: they carry no '=' at all. */
  const themeChoice = usePreference('theme');
  const themeOverrideRef = useRef<ThemeChoice | null>(params.theme);
  const lastThemeChoiceRef = useRef(themeChoice);

  useLayoutEffect(() => {
    if (lastThemeChoiceRef.current !== themeChoice) themeOverrideRef.current = null;
    lastThemeChoiceRef.current = themeChoice;
    applyTheme(themeOverrideRef.current ?? themeChoice);
  }, [themeChoice]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [glossaryFocusId, setGlossaryFocusId] = useState<string | undefined>(undefined);

  /** The keyboard shortcuts dialog. Ctrl+/ and the top-bar button. */
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /* The command palette (Ctrl+K), and what it ran last, newest first. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recentCommands, setRecentCommands] = useState<string[]>(loadRecent);
  /* The menu and the chord are wired above the palette's builder; they
     reach it through these. */
  const openPaletteRef = useRef<() => void>(() => {});
  const paletteOpenRef = useRef(false);
  /* Presenting mode (present.ts). The fault keys are bound once, here, and
     reach the fault controls declared further down through this ref. */
  const presentFaultRef = useRef<(kind: 'crash' | 'slow' | 'fix') => void>(() => {});
  const presentChangeRef = useRef<(on: boolean) => void>(() => {});
  const { presenting, togglePresenting, stopPresenting } = usePresenting(
    useCallback((kind: 'crash' | 'slow' | 'fix') => presentFaultRef.current(kind), []),
    useCallback((on: boolean) => presentChangeRef.current(on), []),
  );
  const fullscreen = useFullscreen();
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
  /** "Can you break it?" is open. Only in the reader's own workspace. */
  const [breakOpen, setBreakOpen] = useState(false);
  /** The real incident whose panel is open, by id. Only in the reader's own workspace. */
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [pathOpen, setPathOpen] = useState(false);

  /**
   * The challenge being attempted, by id, or null for the reader's own
   * design.
   *
   * Only the id is held: the brief itself is a module constant, and storing
   * a copy would let a challenge edited in source drift from one already in
   * progress. Its attempt is kept in the challenge store, and the live
   * mirror below is for handlers that run before React has re-rendered.
   */
  const [challengeId, setChallengeId] = useState<string | null>(boot.challengeId);
  const challengeLiveRef = useRef<string | null>(boot.challengeId);

  /**
   * The reader's own design, while a brief has the canvas. Kept in memory so
   * leaving puts back exactly what they left, and in storage, because the
   * session key is never written inside a brief, so it survives a reload.
   */
  const asideRef = useRef<Aside | null>(boot.aside);

  /**
   * Attempts and passes. Written through at once rather than from an effect:
   * switching workspace has to land the attempt being left before anything
   * else can run, or a reload in between would lose it.
   */
  const [chalStore, setChalStore] = useState<ChallengeStore>(boot.store);
  const chalStoreRef = useRef<ChallengeStore>(boot.store);
  const updateStore = useCallback((fn: (s: ChallengeStore) => ChallengeStore) => {
    // Read storage first: another tab may have recorded a pass or an attempt
    // since this one last looked, and writing the store from memory alone
    // would erase it. Which brief is open stays this tab's own.
    const base = mergeStored(chalStoreRef.current, loadChallengeStore(ALL_BRIEFS));
    const next = fn(base);
    if (
      next === chalStoreRef.current ||
      (next === base && JSON.stringify(base) === JSON.stringify(chalStoreRef.current))
    ) {
      return;
    }
    chalStoreRef.current = next;
    saveChallengeStore(next);
    setChalStore(next);
  }, []);
  // Another tab's writes show here too, so the picker's badges agree.
  // Storage is outside React, which is why this is an effect.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CHALLENGES_KEY) return;
      const next = mergeStored(chalStoreRef.current, loadChallengeStore(ALL_BRIEFS));
      chalStoreRef.current = next;
      setChalStore(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  // What boot chose (a brief resumed, a link followed, a brief left behind
  // by a share link) is written once it has been chosen.
  useEffect(() => {
    saveChallengeStore(chalStoreRef.current);
  }, []);

  /** Bumped when a brief is started by hand, to move focus to it. */
  const [panelFocus, setPanelFocus] = useState(0);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);

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
  /* Below the width where the islands fit on one row, the load island moves
     to a row of its own and GitHub moves into the menu (see useBarFit). */
  const barCompact = useBarFit(barRef, presenting ? PRESENT_MIN_SLIDER_PX : 0);

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
  /* Folded by an automatic fit that could not show the whole diagram beside
     it (see handleFitClipped). Kept apart from layout.library, so the
     reader's saved choice is never rewritten by it, and cleared by the next
     design or by the reader opening the rail. */
  const [railMadeRoom, setRailMadeRoom] = useState(false);
  /* With room for one rail (a tablet held upright, see oneRail.ts) the
     components rail starts closed for this visit. Kept apart from
     layout.library for the same reason as railMadeRoom. */
  const oneRail = useOneRail() && !phone;
  const [railFolded, setRailFolded] = useState(() => isOneRail() && !isPhone());
  const libraryWanted = layout.library && !railMadeRoom && !railFolded;

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

  /* Set by an add from the components rail, so the part it adds does not
     put the rail away where only one fits (see libraryShown). */
  const keepRailRef = useRef(false);
  useEffect(() => {
    const keep = keepRailRef.current;
    keepRailRef.current = false;
    if (selectedIds.size > 0 && !keep) setInspectorHidden(false);
  }, [selectedIds]);

  const toggleInspector = useCallback(() => setInspectorHidden((h) => !h), []);
  /* Tapping the part that is already selected brings its settings back. On a
     phone that is how a closed sheet is reopened: the selection never
     changed, so nothing else would. */
  const showInspector = useCallback(() => setInspectorHidden(false), []);

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
  /* Presenting puts both side panels away without touching the saved
     layout, so leaving it puts back whatever was open. */
  const inspectorVisible = hasSelection && !inspectorHidden && !presenting;
  const libraryOpen =
    !presenting && libraryShown(libraryWanted, oneRail, inspectorVisible);

  /**
   * Where the next component picked from the rail lands, set by the canvas
   * menu's "Add component here". Spent by that pick, and dropped when the
   * rail closes without one.
   */
  const addAtRef = useRef<{ x: number; y: number } | null>(null);

  const toggleLibrary = useCallback(() => {
    const open = libraryOpen;
    if (open) addAtRef.current = null;
    setLayout((l) => ({
      ...l,
      library: !open,
      metrics: !open && phone ? false : l.metrics,
    }));
    setRailMadeRoom(false);
    setRailFolded(false);
    if (phone || (oneRail && !open)) setInspectorHidden(true);
  }, [phone, oneRail, libraryOpen]);

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
   * Ordered by how often a student reaches for it: the learning path says
   * what to open next, an example is how most sessions start, the glossary
   * is what they need mid-run, and the shortcuts and settings are consulted
   * rarely. Bindings are printed here as well as in the shortcuts dialog,
   * so a key can be learned from the menu without opening a second thing to
   * read about the first.
   */
  const menuItems = useMemo(
    () => [
      {
        label: 'Learning path',
        icon: 'M3 19a3 3 0 1 0 6 0 3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
        onSelect: () => setPathOpen(true),
      },
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
        label: 'Can you break it?',
        icon: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
        ...(coarse ? {} : { hint: 'F' }),
        // A brief owns its faults and its check, so this waits for the
        // reader's own workspace.
        onSelect: () => {
          if (challengeLiveRef.current !== null) return;
          setBreakOpen(true);
          setIncidentId(null);
        },
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
              hint: shortcutLabel('Ctrl+/'),
              onSelect: () => setShortcutsOpen(true),
            },
          ]),
      {
        label: 'Settings',
        icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
        onSelect: () => setSettingsOpen(true),
      },
      /* The phone header has no room for the GitHub link, so it moves here
         rather than going missing. */
      ...(phone || barCompact
        ? [
            {
              label: 'Source on GitHub',
              icon: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
              onSelect: () => {
                window.open(SOURCE_URL, '_blank', 'noopener,noreferrer');
              },
            },
          ]
        : []),
    ],
    [openGlossary, coarse, phone, barCompact],
  );

  /**
   * The engine is a mutable simulation owned outside React's render cycle.
   * Held in state with a lazy initializer rather than a ref written during
   * render: the instance must exist for the very first render (so a snapshot
   * is available immediately), and this keeps the render phase pure. The
   * value is never replaced, so it behaves as a stable instance —
   * StrictMode's double render reuses the same engine.
   */
  const [engine] = useState(() => {
    const e = new Engine(initial.topology);
    /* `?warmup=` advances the simulation deterministically: fixed-size steps
       from the engine's own seed, no wall clock involved, so a deep link
       lands on a busy-but-stable frame. Same URL, same frame — the
       screenshot suite is built on this. */
    if (params.warmupMs > 0) {
      const steps = Math.ceil(params.warmupMs / WARMUP_STEP_MS);
      const stepMs = params.warmupMs / steps;
      for (let i = 0; i < steps; i += 1) e.advance(stepMs);
    }
    return e;
  });

  /**
   * Seeded from the engine's initial state rather than set by an effect, so
   * the very first paint already shows the loaded system instead of an empty
   * canvas followed by a second render.
   */
  const [snapshot, setSnapshot] = useState<SimSnapshot | null>(() => engine.snapshot());
  /**
   * Each client's own figures, read beside every snapshot. The engine keeps
   * them out of the snapshot so its bytes stay what replays pin, which is why
   * every place that publishes a snapshot publishes these with it.
   */
  const [routes, setRoutes] = useState<RouteStats[]>(() => engine.routes());

  /* The per-wire outcome counts behind the traffic dots and the canvas's
     retry and loss marks, which stay on with the dots turned off. The engine
     keeps them outside the snapshot, so they never change what a replay or
     a share link reproduces. */
  useEffect(() => {
    engine.setEdgeOutcomes(true);
  }, [engine]);
  const readOutcomes = useCallback(
    (edgeId: string, out: Float64Array) => engine.readEdgeOutcomes(edgeId, out),
    [engine],
  );

  // "Find the problem": the last answer, shown while it still applies.
  const [finding, setFinding] = useState<Finding | null>(null);
  const shownFinding = currentFinding(finding, topology, snapshot);

  /**
   * Live mirrors of the play/pause state. The rAF loop is started once and
   * reads these on each frame, so toggling pause never tears down and
   * rebuilds the loop (which would drop the accumulated frame timing).
   */
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  /* Play speed (speed.ts). A preference of this tab, not of the design: it
     is in no link and no saved file, and every load starts at 1x. The loop
     reads the ref; `slowAt` is the speed this machine really manages, shown
     only when it falls clearly short of the one asked for. */
  const [speed, setSpeedState] = useState<Speed>(1);
  const [slowAt, setSlowAt] = useState<number | null>(null);
  const speedRef = useRef<Speed>(1);
  const speedMeterRef = useRef(new SpeedMeter());
  const setSpeed = useCallback((next: Speed) => {
    speedRef.current = next;
    speedMeterRef.current.clear();
    setSpeedState(next);
    setSlowAt(null);
  }, []);

  /* A run held still to compare against (PinBar). Session only. */
  const [pinned, setPinned] = useState<PinnedRun | null>(null);

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
      const frameMs = Math.min(dt, MAX_FRAME_MS);
      const s = speedRef.current;
      if (s === 1) {
        engine.advance(frameMs);
      } else {
        const done = advanceAtSpeed(
          (d) => engine.advance(d),
          frameMs,
          s,
          () => performance.now(),
        );
        // At most once a second, and only when what is shown would change.
        const measured = speedMeterRef.current.add(done, frameMs);
        if (measured !== null) {
          const short = shortfall(s, measured);
          setSlowAt((prev) =>
            prev === short ||
            (prev !== null && short !== null && Math.abs(prev - short) < 0.05)
              ? prev
              : short,
          );
        }
      }

      // React re-renders at ~10Hz, not once per frame. The engine keeps
      // full temporal resolution regardless.
      sinceSnapshot += dt;
      if (sinceSnapshot >= SNAPSHOT_INTERVAL_MS) {
        sinceSnapshot = 0;
        setSnapshot(engine.snapshot());
        setRoutes(engine.routes());
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

  /* A live mirror of sharePending, for the workspace switch below, which
     runs inside handlers and has to know about a link opened this tick. */
  const sharePendingRef = useRef(sharePending);
  useLayoutEffect(() => {
    sharePendingRef.current = sharePending;
  }, [sharePending]);

  useEffect(() => {
    // A share link is still being decoded, or has just been opened and not
    // yet edited. Writing here would overwrite the recipient's own saved
    // design with someone else's before they had touched anything. A URL
    // preset (?preset=...) holds the write on the same policy.
    if ((sharePending || urlPreset) && challengeId === null) return;
    // Debounced: dragging a node or a slider must not write on every frame.
    // Between a change and the write, the work genuinely is not saved yet,
    // and the indicator says so rather than reassuring early.
    setSaveState('saving');
    const id = window.setTimeout(() => {
      // Inside a brief the canvas is the brief's, and it is saved as its
      // attempt. The reader's own design is never written from here.
      const brief = challengeId ? challengeById(challengeId) : undefined;
      if (brief) updateStore((s) => withAttempt(s, brief, topology));
      else saveSession({ topology, rps, presetId });
      setSaveState('saved');
    }, 400);
    return () => window.clearTimeout(id);
  }, [topology, rps, presetId, sharePending, challengeId, urlPreset, updateStore]);

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
        onChange: (edited) => {
          setHistVersion((v) => v + 1);
          // An entry landing is the definition of "the reader changed
          // something", so it is also the moment a design opened from a
          // share link or a URL preset stops being someone else's and
          // starts being theirs. Saving resumes from here; see both flags.
          // An Undo with nothing to undo changed nothing, so it must not.
          if (edited) {
            setSharePending((p) => (p ? false : p));
            setUrlPreset(false);
          }
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
    challengeId: boot.challengeId,
  });
  // Layout effect, not a passive one: the mirror must be current before the
  // NEXT event handler runs (a pointerup reading the final drag position),
  // and passive effects offer no such ordering guarantee.
  useLayoutEffect(() => {
    snapRef.current = { topology, selectedIds, rps, presetId, challengeId };
  }, [topology, selectedIds, rps, presetId, challengeId]);

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
  const [toast, setToast] = useState<{
    text: string;
    id: number;
    /** A button in the toast, such as Undo after a delete. */
    action?: { label: string; run: () => void };
  } | null>(null);
  const toastSeq = useRef(0);
  useEffect(() => {
    if (!toast) return;
    // Long enough to reach for the button when there is one.
    const t = window.setTimeout(() => setToast(null), toast.action ? 5000 : 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

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
  /* Presenting frees the width the panels held, so the diagram is fitted
     again to fill it, and again on the way out. */
  /* Two frames late: the bar grows with the mode's larger figures, and the
     clearance the fit frames under is measured from it a frame after. */
  useEffect(() => {
    presentChangeRef.current = () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setFitNonce((n) => n + 1)),
      );
    };
  }, []);

  /**
   * The challenge sheet's size, kept in the uncovered-canvas sentinel.
   *
   * On a phone the brief is a sheet over the foot of the canvas, and the
   * part of the canvas above it is all the student has to look at. A fixed
   * guess at its height framed the diagram partly under it. The measured
   * height goes straight onto the sentinel's parent as --chal-sheet-h, which
   * the sentinel inherits (read by the phone rule in Challenge.css) rather than through React state, so a
   * resize refit already queued for the next frame measures the new rect.
   *
   * Folding or opening the sheet, or its first measurement on a new start
   * or a ?challenge= link, also re-frames the diagram: the room above the
   * sheet is what changed, and the diagram should fill it. Text growing
   * inside an open sheet (a hint, a verdict) updates the rect without
   * moving the camera, the way every other panel does. A desktop never
   * re-frames here: the panel sits beside the diagram there, not under it.
   */
  const sheetShutRef = useRef<boolean | null>(null);
  const phoneRef = useRef(phone);
  useLayoutEffect(() => {
    phoneRef.current = phone;
  }, [phone]);
  const handleSheetResize = useCallback((height: number | null, shut: boolean) => {
    if (height === null) {
      // The panel went away. The next one is a new sheet to frame above.
      sheetShutRef.current = null;
      return;
    }
    // On the stage, so the sentinel and the canvas chrome beside it ("What
    // just happened", above the sheet on a phone) both inherit it.
    stageSafeRef.current?.parentElement?.style.setProperty(
      '--chal-sheet-h',
      `${height}px`,
    );
    const was = sheetShutRef.current;
    sheetShutRef.current = shut;
    if (phoneRef.current && was !== shut) setFitNonce((n) => n + 1);
  }, []);

  /**
   * Move between the reader's workspace and a brief's, or between briefs.
   *
   * The workspace being left is saved now rather than by the debounced
   * autosave, which the switch would cancel: an edit made a moment before
   * starting a brief would otherwise be lost to a reload. Entering a brief
   * from the reader's own design sets that design aside; going back to the
   * reader's workspace by any route ends the aside, because what is on the
   * canvas then is theirs. An aside that was a share link they had not
   * touched goes back to not being saved over their own design, whichever
   * route ends it: Leave, opening something else, or an undo past the start.
   */
  const switchWorkspace = useCallback(
    (to: string | null) => {
      const from = challengeLiveRef.current;
      if (from === to) return;
      const out = snapRef.current;
      const leaving = from ? challengeById(from) : undefined;
      if (leaving) {
        updateStore((s) => withAttempt(s, leaving, topoLiveRef.current));
      } else if (!sharePendingRef.current) {
        saveSession({
          topology: topoLiveRef.current,
          rps: out.rps,
          presetId: out.presetId,
        });
      }
      if (from === null) {
        asideRef.current = {
          topology: topoLiveRef.current,
          rps: out.rps,
          presetId: out.presetId,
          shared: sharePendingRef.current,
          stamp: storedSessionRaw(),
        };
        // The canvas is no longer the link's, and boot puts a link first.
        dropShareLink();
      }
      if (to === null) {
        // Set after any commit the caller made first, which clears it.
        if (asideRef.current?.shared) {
          sharePendingRef.current = true;
          setSharePending(true);
        }
        asideRef.current = null;
      }
      updateStore((s) => withActive(s, to));
      challengeLiveRef.current = to;
      setChallengeId(to);
    },
    [updateStore],
  );

  /**
   * Put a whole design on the canvas and start its run from the beginning.
   * Not a history entry by itself; the callers decide that.
   */
  const installDesign = useCallback(
    (fresh: Topology, fit: boolean) => {
      setTopology(fresh);
      setSelectedIds(new Set<string>());
      topoLiveRef.current = fresh;
      engine.setTopology(asReplacement(fresh));
      engine.reset();
      resetLostRate();
      setSnapshot(engine.snapshot());
      setRoutes(engine.routes());
      // An answer read from the run that just ended would carry its numbers.
      setFinding(null);
      if (fit) {
        setFitNonce((n) => n + 1);
        setRailMadeRoom(false);
      }
    },
    [engine, resetLostRate],
  );

  const applyEntry = useCallback(
    (entry: HistoryEntry, verb: 'Undid' | 'Redid') => {
      if (entry.fault) {
        // Already applied to the engine by applyFault. Only the selection
        // comes back, so the panel shows the part that just changed.
      } else if (entry.challengeId !== challengeLiveRef.current) {
        // Into a brief or out of one. That is a different workspace, and its
        // run starts again from the top, the way starting or leaving does,
        // so a brief's faults land when it says they do.
        switchWorkspace(entry.challengeId);
        installDesign(entry.topology, true);
      } else if (entry.replaces) {
        // Undoing a load or a watched run puts the design back with its own
        // faults and seed, from the top, the way the load itself started.
        // The view refits only when the boxes are not the ones on screen.
        const now = snapRef.current.topology.nodes;
        const same =
          now.length === entry.topology.nodes.length &&
          now.every((n, i) => n.id === entry.topology.nodes[i]!.id);
        installDesign(entry.topology, !same);
      } else {
        // The engine first, via the same non-resetting paths a forward edit
        // uses: updateNodeConfig for a config-only difference, setTopology
        // for structure. Nothing here resets the simulation or its metrics.
        // The fault schedule is what happened during the run, not part of
        // the design, so undo and redo carry the live one forward rather
        // than rolling recordings back to whatever the entry was captured
        // with.
        const live = topoLiveRef.current.faults;
        const target: Topology = live
          ? { ...entry.topology, faults: live }
          : entry.topology;
        syncEngine(engine, snapRef.current.topology, target);
        const synced = withSchedule(target, engine.faultSchedule());
        topoLiveRef.current = synced;
        setTopology(synced);
      }
      setSelectedIds(new Set(entry.selectedIds));
      if (!entry.fault) {
        setRps(entry.rps);
        setPresetId(entry.presetId);
      }
      toastSeq.current += 1;
      setToast({ text: `${verb} ${entry.label}`, id: toastSeq.current });
    },
    [engine, switchWorkspace, installDesign],
  );

  /**
   * Undo or redo of a fault control, on the engine. A fault entry from
   * another workspace is skipped: that run was replaced when the workspace
   * changed, and its node may not exist here. The schedule is mirrored into
   * the topology the way recordedFault does it after a press.
   */
  const applyFault = useCallback<FaultApplier>(
    (entry, dir) => {
      if (entry.challengeId !== challengeLiveRef.current) return null;
      const next = applyFaultChange(
        engine,
        entry.fault,
        dir,
        engine.snapshot().system.timeMs,
        (faults) => engine.setTopology({ ...topoLiveRef.current, faults }),
      );
      if (!next) return null;
      const faults = engine.faultSchedule();
      setTopology((t) => ({ ...t, faults }));
      setSnapshot(engine.snapshot());
      setRoutes(engine.routes());
      return next;
    },
    [engine],
  );

  const handleUndo = useCallback(() => {
    const entry = history.undo(snapRef.current, applyFault);
    if (entry) applyEntry(entry, 'Undid');
  }, [history, applyEntry, applyFault]);

  const handleRedo = useCallback(() => {
    const entry = history.redo(snapRef.current, applyFault);
    if (entry) applyEntry(entry, 'Redid');
  }, [history, applyEntry, applyFault]);

  /* ---------------- structural edits ---------------- */

  /**
   * Structural changes (add/remove nodes or edges, moves) must be pushed
   * into the engine wholesale. The engine preserves per-node state for ids
   * it already knows, so editing the graph does not disturb in-flight work.
   */
  const applyTopology = useCallback(
    (raw: Topology) => {
      // Inside a brief, a node added or pasted runs with the brief's fixed
      // fields and the clients share its load, exactly as the check will run
      // them; see conform.
      const brief = challengeLiveRef.current
        ? challengeById(challengeLiveRef.current)
        : undefined;
      const edit = brief ? conform(brief, raw) : raw;
      engine.setTopology(edit);
      const next = withSchedule(edit, engine.faultSchedule());
      topoLiveRef.current = next;
      setTopology(next);
      // Refresh the snapshot immediately so a topology edit made while PAUSED
      // shows the new node's readouts at once, instead of blank rows sitting
      // next to headline numbers from the previous run until the next tick.
      setSnapshot(engine.snapshot());
      setRoutes(engine.routes());
      setPresetId(null);
    },
    [engine],
  );

  /**
   * Packet loss on one connection. A setting, like a node's config, so the
   * example stays selected; but edges live in the topology, so the engine
   * takes the whole graph.
   */
  const handleEdgeLoss = useCallback(
    (edgeId: string, lossRate: number) => {
      const next = withEdgeLoss(topoLiveRef.current, edgeId, lossRate);
      if (!next) return;
      history.commit('packet loss', snapRef.current);
      topoLiveRef.current = next;
      setTopology(next);
      engine.setTopology(next);
      setSnapshot(engine.snapshot());
      setRoutes(engine.routes());
    },
    [engine, history],
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

  /** A part dragged from the components rail onto the canvas. */
  const handleDropNode = useCallback(
    (kind: NodeKind, x: number, y: number) => {
      addAtRef.current = null;
      if (oneRail && libraryOpen) keepRailRef.current = true;
      handleAddNode(kind, x, y);
    },
    [handleAddNode, oneRail, libraryOpen],
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
      if (oneRail && libraryOpen) keepRailRef.current = true;
      const centre = addAtRef.current ?? viewCenterRef.current?.();
      addAtRef.current = null;
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
    [handleAddNode, topology.nodes, oneRail, libraryOpen],
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
      // No confirm before a delete; the toast offers the undo instead.
      if (nodeIds.length > 0) {
        const only =
          nodeIds.length === 1 ? topology.nodes.find((n) => n.id === nodeIds[0]) : null;
        // Only while the delete is still the last thing done: a later edit,
        // settled or still settling, would be what Undo took back.
        const entry = history.lastEntry;
        toastSeq.current += 1;
        setToast({
          text: only ? `Deleted ${only.label}` : `Deleted ${nodeIds.length} components`,
          id: toastSeq.current,
          action: {
            label: 'Undo',
            run: () => {
              if (!history.settling && history.lastEntry === entry) handleUndo();
              else setToast(null);
            },
          },
        });
      }
    },
    [applyTopology, setAnnotations, topology, history, handleUndo],
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
  const duplicateIds = useCallback(
    (ids: ReadonlySet<string>) => {
      const sub = selectionSubgraph(topology, ids);
      if (!sub) return;
      // ONE entry for the whole duplicate, selection included.
      history.commit('duplicate', snapRef.current);
      appendClones(cloneSubgraph(sub, topology, GRID * 2, GRID * 2));
    },
    [topology, history, appendClones],
  );
  const handleDuplicate = useCallback(
    () => duplicateIds(selectedIds),
    [duplicateIds, selectedIds],
  );

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

  /* ---------------- context menu ---------------- */

  /**
   * The last thing copied in this tab, beside the system clipboard. Paste
   * here reads it first: reading the system clipboard on a phone raises a
   * permission prompt, and on some browsers it is not allowed at all.
   */
  const [copied, setCopied] = useState<string | null>(null);

  /** Copy from the menu or the inspector, where there is no copy event. */
  const handleCopyIds = useCallback(
    (ids: readonly string[]) => {
      const text = buildClipboardText(topology, new Set(ids));
      if (!text) return;
      setCopied(text);
      // Best effort, so Ctrl+V in another tab finds it too.
      void navigator.clipboard?.writeText(text).catch(() => {});
      const only =
        ids.length === 1 ? topology.nodes.find((n) => n.id === ids[0]) : null;
      const what = only ? only.label : `${ids.length} components`;
      toastSeq.current += 1;
      setToast({
        text: coarse
          ? `Copied ${what}. Press and hold the canvas to paste.`
          : `Copied ${what}. ${shortcutLabel('Ctrl+V')} pastes at the pointer.`,
        id: toastSeq.current,
      });
    },
    [topology, coarse, setCopied],
  );

  const handleCopySelection = useCallback(
    () =>
      handleCopyIds(
        topology.nodes.filter((n) => selectedIds.has(n.id)).map((n) => n.id),
      ),
    [handleCopyIds, topology.nodes, selectedIds],
  );

  const handlePasteAt = useCallback(
    async (at: { x: number; y: number }) => {
      let text = copied;
      if (!text && navigator.clipboard?.readText) {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          text = null;
        }
      }
      const sub = text ? parseClipboardText(text) : null;
      if (!sub) {
        toastSeq.current += 1;
        setToast({
          text: 'Nothing to paste yet. Copy a component first.',
          id: toastSeq.current,
        });
        return;
      }
      handlePaste(sub, at);
    },
    [copied, handlePaste],
  );

  const [menu, setMenu] = useState<{ req: CanvasMenuRequest; seq: number } | null>(
    null,
  );
  const menuSeq = useRef(0);
  const menuApiRef = useRef<CanvasMenuApi | null>(null);
  const handleCanvasMenu = useCallback((req: CanvasMenuRequest | null) => {
    menuSeq.current += 1;
    setMenu(req ? { req, seq: menuSeq.current } : null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const menuActions = useMemo<CanvasMenuActions>(
    () => ({
      inspect: (ids) => {
        if (ids.length !== selectedIds.size || ids.some((id) => !selectedIds.has(id))) {
          setSelectedIds(new Set(ids));
        }
        showInspector();
      },
      duplicate: (ids) => duplicateIds(new Set(ids)),
      copy: handleCopyIds,
      connect: (id, keyboard) => menuApiRef.current?.startLink(id, keyboard),
      remove: (nodeIds, edgeIds) => handleDeleteSelection(nodeIds, edgeIds),
      setLoss: handleEdgeLoss,
      paste: (at) => void handlePasteAt(at),
      add: (at) => {
        addAtRef.current = at;
        if (!libraryOpen) toggleLibrary();
        toastSeq.current += 1;
        setToast({ text: 'Pick a component and it lands here.', id: toastSeq.current });
      },
      fit: () => menuApiRef.current?.fitAll(),
    }),
    [
      selectedIds,
      showInspector,
      duplicateIds,
      handleCopyIds,
      handleDeleteSelection,
      handleEdgeLoss,
      handlePasteAt,
      libraryOpen,
      toggleLibrary,
    ],
  );

  /* ---------------- live config edits ---------------- */

  /**
   * The patch without the fields a brief holds still on this node. The
   * inspector already shows them as fixed; this is the same rule at the
   * point the change lands, so no other path can move one either.
   */
  const unlocked = useCallback(
    (id: string, patch: Partial<NodeConfig>): Partial<NodeConfig> => {
      const brief = challengeLiveRef.current
        ? challengeById(challengeLiveRef.current)
        : undefined;
      const node = brief
        ? topoLiveRef.current.nodes.find((n) => n.id === id)
        : undefined;
      if (!brief || !node) return patch;
      const fixed = lockedFieldsFor(brief, node.kind);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) if (!fixed.includes(k)) out[k] = v;
      return out as Partial<NodeConfig>;
    },
    [],
  );

  /**
   * Knob changes are applied to the running engine in place. No reset: the
   * whole point is watching the system respond to a change under load.
   */
  const handleConfigChange = useCallback(
    (id: string, asked: Partial<NodeConfig>) => {
      const patch = unlocked(id, asked);
      if (Object.keys(patch).length === 0) return;
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
    [engine, history, unlocked],
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
    (ids: readonly string[], asked: Partial<NodeConfig>) => {
      const patches = new Map<string, Partial<NodeConfig>>();
      for (const id of ids) {
        const patch = unlocked(id, asked);
        if (Object.keys(patch).length > 0) patches.set(id, patch);
      }
      if (patches.size === 0) return;
      history.touch('setting change', snapRef.current);
      for (const [id, patch] of patches) engine.updateNodeConfig(id, patch);
      setTopology((t) => ({
        ...t,
        nodes: t.nodes.map((n) => {
          const patch = patches.get(n.id);
          return patch ? { ...n, config: { ...n.config, ...patch } } : n;
        }),
      }));
      // No slider sync needed: the header derives offered load from the
      // topology, so editing any client's rps here updates it for free.
    },
    [engine, history, unlocked],
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
      // A brief states its load and is judged at it. The slider is held
      // still while one is open; this is the same rule where it lands.
      if (challengeLiveRef.current !== null) return;
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
   * Go from a brief back to the reader's own workspace, as one history
   * entry, and return the design that comes back. The caller puts it, or
   * whatever it is replacing it with, on the canvas.
   */
  const leaveBrief = useCallback((): Aside => {
    const held = asideRef.current;
    const stored = storedSessionRaw();
    // Newer work saved in another tab wins over the copy held here, which
    // would otherwise be written back over it.
    const back =
      held !== null && (stored === null || stored === held.stamp)
        ? held
        : { ...loadSession(), shared: false, stamp: stored };
    asideRef.current = back;
    history.commit('leave challenge', snapRef.current);
    switchWorkspace(null);
    return back;
  }, [history, switchWorkspace]);

  /**
   * Replace the whole design, as one history entry.
   *
   * Loading an example and opening a file are the same act from the
   * student's side: the diagram they were looking at is gone and another
   * one is in its place. They share this so they can never drift into
   * disagreeing about what "replace" means, and in particular so an
   * imported design is undoable on exactly the terms an example load is.
   * The caller owns the copy it passes; this takes it as given. Returns
   * whether it left a brief to do it, so the caller can say that the
   * reader's own design is what was replaced.
   */
  const replaceDesign = useCallback(
    (
      fresh: Topology,
      nextPresetId: string | null,
      label: string,
      /**
       * The brief the new design belongs to, or null for the reader's own
       * workspace. Null is the default on purpose: opening a saved design, a
       * file or an example is the reader choosing what is on their canvas,
       * and doing it from inside a brief leaves the brief.
       */
      nextChallengeId: string | null = null,
      nextRps: number = clientRps(fresh),
    ): boolean => {
      // Opening something of the reader's own from inside a brief goes back
      // to their design first, as Leave does, and replaces it from there, the
      // same as opening it from their own workspace would. So one undo
      // brings their design back rather than the brief, and the design set
      // aside is never dropped without having been put back.
      let before = snapRef.current;
      const leaving = nextChallengeId === null && challengeLiveRef.current !== null;
      if (leaving) {
        const back = leaveBrief();
        before = {
          topology: back.topology,
          selectedIds: new Set<string>(),
          rps: back.rps,
          presetId: back.presetId,
          challengeId: null,
        };
      }
      // ONE entry, captured before the load, so a student who replaces a
      // half-built system can undo back to what they had.
      history.commit(label, before, true);
      switchWorkspace(nextChallengeId);
      setRps(nextRps);
      setPresetId(nextPresetId);
      installDesign(fresh, true);
      return leaving;
    },
    [history, switchWorkspace, installDesign, leaveBrief],
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
      const left = replaceDesign(structuredClone(saved.topology), null, 'open design');
      toastSeq.current += 1;
      setToast({
        text: left ? `Opened ${saved.name} ${IN_PLACE}` : `Opened ${saved.name}`,
        id: toastSeq.current,
      });
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
      setToast({
        text: 'That file could not be read. Choose a backup file saved from Breakscale (.json).',
        id: toastSeq.current,
      });
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
      // mutated by editing the loaded system. Loading an example by hand
      // leaves any brief behind, because the example is now the reader's
      // own design; the brief's attempt is kept for when they come back.
      const left = replaceDesign(
        structuredClone(preset.topology),
        preset.id,
        'example load',
      );
      setExampleRun((n) => n + 1);
      if (left) {
        toastSeq.current += 1;
        setToast({ text: `Opened ${preset.name} ${IN_PLACE}`, id: toastSeq.current });
      }
    },
    [replaceDesign],
  );

  const say = useCallback((text: string) => {
    toastSeq.current += 1;
    setToast({ text, id: toastSeq.current });
  }, []);

  /* A design opened too wide for the canvas beside the components rail,
     even at the lowest zoom a card still says what it is at. The rail folds
     for this design and the fit runs again; the reader is told, once, how
     to get it back. A phone's rail is a sheet that starts closed. */
  const handleFitClipped = useCallback(() => {
    if (phone || !libraryOpen) return;
    setRailMadeRoom(true);
    setFitNonce((n) => n + 1);
    say(
      coarse
        ? 'Hid components to fit the diagram. The button at the top left shows them.'
        : 'Hid components to fit the diagram. Press C to show them.',
    );
  }, [phone, libraryOpen, coarse, say]);
  // Once, for what boot did before there was a toast to say it with.
  const bootNotice = boot.notice;
  useEffect(() => {
    if (bootNotice) say(bootNotice);
  }, [bootNotice, say]);

  /**
   * Start a brief, or go back to one already started.
   *
   * No confirm. The reader's design is not replaced, only set aside, and it
   * comes back exactly as it was when they leave, so there is nothing to
   * warn them about. The toast says where it went, once, so the canvas
   * changing under them is never a mystery.
   */
  const handleStartChallenge = useCallback(
    (id: string) => {
      const brief = challengeById(id);
      if (!brief) return;
      setPanelFocus((n) => n + 1);
      if (challengeLiveRef.current === id) return;
      const fromOwn = challengeLiveRef.current === null;
      const attempt = attemptFor(chalStoreRef.current, brief);
      const topo = attempt ? structuredClone(attempt.topology) : freshStart(brief);
      replaceDesign(topo, brief.presetId, 'challenge start', id);
      if (attempt) say('Picked up where you left off.');
      else if (fromOwn) say('Your design is set aside. It comes back when you leave.');
    },
    [replaceDesign, say],
  );

  const challenge = challengeId ? challengeById(challengeId) : undefined;

  /**
   * The starting points a cleared canvas offers. None inside a brief: each
   * of them would leave it. One server loads through handleLoadPreset, so it
   * is one undoable entry and the preset's snapshots are the ones it always
   * had.
   */
  const emptyActions = useMemo(() => {
    if (challenge) return undefined;
    const simple = PRESETS.find((p) => p.id === 'single-server');
    return {
      onStartSimple: () => {
        if (simple) handleLoadPreset(simple);
      },
      onBrowseExamples: () => setExamplesOpen(true),
      onTryChallenge: () => setChallengesOpen(true),
    };
  }, [challenge, handleLoadPreset]);

  /**
   * Leave the brief and put the reader's design back exactly as it was. Not
   * only on a pass: giving up is leaving too, and the attempt stays for
   * whenever they want another go.
   */
  const handleLeaveChallenge = useCallback(() => {
    if (challengeLiveRef.current === null) return;
    const back = leaveBrief();
    setRps(back.rps);
    setPresetId(back.presetId);
    installDesign(structuredClone(back.topology), true);
    say('Back to your design.');
    menuBtnRef.current?.focus();
  }, [leaveBrief, installDesign, say]);

  const handleStartOver = useCallback(() => {
    if (!challenge) return;
    replaceDesign(
      freshStart(challenge),
      challenge.presetId,
      'start over',
      challenge.id,
    );
  }, [challenge, replaceDesign]);

  const next = challenge ? nextChallenge(CHALLENGES, challenge.id) : null;
  const handleNextChallenge = useCallback(() => {
    if (next) handleStartChallenge(next.id);
  }, [next, handleStartChallenge]);

  /** Record a pass the moment a check finds one. Not on Done. */
  const handleVerdict = useCallback(
    (verdict: Verdict, brief: Challenge) => {
      if (verdict.status !== 'passed') return;
      updateStore((s) =>
        withPass(s, brief, attemptFor(s, brief)?.hintsShown ?? 0, new Date()),
      );
      // On a phone the inspector's sheet covers the brief's. The pass is what
      // the reader was working for, so the inspector steps down for it; the
      // selection stays, and tapping the part brings its settings back.
      if (phoneRef.current) setInspectorHidden(true);
    },
    [updateStore],
  );

  const check = useChallengeCheck(challenge, topology, handleVerdict);

  const handleHint = useCallback(() => {
    if (!challenge) return;
    updateStore((s) =>
      withHints(
        s,
        challenge,
        (attemptFor(s, challenge)?.hintsShown ?? 0) + 1,
        topoLiveRef.current,
      ),
    );
  }, [challenge, updateStore]);

  /**
   * Put one of the check's runs on the canvas and play it from the start.
   *
   * The configs, faults and seed are the run's; where each box sits and
   * what the reader wrote on the canvas are theirs, so watching does not
   * move anything. The design key comes out the same, so the verdict stays
   * the one on screen.
   */
  const handleWatchRun = useCallback(
    (seed: number) => {
      if (check?.view.status !== 'verdict') return;
      const verdict = check.view.verdict;
      if (!('runs' in verdict)) return;
      const run = verdict.runs.find((r) => r.seed === seed) ?? verdict.deciding;
      const configs = new Map(run.replay.nodes.map((n) => [n.id, n.config]));
      const t = topoLiveRef.current;
      const faults = run.replay.faults ?? [];
      const watch: Topology = {
        nodes: t.nodes.map((n) => ({ ...n, config: configs.get(n.id) ?? n.config })),
        edges: t.edges,
        ...(t.annotations ? { annotations: t.annotations } : {}),
        ...(faults.length > 0 ? { faults } : {}),
        seed: run.seed,
      };
      history.commit('watch run', snapRef.current, true);
      installDesign(watch, false);
      setRunning(true);
      runningRef.current = true;
    },
    [check, history, installDesign],
  );

  /* The live reading. Recomputed per snapshot rather than on a timer, so the
     panel and the numbers it quotes always come from the same tick. It is
     only ever shown as live: the check is what passes. */
  const live = useMemo(
    () => (challenge && snapshot ? evaluate(challenge, snapshot, routes) : null),
    [challenge, snapshot, routes],
  );

  /** A design key for the brief as it starts, to know when Start over does anything. */
  const freshKey = useMemo(
    () =>
      challenge
        ? designKey(
            challenge,
            judgedTopology(challenge, freshStart(challenge)).topology,
          )
        : '',
    [challenge],
  );

  /** A node's name as the brief starts, else as it is now, else its id. */
  const nameOf = useCallback(
    (id: string) => {
      const from = challenge
        ? startDesign(challenge).nodes.find((n) => n.id === id)
        : undefined;
      return (
        from?.label ?? topoLiveRef.current.nodes.find((n) => n.id === id)?.label ?? id
      );
    },
    [challenge],
  );

  const lockedFor = useCallback(
    (kind: NodeKind): readonly string[] =>
      challenge ? lockedFieldsFor(challenge, kind) : [],
    [challenge],
  );

  const badgeOf = useCallback((c: Challenge) => badgeFor(chalStore, c), [chalStore]);
  // First visit only. An edit clears presetId, so only another example ends it.
  const tourSubject = selectedNodes.length === 1 ? selectedNodes[0]!.id : null;
  const tour = useTour(
    !challenge && (presetId === null || presetId === PRESETS[0]!.id),
    topology,
    snapshot,
    tourSubject,
  );
  // A brief's canvas carries its example's id; that is not the example run.
  const exampleTask = useExampleTask(
    challengeId ? null : presetId,
    exampleRun,
    topology,
    snapshot,
  );
  const taskView = exampleTask.view;
  // An example is done when its task is. A finished tour broke and fixed
  // the first example, so it counts too.
  const explored = usePathProgress(
    tour.open && tour.stage.kind === 'fixed'
      ? PRESETS[0]!.id
      : taskView.kind === 'live' && taskView.done
        ? taskView.task.presetId
        : null,
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
        setToast({
          text: 'The picture could not be saved. Try again, or save the design to a file.',
          id: toastSeq.current,
        });
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
      const left = replaceDesign(result.topology, null, 'file import');
      setImportError(null);
      toastSeq.current += 1;
      const opened = result.name ? `Opened ${result.name}` : 'Opened design';
      setToast({ text: left ? `${opened} ${IN_PLACE}` : opened, id: toastSeq.current });
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
        // Opens in the reader's own workspace, never in a brief's. Boot
        // already chose that whenever a link is on the URL; this is the same
        // rule where the link lands, so nothing can open one into a brief.
        switchWorkspace(null);
        setRps(clientRps(result.topology));
        setPresetId(null);
        installDesign(result.topology, true);
        toastSeq.current += 1;
        // A replay opens like any shared design, at t=0 with the clock
        // running, and its faults land at the moments they were recorded.
        setToast({
          text: hasReplay(result.topology)
            ? 'Opened a replay. It plays from the start, and each fault lands at the same moment it did in the original run.'
            : 'Opened a shared design',
          id: toastSeq.current,
        });
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
  }, [switchWorkspace, installDesign]);

  /* The address bar says what is open: `?challenge=<id>` inside a brief,
     `?example=<id>` while an example is open and unchanged, which an edit
     ends by clearing presetId. Entering or leaving a brief is a step Back
     can undo, so it pushes; the example only ever replaces, since a Back
     press that quietly took an example off the canvas would be a surprise.
     A share link on screen keeps its own URL. The location is outside
     React, which is why this is an effect. */
  const routedChallenge = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    try {
      const linked = shareHashPresent();
      if (sharePending && linked) return;
      const href = window.location.href;
      const example = challengeId === null ? presetId : null;
      const next = routedHref(href, {
        challengeId,
        exampleId: example,
        dropShare: example !== null && linked,
      });
      const moved =
        routedChallenge.current !== undefined &&
        routedChallenge.current !== challengeId;
      routedChallenge.current = challengeId;
      if (next === href) return;
      if (moved) window.history.pushState(null, '', next);
      else window.history.replaceState(window.history.state, '', next);
    } catch {
      // A locked-down location: the address stays as it was.
    }
  }, [challengeId, presetId, sharePending]);

  /* An `?example=<id>` link opens that example, through the same undoable
     load as the picker, unless a share link or a brief's link is on the URL
     too: those go first, as boot puts them first. Read at mount, before
     the effect above rewrites the query. */
  const [linkedExample] = useState(() => {
    try {
      if (shareHashPresent() || challengeParam(window.location.search)) return null;
      const id = exampleParam(window.location.search);
      return PRESETS.find((p) => p.id === id) ?? null;
    } catch {
      // No DOM (a test importing App): no link to follow.
      return null;
    }
  });
  const followedExample = useRef(false);
  useEffect(() => {
    if (!linkedExample || followedExample.current) return;
    followedExample.current = true;
    const own = snapRef.current;
    if (own.challengeId === null && own.presetId === linkedExample.id) return;
    handleLoadPreset(linkedExample);
    // From a brief, the load has said so itself. From the reader's own
    // design it says how to get that back; a fresh example needs no word.
    if (own.challengeId === null && own.presetId === null) {
      say(`Opened ${linkedExample.name}. Undo brings your design back.`);
    }
  }, [linkedExample, handleLoadPreset, say]);

  /* Back and Forward through a brief. The URL has already moved; this
     moves the canvas to match, by the same paths the buttons use. */
  useEffect(() => {
    const onPop = () => {
      let id: string | null = null;
      try {
        id = challengeParam(window.location.search);
      } catch {
        return;
      }
      const want = id && challengeById(id) ? id : null;
      if (want === challengeLiveRef.current) return;
      if (want) handleStartChallenge(want);
      else handleLeaveChallenge();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [handleStartChallenge, handleLeaveChallenge]);

  const handleCopyChallengeLink = useCallback(() => {
    if (!challengeId) return;
    let link: string;
    try {
      link = challengeLink(window.location.href, challengeId);
    } catch {
      return;
    }
    const failed = () => say('Could not copy the link. It is in the address bar.');
    try {
      void navigator.clipboard
        .writeText(link)
        .then(() => say('Copied a link to this challenge.'), failed);
    } catch {
      failed();
    }
  }, [challengeId, say]);

  /**
   * Open the share dialog without building anything. The design is only
   * uploaded once the reader asks for a link, so looking is free and a
   * store write always follows a deliberate click.
   */
  const handleOpenShare = useCallback(() => {
    setShareRun(null);
    setShareSession((n) => n + 1);
    setShareOpen(true);
  }, []);

  /**
   * Build the link. Goes to the store first, which is what keeps the URL
   * short whatever the design; where there is no store, or it cannot be
   * reached, the fragment format still carries the whole design.
   *
   * A plain link is the design alone. A replay link is the run: the design
   * with the engine's seed and fault schedule, so whoever opens it watches
   * the same faults land at the same simulated moments.
   */
  const handleBuildLink = useCallback(
    async (kind: ShareKind): Promise<ShareResult> => {
      const replay = kind === 'run';
      // Captured at the click, before the await: the run keeps going while
      // the dialog is open, and the link is the run as it was when asked for.
      // A break opened from the break-it panel is the run this dialog links.
      const shared = replay
        ? (shareRun ?? replayTopology(topology, engine))
        : designTopology(topology);
      try {
        return { ok: true, url: await buildLink(shared, window.location.href) };
      } catch (e) {
        // A design that does not fit is told about, never trimmed to fit.
        // The file export carries any size.
        return {
          ok: false,
          message:
            e instanceof ShareStoreError
              ? e.message
              : e instanceof ShareLinkTooLargeError
                ? `This ${replay ? 'run' : 'design'} is too big for a link (${e.chars} characters; links stop working past ${e.limit}). Save it to a file instead.`
                : 'Could not build the link.',
        };
      }
    },
    [engine, topology, shareRun],
  );

  /* ---------------- can you break it? ---------------- */

  const breakShown = breakOpen && !challenge;
  /** The real incident whose panel shows. Never inside a brief. */
  const incident = incidentId && !challenge ? incidentById(incidentId) : undefined;
  /* The tour's card and the break panel share the column under the bar, so
     the tour steps aside while the panel is open and comes back where it
     was when it closes. Hidden, not ended: its first step says to break it
     on purpose, and that is not a reason to lose it. An incident's panel
     takes the same room. */
  const tourShown = tour.open && !breakShown && !incident;
  /* The task card takes the tour's corner, so it waits for the tour, and
     for the panels that take the same column. */
  const taskShown =
    taskView.kind !== 'none' && !challenge && !tour.open && !breakShown && !incident;
  const taskOpen = taskShown && !taskView.hidden && !(phone && inspectorVisible);
  /* A brief, an outage or a task card takes a corner of the canvas as it
     opens, so the diagram is framed again in what is left. Loading a design
     frames it already; this is for the card that comes after, as the task
     card does once the first-visit tour is skipped, when it covered the
     very part its steps were about.

     On a narrow window it also closes the components rail, so the diagram
     has the room between them. Once, as each one opens: a rail opened again
     after that is the student's choice. A phone's rail is a sheet that is
     already shut.

     A task is keyed by its load, and the last guide framed is remembered
     across none: a delete hides the task card and undo brings the same one
     back, and add, delete and undo never move the camera. */
  const crowded = useSyncExternalStore(subscribeCrowded, isCrowded, isPhoneServer);
  const guide = challenge
    ? `brief:${challenge.id}`
    : incident
      ? `outage:${incident.id}`
      : taskShown
        ? `task:${taskView.task.presetId}:${exampleRun}`
        : null;
  const [lastGuide, setLastGuide] = useState<string | null>(null);
  if (guide !== null && lastGuide !== guide) {
    setLastGuide(guide);
    if (crowded && !phone && layout.library) {
      setLayout((l) => ({ ...l, library: false }));
    }
    setFitNonce((n) => n + 1);
    // A brief or a story has the reader's attention now, not a task.
    if (!guide.startsWith('task:') && taskFocus) setTaskFocus(false);
  }
  /** The part the current step is about, ringed while the card is open. */
  const taskRing =
    taskView.kind === 'live' && !taskView.done
      ? (taskView.task.steps[taskView.progress.step]?.ring ?? null)
      : null;
  /* A finished tour has just done the first example's task with the student,
     so its card starts folded rather than asking for it all again. */
  const tourFixed = tour.open && tour.stage.kind === 'fixed';
  const [lastTourFixed, setLastTourFixed] = useState(tourFixed);
  if (lastTourFixed !== tourFixed) {
    setLastTourFixed(tourFixed);
    if (tourFixed) exampleTask.setHidden(PRESETS[0]!.id, true);
  }
  const breakSearch = useBreakSearch(breakShown, topology);
  const breakView = breakSearch.view;

  /** Why the entry is off, or null when there is something to break. */
  const breakBlocked = useMemo(() => {
    const clients = topology.nodes.filter((n) => n.kind === 'client');
    if (clients.length === 0)
      return 'Add a client first, so there is traffic to break.';
    const ids = new Set(clients.map((c) => c.id));
    if (!topology.edges.some((e) => ids.has(e.from))) {
      return 'Add something behind the client to break.';
    }
    return null;
  }, [topology.nodes, topology.edges]);

  const breakBlockedRef = useRef(breakBlocked);
  useLayoutEffect(() => {
    breakBlockedRef.current = breakBlocked;
  }, [breakBlocked]);

  /* Names from the design as it is, then from the one the verdict ran on,
     so a part deleted since keeps its name in that verdict. */
  const ranDesign = breakView.status === 'done' ? breakView.design : null;
  const breakNames = useMemo<Names>(() => {
    const ran = (id: string) => ranDesign?.nodes.find((n) => n.id === id)?.label;
    const label = (id: string) => nodeNames[id] ?? ran(id) ?? id;
    return {
      node: label,
      edge: (id: string) => {
        const e =
          topology.edges.find((x) => x.id === id) ??
          ranDesign?.edges.find((x) => x.id === id);
        return e ? `the connection from ${label(e.from)} to ${label(e.to)}` : id;
      },
    };
  }, [nodeNames, topology.edges, ranDesign]);

  /* The parts under attack, for the canvas: a ring while a schedule is
     tried, numbered badges on a break. */
  const breakMarks = useMemo(() => {
    if (!breakShown) return undefined;
    const marks = new Map<string, number>();
    if (breakView.status === 'searching' && breakView.progress) {
      for (const a of breakView.progress.current) marks.set(a.target, 0);
    } else if (breakView.status === 'done' && breakView.result.status === 'broke') {
      breakView.result.attacks.forEach((a, i) => marks.set(a.target, i + 1));
    }
    return marks.size > 0 ? marks : undefined;
  }, [breakShown, breakView]);

  /**
   * The break as a run on the reader's canvas: the design the search played,
   * with its faults and the seed it broke on, and the reader's boxes where
   * they put them. Built from the searched design even after an edit, so a
   * replay is always the run the verdict measured.
   */
  const breakReplay = useCallback((): { replay: Topology; goal: Goal } | null => {
    if (breakView.status !== 'done' || breakView.result.status !== 'broke') return null;
    const t = topoLiveRef.current;
    const placed = new Map(t.nodes.map((n) => [n.id, n]));
    const { nodes, edges, faults, seed } = replayOf(
      breakView.design,
      breakView.result.attacks,
      breakView.result.run.seed,
    );
    return {
      replay: {
        nodes: nodes.map((n) => {
          const p = placed.get(n.id);
          return p ? { ...n, x: p.x, y: p.y, label: p.label } : n;
        }),
        edges,
        ...(t.annotations ? { annotations: t.annotations } : {}),
        ...(faults ? { faults } : {}),
        seed,
      },
      goal: breakView.goal,
    };
  }, [breakView]);

  /** The replay being watched, for the countdown and the running figure. */
  const [breakWatchSet, setBreakWatch] = useState<{
    goal: Goal;
    firstMs: number;
    /** The verdict being watched; any other one ends the watch. */
    result: object;
  } | null>(null);
  /* The watch ends with the panel, or with a new verdict. */
  const breakWatch =
    breakShown &&
    breakView.status === 'done' &&
    breakWatchSet?.result === breakView.result
      ? breakWatchSet
      : null;

  /* During the replay of a correctness break, the part where the checked
     request went wrong, once the replay's clock passes that moment. The
     moment is the one the search measured: the live run steps at the
     display's rate, so on screen it can land a little apart. */
  const violationAt = useMemo(() => {
    if (!breakWatch || breakView.status !== 'done') return null;
    if (breakView.result.status !== 'broke') return null;
    const v = breakView.result.run.violations?.[0];
    if (v === undefined) return null;
    const count = breakView.result.run.actual ?? 0;
    switch (v.check) {
      case 'atMostOnce':
        return {
          node: v.nodeId,
          atMs: v.chargedMs[1],
          count,
          text: `Charged twice: request ${v.rid}`,
          past: `request ${v.rid} was charged a second time`,
        };
      case 'lostAckedWrite':
        return {
          node: v.nodeId,
          atMs: v.lostMs,
          count,
          text: `Lost after saved: request ${v.rid}`,
          past: `request ${v.rid} was lost after it was saved`,
        };
      case 'readYourWrites':
        return {
          node: v.nodeId,
          atMs: v.readMs,
          count,
          text: `Stale read: request ${v.rid}`,
          past: `request ${v.rid} read the value from before its own write`,
        };
    }
  }, [breakWatch, breakView]);
  const violationShown =
    violationAt !== null && snapshot !== null && engine.now >= violationAt.atMs;
  const violationMarks = useMemo(
    () =>
      violationAt !== null && violationShown
        ? new Map([[violationAt.node, violationAt.text]])
        : undefined,
    [violationAt, violationShown],
  );

  /** The reader's design under a replay, and the replay as it went on. */
  const breakBeforeRef = useRef<{ before: Topology; installed: Topology } | null>(null);

  const handleWatchBreak = useCallback(() => {
    const r = breakReplay();
    if (!r) return;
    // Watching again keeps the design from before the first watch.
    const before =
      breakWatch && breakBeforeRef.current
        ? breakBeforeRef.current.before
        : topoLiveRef.current;
    breakBeforeRef.current = { before, installed: r.replay };
    history.commit('watch break', snapRef.current, true);
    installDesign(r.replay, false);
    setRunning(true);
    runningRef.current = true;
    if (breakView.status !== 'done') return;
    setBreakWatch({
      goal: r.goal,
      firstMs: r.replay.faults?.[0]?.atMs ?? 0,
      result: breakView.result,
    });
  }, [breakReplay, breakView, breakWatch, history, installDesign]);

  /**
   * A replay is a visit, not an edit: closing the panel, changing the goal
   * or going off to fix it puts the reader's design back. Untouched apart
   * from moved boxes, it comes back whole; edited, it keeps the edits and
   * loses only the replay's faults and seed. One undo step either way.
   */
  const endBreakWatch = useCallback(() => {
    const w = breakBeforeRef.current;
    breakBeforeRef.current = null;
    setBreakWatch(null);
    if (!w || challengeLiveRef.current !== null) return;
    const now = topoLiveRef.current;
    const runKey = (t: Topology) =>
      canonical({
        nodes: t.nodes.map((n) => [n.id, n.kind, n.config]),
        edges: t.edges,
      });
    let back: Topology;
    if (runKey(now) === runKey(w.installed)) {
      const placed = new Map(now.nodes.map((n) => [n.id, n]));
      back = {
        ...w.before,
        nodes: w.before.nodes.map((n) => {
          const p = placed.get(n.id);
          return p ? { ...n, x: p.x, y: p.y, label: p.label } : n;
        }),
        ...(now.annotations ? { annotations: now.annotations } : {}),
      };
    } else {
      const { faults: _faults, seed: _seed, ...rest } = now;
      back = {
        ...rest,
        ...(w.before.faults ? { faults: w.before.faults } : {}),
        ...(w.before.seed !== undefined ? { seed: w.before.seed } : {}),
      };
    }
    history.commit('replay', snapRef.current, true);
    installDesign(back, false);
    toastSeq.current += 1;
    setToast({
      text: 'Back to your design, without the faults.',
      id: toastSeq.current,
    });
  }, [history, installDesign]);

  const handleMarkChargeable = useCallback(
    (id: string) => handleConfigChange(id, { chargeable: 1 }),
    [handleConfigChange],
  );

  /* The panel's search, with the moves that leave a verdict ending its replay. */
  const breakPanelSearch = useMemo(
    () => ({
      ...breakSearch,
      start: (harder?: boolean) => {
        endBreakWatch();
        breakSearch.start(harder);
      },
      backToGoals: () => {
        endBreakWatch();
        breakSearch.backToGoals();
      },
      remember: (attacks: Attack[]) => {
        endBreakWatch();
        breakSearch.remember(attacks);
      },
    }),
    [breakSearch, endBreakWatch],
  );

  /* While a replay plays, count the same window the search did, on the live
     engine. A tally reads the run and changes nothing in it. It starts on
     the first tick past the warm-up rather than exactly on it, and the live
     run steps at the display's rate, so its figure is close to the
     verdict's rather than equal to it. */
  const breakTallyRef = useRef<'none' | 'running' | 'stopped'>('none');
  useEffect(() => {
    breakTallyRef.current = 'none';
  }, [breakWatch]);
  useEffect(() => {
    if (!breakWatch) return;
    const now = engine.now;
    // A reset rewinds the clock, and the engine drops its tally with it.
    if (now < BREAK_WARMUP_MS) breakTallyRef.current = 'none';
    else if (breakTallyRef.current === 'none') {
      engine.startTally();
      breakTallyRef.current = 'running';
    }
    if (now >= BREAK_END_MS && breakTallyRef.current === 'running') {
      engine.stopTally();
      breakTallyRef.current = 'stopped';
    }
  }, [snapshot, breakWatch, engine]);

  /* Read once a simulated second: a tally copies every latency in the
     window, which is too much to sort at the snapshot rate. The countdown
     only moves by the second anyway. */
  const breakWatchSec = breakWatch && snapshot ? Math.floor(engine.now / 1000) : -1;
  const breakWatchLine = useMemo(() => {
    if (!breakWatch || breakWatchSec < 0) return null;
    const now = engine.now;
    const { goal } = breakWatch;
    // A correctness goal is read from the run the search checked, not the
    // live one, which keeps no operation log.
    if (violationAt !== null) {
      const where = breakNames.node(violationAt.node);
      return now < violationAt.atMs
        ? `Watch ${where} at ${clock(violationAt.atMs)}.`
        : `At ${clock(violationAt.atMs)}, ${violationAt.past}, at ${where}. The search counted ${violationAt.count} in the window.`;
    }
    const tally = now < BREAK_WARMUP_MS ? null : engine.readTally();
    if (!tally) return `Measuring starts at ${secs(BREAK_WARMUP_MS)}.`;
    const run = measureSeed(goal, tally, 0);
    // The verdict's own order: nothing through, then a backlog, then the
    // goal. Partway through, requests still on their way look like a
    // backlog, so that only counts once the window is over.
    const ended = now >= BREAK_END_MS;
    const figure =
      run.outcome === 'nothing-completed'
        ? 'nothing got through'
        : ended && run.outcome === 'falling-behind'
          ? `requests piled up faster than they finished (${formatShareDown(run.keptUp)} got an answer), which counts as broken`
          : goal.metric === 'errorRate'
            ? run.actual === null
              ? 'nothing has settled'
              : `${formatGoalPct(run.actual)} failed`
            : goal.metric === 'p99' || goal.metric === 'p95'
              ? `the slowest took ${run.actual === null ? 'nothing yet' : formatGoalMs(run.actual)}`
              : `${run.actual ?? 0} lost`;
    return now >= BREAK_END_MS
      ? `Between ${secs(BREAK_WARMUP_MS)} and ${secs(BREAK_END_MS)}, ${figure}.`
      : `In the window so far, ${figure}.`;
  }, [breakWatchSec, breakWatch, engine, violationAt, breakNames]);
  /* The countdown reads the replay's own clock on every render rather than
     riding in the memo above, so it can never be left showing a second that
     has already gone. */
  const breakWatchView = useMemo(
    () =>
      breakWatch && breakWatchLine !== null
        ? { line: breakWatchLine, firstMs: breakWatch.firstMs, endMs: BREAK_END_MS }
        : null,
    [breakWatch, breakWatchLine],
  );

  const handleBreakLink = useCallback(() => {
    const r = breakReplay();
    if (!r) return;
    setShareRun(r.replay);
    setShareSession((n) => n + 1);
    setShareOpen(true);
  }, [breakReplay]);

  /** The bar's button, where focus goes back to when the panel closes from inside. */
  const breakBtnRef = useRef<HTMLButtonElement | null>(null);
  const handleCloseBreak = useCallback(() => {
    endBreakWatch();
    setBreakOpen(false);
    const at = document.activeElement;
    if (at === null || at === document.body || at.closest('.brk')) {
      breakBtnRef.current?.focus();
    }
  }, [endBreakWatch]);
  const handleToggleBreak = useCallback(() => {
    if (breakShown) handleCloseBreak();
    else {
      setBreakOpen(true);
      setIncidentId(null);
    }
  }, [breakShown, handleCloseBreak]);
  /* ---------------- real incidents ---------------- */

  /** Bumped when a card is opened, to move focus to the panel. */
  const [incidentFocus, setIncidentFocus] = useState(0);
  /** The scene as opening or Watch installed it, or null. */
  const [incidentScene, setIncidentScene] = useState<Topology | null>(null);
  /**
   * The undo depth right after an incident's scene was put on the canvas by
   * opening it, or null. Fix it uses it to tell an untouched scene, whose
   * undo is the reader's own design, from one they have since worked on.
   */
  const incidentOpenDepthRef = useRef<number | null>(null);
  /** The scene opening installed has not been played yet. */
  const incidentUnplayedRef = useRef(false);
  /** Whether the run was playing before opening paused it. */
  const runningBeforeIncidentRef = useRef(true);
  /* Leaving the panel without playing the scene gives back the run's state
     from before it opened: the pause was for Watch, not for what comes
     next. */
  const resumeAfterIncident = useCallback(() => {
    const unplayed = incidentUnplayedRef.current;
    incidentUnplayedRef.current = false;
    // Played from the bar instead of Watch: the reader has taken over.
    if (!unplayed || runningRef.current || engine.now > 0) return;
    setRunning(runningBeforeIncidentRef.current);
    runningRef.current = runningBeforeIncidentRef.current;
  }, [engine]);

  /* Opening an incident puts its scene on the canvas, paused at the start,
     as one undo step, the way an example opens: the panel is about that
     diagram, and leaving the reader's own under it told them nothing. Paused
     so Watch plays it from the top with the captions, on the same scene
     and seed Watch has always installed. */
  const handleOpenIncident = useCallback(
    /* `fromBrief`: the learning path may open a story while a brief is live.
       Opening it replaces the design through replaceDesign, which leaves
       the brief first, so one undo brings the reader's design back. */
    (id: string, fromBrief = false) => {
      if (!fromBrief && challengeLiveRef.current !== null) return;
      const picked = incidentById(id);
      if (!picked) return;
      if (breakShown) handleCloseBreak();
      const scene = structuredClone(picked.scene);
      replaceDesign(scene, null, 'incident');
      incidentOpenDepthRef.current = history.undoDepth;
      if (!incidentUnplayedRef.current)
        runningBeforeIncidentRef.current = runningRef.current;
      incidentUnplayedRef.current = true;
      setRunning(false);
      runningRef.current = false;
      setIncidentId(id);
      setIncidentScene(scene);
      setIncidentFocus((n) => n + 1);
      say(`Opened ${picked.name}. Undo brings your design back.`);
    },
    [breakShown, handleCloseBreak, replaceDesign, history, say],
  );

  /* The scene opening installed, still at its first instant, only needs
     playing; anything else (a watched run, an edited scene) is put back as
     a fresh copy, as one undo step back to what was there. */
  const handleWatchIncident = useCallback(() => {
    if (!incident) return;
    const unplayed = incidentUnplayedRef.current;
    incidentUnplayedRef.current = false;
    if (
      unplayed &&
      engine.now === 0 &&
      sceneKey(topoLiveRef.current) === sceneKey(incident.scene)
    ) {
      setIncidentScene(structuredClone(incident.scene));
    } else {
      const scene = structuredClone(incident.scene);
      replaceDesign(scene, null, 'incident replay');
      setIncidentScene(scene);
    }
    setRunning(true);
    runningRef.current = true;
  }, [incident, replaceDesign, engine]);

  /* Fixing it sets aside the reader's own design, not the scene opening put
     over it, so Back to my design brings theirs back. While the scene is
     untouched, its open is undone first; once they have worked on it, what
     is on the canvas is theirs, and that is what is set aside. */
  const handleFixIncident = useCallback(() => {
    if (!incident) return;
    const depth = incidentOpenDepthRef.current;
    incidentOpenDepthRef.current = null;
    if (
      depth !== null &&
      depth === history.undoDepth &&
      !history.settling &&
      sceneKey(topoLiveRef.current) === sceneKey(incident.scene)
    ) {
      const entry = history.undo(snapRef.current);
      if (entry) {
        // The brief starts from here in this same handler, before React has
        // rendered the undo, so the mirrors it reads are brought up to date
        // by hand.
        topoLiveRef.current = entry.topology;
        snapRef.current = {
          topology: entry.topology,
          selectedIds: new Set(entry.selectedIds),
          rps: entry.rps,
          presetId: entry.presetId,
          challengeId: entry.challengeId,
        };
      }
    }
    resumeAfterIncident();
    setIncidentId(null);
    setIncidentScene(null);
    handleStartChallenge(incident.brief.id);
  }, [incident, handleStartChallenge, history, resumeAfterIncident]);

  /* An outage's story cannot open inside a brief, so from the path it goes
     back to the reader's design first, as opening an example does. */
  const handleOpenPathIncident = useCallback(
    (id: string) => handleOpenIncident(id, true),
    [handleOpenIncident],
  );
  /* An example from the path puts away an outage's story, which would
     otherwise stay over it, and hands focus to its task card, since the
     dialog or brief that was pressed is gone. */
  const handlePathExample = useCallback(
    (preset: Preset) => {
      setIncidentId(null);
      setIncidentScene(null);
      setTaskFocus(true);
      handleLoadPreset(preset);
    },
    [handleLoadPreset],
  );
  /** Open a step of the learning path through the handler its own picker uses. */
  const openPathStep = useCallback(
    (step: PathStep) => {
      if (step.kind === 'challenge') handleStartChallenge(step.id);
      else if (step.kind === 'incident') handleOpenPathIncident(step.id);
      else {
        const preset = PRESETS.find((p) => p.id === step.id);
        if (preset) handlePathExample(preset);
      }
    },
    [handleStartChallenge, handleOpenPathIncident, handlePathExample],
  );
  /* "Next" after an example's task: the step after it on the path. */
  const taskAfter =
    taskView.kind === 'none' ? null : stepAfter(taskView.task.presetId, 'example');
  const taskNext = taskAfter
    ? { name: stepName(taskAfter), open: () => openPathStep(taskAfter) }
    : null;
  /* A brief on the path goes on along the path, an outage's brief too. One
     that is not on it keeps the picker's order. */
  const briefStep = challenge ? stepOfBrief(challenge.id) : null;
  const briefAfter = briefStep ? stepAfter(briefStep.id, briefStep.kind) : null;
  const handleBriefNext = useCallback(() => {
    if (briefAfter) openPathStep(briefAfter);
  }, [briefAfter, openPathStep]);
  const challengePassed =
    check?.view.status === 'verdict' && check.view.verdict.status === 'passed';

  const handleCloseIncident = useCallback(() => {
    incidentOpenDepthRef.current = null;
    resumeAfterIncident();
    setIncidentId(null);
    setIncidentScene(null);
    menuBtnRef.current?.focus();
  }, [resumeAfterIncident]);

  /* The captions follow the run only while the canvas is still the scene
     that was installed. Moved boxes keep them; a changed design ends them,
     because the story no longer describes what is playing. */
  const incidentPlaying = useMemo(
    () =>
      incident !== undefined &&
      incidentScene !== null &&
      sceneKey(topology) === sceneKey(incidentScene),
    [incident, incidentScene, topology],
  );
  // No caption before the scene has started: paused at its first instant,
  // the panel offers Watch rather than a story that has not begun.
  const incidentSec =
    incidentPlaying && snapshot && (running || engine.now > 0)
      ? Math.floor(engine.now / 1000)
      : -1;

  /* What the canvas keeps in view as panels open: see revealTarget.ts. */
  const chartsUp = layout.metrics && snapshot !== null;
  const brokeTargets = useMemo(
    () =>
      breakShown && breakView.status === 'done' && breakView.result.status === 'broke'
        ? breakView.result.attacks.map((a) => a.target)
        : null,
    [breakShown, breakView],
  );
  const breaking = useMemo(
    () => (breakShown && !brokeTargets ? topology.nodes.map((n) => n.id) : null),
    [breakShown, brokeTargets, topology.nodes],
  );
  const inspecting = useMemo(
    () => (inspectorVisible ? selectedNodes.map((n) => n.id) : null),
    [inspectorVisible, selectedNodes],
  );
  const reveal = useMemo(
    () =>
      revealTarget({
        inspecting,
        broke: brokeTargets,
        breaking,
        verdict:
          challenge && check?.view.status === 'verdict' ? check.view.verdict : null,
        incident:
          incident && incidentPlaying
            ? { id: incident.id, faults: incident.scene.faults ?? [] }
            : null,
        charts: chartsUp,
        guided: taskOpen,
      }),
    [
      inspecting,
      brokeTargets,
      breaking,
      challenge,
      check,
      incident,
      incidentPlaying,
      chartsUp,
      taskOpen,
    ],
  );
  const incidentCaption = useMemo(() => {
    if (!incident || incidentSec < 0) return null;
    const c = captionAt(incident, incidentSec * 1000);
    return c ? `${secs(c.atMs)}: ${c.text}` : null;
  }, [incident, incidentSec]);

  const toggleBreakRef = useRef(handleToggleBreak);
  useLayoutEffect(() => {
    toggleBreakRef.current = handleToggleBreak;
  }, [handleToggleBreak]);

  const handleReset = useCallback(() => {
    engine.reset();
    // Synchronously, not via the derivation effect: Reset must never leave
    // the previous run's Dropped figure standing beside a zeroed clock.
    resetLostRate();
    setSnapshot(engine.snapshot());
    setRoutes(engine.routes());
    setFinding(null);
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
    setRoutes(engine.routes());
  }, [engine]);

  /**
   * The transport again, first in the menu. The bar's own buttons are the
   * quick way, but a touch screen has no Space or S key, and the menu is
   * the one place every layout can always reach.
   */
  const runMenuItems = useMemo<MenuItem[]>(
    () => [
      {
        label: running ? 'Pause' : 'Play',
        icon: running ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M6 3l14 9-14 9z',
        ...(coarse ? {} : { hint: 'Space' }),
        onSelect: handleToggleRun,
      },
      {
        label: 'Step',
        icon: 'M6 4v16M10 4l10 8-10 8z',
        ...(coarse ? {} : { hint: 'S' }),
        onSelect: handleStep,
      },
      {
        label: 'Reset',
        icon: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
        onSelect: handleReset,
        divider: true,
      },
    ],
    [running, coarse, handleToggleRun, handleStep, handleReset],
  );
  /* The palette heads the menu, so it can be found without its chord.
     Presenting follows the run controls: it is how they get shown to a
     room. */
  const searchMenuItem = useMemo<MenuItem>(
    () => ({
      label: 'Search actions',
      icon: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35',
      ...(coarse ? {} : { hint: shortcutLabel('Ctrl+K') }),
      onSelect: () => openPaletteRef.current(),
      divider: true,
    }),
    [coarse],
  );
  const presentMenuItem = useMemo<MenuItem>(
    () => ({
      label: presenting ? 'Stop presenting' : 'Start presenting',
      icon: 'M3 4h18v12H3zM12 16v4M8 20h8',
      ...(coarse ? {} : { hint: 'Shift+P' }),
      onSelect: togglePresenting,
      divider: true,
    }),
    [coarse, presenting, togglePresenting],
  );
  const allMenuItems = useMemo(
    () => [searchMenuItem, ...runMenuItems, presentMenuItem, ...menuItems],
    [searchMenuItem, runMenuItems, presentMenuItem, menuItems],
  );

  /* ---------------- keyboard ---------------- */

  /* F6 steps between the bar, the diagram and the open panels, Shift+F6
     back. Before the typing guard below: no field uses F6, and a reader in
     the inspector's name box is exactly who wants to get out of it. */
  useEffect(() => {
    const onF6 = (e: KeyboardEvent) => {
      if (e.key !== 'F6' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (cycleRegion(e.shiftKey ? -1 : 1) >= 0) e.preventDefault();
    };
    window.addEventListener('keydown', onF6);
    return () => window.removeEventListener('keydown', onF6);
  }, []);

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

      // Slower and faster, by the character so it works on any layout that
      // types a bracket. A held modifier is left to the browser.
      if ((e.key === '[' || e.key === ']') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSpeed(stepSpeed(speedRef.current, e.key === ']' ? 1 : -1));
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
        /* F for "Can you break it?". B was taken by the section tool. */
        if ((e.key === 'f' || e.key === 'F') && !challengeLiveRef.current) {
          if (breakBlockedRef.current === null) {
            e.preventDefault();
            toggleBreakRef.current();
          }
          return;
        }
        // In a challenge the key used to do nothing at all, which reads as
        // broken. Say why instead.
        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          toastSeq.current += 1;
          setToast({
            text: 'Can you break it? is off during a challenge.',
            id: toastSeq.current,
          });
          return;
        }
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
    setSpeed,
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

  /* ---------------- fault controls ----------------
   *
   * Every action goes through the engine's record* calls, so it lands in the
   * fault schedule at the current simulated time and Reset replays it. The
   * schedule is then mirrored into the topology state. That is what keeps
   * the next edit from wiping it: setTopology with a `faults` list that
   * differs from the engine's replaces the engine's, so the list the shell
   * hands back has to be the one the engine already holds.
   */
  const recordedFault = useCallback(() => {
    // A functional update rather than a write through topoLiveRef: these
    // run from a button press, never inside a canvas gesture, and the
    // layout effect brings the mirror up to date on the commit.
    const faults = engine.faultSchedule();
    setTopology((t) => ({ ...t, faults }));
    // Paused or not, the canvas and the panel show the fault at once.
    setSnapshot(engine.snapshot());
    setRoutes(engine.routes());
  }, [engine]);

  // Each press is also an undo entry; see faultUndo. The entry carries the
  // state as rendered, the same thing snapRef holds for every other commit.
  const faultActions = useMemo(
    () =>
      undoableFaultActions(engine, faultActionsFor(engine, recordedFault), {
        history,
        before: { topology, selectedIds, rps, presetId, challengeId },
      }),
    [engine, recordedFault, history, topology, selectedIds, rps, presetId, challengeId],
  );

  const inspectorFaults = useMemo(
    () => ({
      ...faultViewFor(engine, topology, snapshot, {
        node: selectedNode,
        nodeCount: selectedNodes.length,
        edgeCount: selectedEdgeCount,
        ids: selectedIds,
      }),
      ...faultActions,
    }),
    [
      engine,
      topology,
      snapshot,
      selectedNode,
      selectedNodes.length,
      selectedEdgeCount,
      selectedIds,
      faultActions,
    ],
  );

  /**
   * The header's offered load, derived from the topology's client nodes (the
   * sum, so multi-client presets add up) rather than mirrored in a separate
   * state cell that add/delete paths forgot to reconcile. `rps` state is the
   * design's 1x, which this is measured against.
   */
  const offeredRps = useMemo(() => clientRps(topology), [topology]);

  // The 1x follows the clients. With none left there is nothing to measure
  // against, and the first client to appear sets it, so a design built on an
  // empty canvas gets a multiple and one rebuilt after a clear is not
  // measured against the design that was there before. Adjusted during
  // render, as React suggests for state that tracks other state.
  const hasClients = topology.nodes.some((n) => n.kind === 'client');
  // A session saved with a 1x but no clients counts as having had them, so
  // the first render clears that stale 1x.
  const [hadClients, setHadClients] = useState(() => hasClients || rps > 0);
  if (hasClients !== hadClients) {
    setHadClients(hasClients);
    // A 1x set in the same update (undo, a design opened) is kept.
    setRps(hasClients ? (rps > 0 ? rps : offeredRps) : 0);
  }

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

  /* ---------------- presenting and the command palette ---------------- */

  /* The part X, W and R act on while presenting: the one keyboard focus is
     on, so Tab is enough, or else the one selected. */
  const focusedPart = useFocusedPart(presenting);
  const presentId = focusedPart ?? selectedNode?.id ?? null;
  const presentPart = useMemo<PresentPart | null>(() => {
    if (!presenting || presentId === null) return null;
    const n = topology.nodes.find((x) => x.id === presentId);
    if (!n) return null;
    return {
      id: n.id,
      label: n.label,
      fault: snapshot?.activeFailures.find((f) => f.nodeId === n.id) ?? null,
      canSlow: slowable(n.kind),
    };
  }, [presenting, presentId, topology.nodes, snapshot]);

  const presentCrash = useCallback(
    (id: string) => faultActions.onInject(id, 'crash'),
    [faultActions],
  );
  const presentSlow = useCallback(
    (id: string) => faultActions.onInject(id, 'slow', { factor: DEFAULT_SLOW_FACTOR }),
    [faultActions],
  );
  const presentFix = useCallback(
    (id: string) => faultActions.onFix(id),
    [faultActions],
  );

  /* A key that cannot act says why, rather than doing nothing: a teacher
     pressing X in front of a room needs to know it was heard. */
  useEffect(() => {
    presentFaultRef.current = (kind) => {
      const p = presentPart;
      if (!p) {
        say('Pick a part first. Click one or Tab to it.');
        return;
      }
      const f = p.fault;
      if (kind === 'crash') {
        if (f?.kind === 'crash') say(`${p.label} is already crashed. R fixes it.`);
        else presentCrash(p.id);
      } else if (kind === 'slow') {
        if (!p.canSlow) say(`${p.label} does no work of its own to slow down.`);
        else if (f !== null) say(`Fix ${p.label} first. R fixes it.`);
        else presentSlow(p.id);
      } else if (f === null) {
        say(`${p.label} has nothing to fix.`);
      } else presentFix(p.id);
    };
  }, [presentPart, presentCrash, presentSlow, presentFix, say]);

  /* Ctrl+K, or Cmd+K on a Mac. Before any typing guard on purpose: the
     palette is how you get out of a field and do something else. By e.code
     for the same layout reasons as undo. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== 'KeyK')
        return;
      e.preventDefault();
      if (paletteOpenRef.current) setPaletteOpen(false);
      else openPaletteRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const snapToGrid = usePreference('snapToGrid');
  /*
   * The rows are built when the palette opens, from an event, not on every
   * render: a palette left open would otherwise rebuild a hundred rows ten
   * times a second as snapshots land, and nothing in it is read live. The
   * builder is refreshed after each render so the open press sees the
   * latest state.
   */
  const buildCommandsRef = useRef<() => Command[]>(() => []);
  useEffect(() => {
    buildCommandsRef.current = () => {
      const sel = selectedNode?.id ?? null;
      const ordered = sel
        ? [
            ...topology.nodes.filter((n) => n.id === sel),
            ...topology.nodes.filter((n) => n.id !== sel),
          ]
        : topology.nodes;
      const parts = ordered.map((n) => ({
        id: n.id,
        label: n.label,
        fault: snapshot?.activeFailures.find((f) => f.nodeId === n.id)?.kind ?? null,
        canSlow: slowable(n.kind),
      }));
      const hasClient = topology.nodes.some((n) => n.kind === 'client');
      const facts: CommandFacts = {
        running,
        speed,
        canUndo,
        canRedo,
        empty: topology.nodes.length === 0,
        inChallenge: challenge !== undefined,
        breakBlocked,
        canPin: hasClient && (snapshot?.history.length ?? 0) > 0,
        pinned: pinned !== null,
        libraryOpen,
        metricsOpen: layout.metrics,
        snapToGrid,
        theme: themeChoice,
        presenting,
        canFullscreen: canFullscreen(),
        fullscreen,
        parts,
        selectedId: selectedNode?.id ?? null,
        kinds: KIND_GROUPS.flatMap((g) =>
          g.kinds.map((kind) => ({ kind, name: KIND_NAME[kind], group: g.title })),
        ),
        examples: PRESETS.map((p) => ({ id: p.id, name: p.name, tagline: p.tagline })),
        challenges: CHALLENGES.map((c) => ({ id: c.id, name: c.name })),
        incidents: INCIDENTS.map((i) => ({ id: i.id, name: i.name })),
        glossary: GLOSSARY,
        mac: isMac(),
        coarse,
      };
      const select = (id: string) => setSelectedIds(new Set([id]));
      const actions: CommandActions = {
        toggleRun: handleToggleRun,
        step: handleStep,
        reset: handleReset,
        setSpeed,
        undo: handleUndo,
        redo: handleRedo,
        add: handlePaletteAdd,
        openExample: (id) => {
          const p = PRESETS.find((x) => x.id === id);
          if (p) handleLoadPreset(p);
        },
        startChallenge: handleStartChallenge,
        openIncident: handleOpenIncident,
        // The part is selected as well, so the change is seen where it lands.
        crash: (id) => {
          select(id);
          presentCrash(id);
        },
        slow: (id) => {
          select(id);
          presentSlow(id);
        },
        fix: (id) => {
          select(id);
          presentFix(id);
        },
        pin: () => {
          if (!snapshot) return;
          setPinned(
            pinRun(snapshot.system, trailingWindow(snapshot.history), offeredRps),
          );
          if (!layout.metrics) toggleMetrics();
        },
        clearPin: () => setPinned(null),
        toggleLibrary,
        toggleMetrics,
        toggleSnap: () => togglePreference('snapToGrid'),
        setTheme: (t) => setPreference('theme', t),
        togglePresenting,
        toggleFullscreen,
        fit: () => menuApiRef.current?.fitAll(),
        share: handleOpenShare,
        breakIt: () => {
          setBreakOpen(true);
          setIncidentId(null);
        },
        glossary: openGlossary,
        examples: () => setExamplesOpen(true),
        challenges: () => setChallengesOpen(true),
        path: () => setPathOpen(true),
        designs: () => setDesignsOpen(true),
        shortcuts: () => setShortcutsOpen(true),
        settings: () => setSettingsOpen(true),
      };
      return buildCommands(facts, actions, formatFactor(DEFAULT_SLOW_FACTOR));
    };
  });
  const [paletteCommands, setPaletteCommands] = useState<Command[]>([]);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
    openPaletteRef.current = () => {
      setMenuOpen(false);
      setPaletteCommands(buildCommandsRef.current());
      setPaletteOpen(true);
    };
  }, [paletteOpen]);

  const runCommand = useCallback(
    (cmd: Command) => {
      const next = pushRecent(recentCommands, cmd.id);
      setRecentCommands(next);
      saveRecent(next);
      cmd.run();
    },
    [recentCommands],
  );

  return (
    <div className={presenting ? 'app is-presenting' : 'app'}>
      {/* The first stop for Tab, shown only when it has focus. Without it
          the diagram was behind the bar and every row of the rail. */}
      <a
        className="app-skip"
        href="#diagram"
        onClick={(e) => {
          e.preventDefault();
          focusDiagram();
        }}
      >
        Skip to diagram
      </a>
      <header
        className="app-bar"
        ref={barRef}
        data-fit={barCompact ? 'compact' : 'row'}
      >
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

            Text, so a screen reader finds it in the bar. Not a live region:
            every edit flips it to Saving and back, and announced, that pair
            talked over each step of the load slider and each nudge of a
            part. Someone who cannot see the dot reads it when they wonder.
          */}
          <p
            className={`app-saved is-${saveState}`}
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
              className="btn btn-icon"
              disabled={!canUndo}
              aria-label="Undo"
              title={`Undo (${shortcutLabel('Ctrl+Z')})`}
              onClick={handleUndo}
            >
              <svg
                width="16"
                height="16"
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
              className="btn btn-icon"
              disabled={!canRedo}
              aria-label="Redo"
              title={`Redo (${shortcutLabel('Ctrl+Shift+Z')})`}
              onClick={handleRedo}
            >
              <svg
                width="16"
                height="16"
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
            speed={speed}
            slowAt={slowAt}
            onSpeedChange={setSpeed}
            system={snapshot?.system ?? EMPTY_SYSTEM}
            lost={lostRps}
            baselineRps={rps}
            onMakeBaseline={() => setRps(offeredRps)}
            liveRps={shapedLiveRps(topology, snapshot)}
            empty={topology.nodes.length === 0}
            noTrafficSource={offeredRps === 0 && findClients(topology).length === 0}
            locked={challenge !== undefined}
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
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={
              starCount !== null
                ? `Source on GitHub, ${formatStars(starCount)} stars`
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
            {/* Until a count arrives, or when it never does, the reserved
                room carries the name instead of standing empty. */}
            {stars === null && (
              <span className="app-source-name" aria-hidden="true">
                GitHub
              </span>
            )}
          </a>

          {/* Labelled, and in the bar rather than three levels down inside
              Settings. Sending a design to someone is a thing people want
              to do often, and a feature nobody can find has not shipped. */}
          {/* Hidden inside a brief, which owns its faults and its check. */}
          {challenge ? null : (
            <button
              type="button"
              ref={breakBtnRef}
              className="btn app-share-btn app-break-btn"
              onClick={handleToggleBreak}
              disabled={breakBlocked !== null}
              aria-expanded={breakShown}
              aria-label="Can you break it?"
              title={breakBlocked ?? 'Throw faults at this design until it fails (F)'}
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
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              <span className="app-break-long" aria-hidden="true">
                Can you break it?
              </span>
              <span className="app-break-short" aria-hidden="true">
                Break it
              </span>
            </button>
          )}

          <button
            type="button"
            className="btn app-share-btn"
            onClick={handleOpenShare}
            title="Get a link to this design"
            aria-label="Share"
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
            {/* Hidden on a phone, where the header is one row and the link
                glyph has to carry it; aria-label keeps the name. */}
            <span className="app-share-label">Share</span>
          </button>

          <div className="app-menu-wrap">
            <button
              ref={menuBtnRef}
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
              items={allMenuItems}
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
          (libraryOpen ? ' has-library' : '') +
          (inspectorVisible ? ' has-inspector' : '') +
          (metricsVisible ? ' has-metrics' : '') +
          (challenge || breakShown || incident ? ' has-challenge' : '') +
          (taskOpen ? ' has-task' : '')
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
            id="diagram"
            className="stage-canvas"
            tabIndex={-1}
            onDragOver={handleFileDragOver}
            onDrop={handleFileDrop}
          >
            {/*
              The uncovered-canvas sentinel. Inert and invisible; a sibling
              of the Canvas, outside .cv-surface, so the gesture router can
              never see it. Its rect is the canvas minus every open panel.
              Before the Canvas, so its ref is attached by the time the
              Canvas's own layout effect frames the first design: after it,
              the boot fit found no sentinel and framed the whole stage, a
              brief's diagram included, under the open panels.
            */}
            <div ref={stageSafeRef} className="stage-safe" aria-hidden="true" />
            <Canvas
              topology={topology}
              snapshot={snapshot}
              routes={routes}
              readOutcomes={readOutcomes}
              selectedIds={selectedIds}
              onSelectionChange={setSelectedIds}
              onMoveNode={handleMoveNode}
              onMoveStart={handleMoveStart}
              onMoveEnd={handleMoveEnd}
              onConnect={handleConnect}
              onDeleteSelection={handleDeleteSelection}
              onDropNode={handleDropNode}
              onRename={handleRename}
              onDuplicateForDrag={handleDuplicateForDrag}
              onPaste={handlePaste}
              onContextMenu={handleCanvasMenu}
              onClipboardWrite={setCopied}
              menuApiRef={menuApiRef}
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
              frameKey={barBottom}
              visibleRef={stageSafeRef}
              breakMarks={breakMarks}
              violationMarks={violationMarks}
              emptyActions={emptyActions}
              narrowFit={phone}
              onFitClipped={handleFitClipped}
              reveal={reveal}
              onReselect={showInspector}
              spotlightId={
                (tourShown ? tour.spotlight : null) ??
                spotlightOf(shownFinding) ??
                (taskOpen ? taskRing : null)
              }
              spotlightKey={shownFinding?.atMs ?? null}
            />
            <RouteAlert routes={routes} nodeNames={nodeNames} />
            {presenting ? (
              <PresentBar
                part={presentPart}
                coarse={coarse}
                canFullscreen={canFullscreen()}
                fullscreen={fullscreen}
                onCrash={presentCrash}
                onSlow={presentSlow}
                onFix={presentFix}
                onFullscreen={toggleFullscreen}
                onStop={stopPresenting}
              />
            ) : null}
            {/* Hidden in a challenge, where finding it is the exercise. */}
            {!challenge && topology.nodes.length > 0 ? (
              <FindProblem
                topology={topology}
                snapshot={snapshot}
                finding={shownFinding}
                onChange={setFinding}
                onSelect={(id) => setSelectedIds(new Set([id]))}
              />
            ) : null}
            {/* Hidden in a challenge too: it would narrate the answer. */}
            {!challenge ? (
              <WhatHappened topology={topology} snapshot={snapshot} />
            ) : null}
            {tourShown ? (
              <Tour
                tour={tour}
                topology={topology}
                snapshot={snapshot}
                selectedId={tourSubject}
                rps={offeredRps}
                onSetLoad={handleRpsChange}
                onSelect={(id) => setSelectedIds(new Set([id]))}
                onOpenPath={() => setPathOpen(true)}
                onHandOff={() => setTaskFocus(true)}
              />
            ) : null}
            {taskShown ? (
              <TaskCard
                view={taskView}
                exampleName={
                  PRESETS.find((p) => p.id === taskView.task.presetId)?.name ?? ''
                }
                topology={topology}
                snapshot={snapshot}
                selectedId={tourSubject}
                squeezed={phone && inspectorVisible}
                next={taskNext}
                onSetLoad={handleRpsChange}
                onSelect={(id) => setSelectedIds(new Set([id]))}
                onHide={(hide) => {
                  exampleTask.setHidden(taskView.task.presetId, hide);
                  // On a phone the settings sheet is what folded it, so
                  // showing the task again puts that sheet away.
                  if (!hide && phone && inspectorVisible) setSelectedIds(new Set());
                }}
                onReload={() => {
                  const p = PRESETS.find((x) => x.id === taskView.task.presetId);
                  if (p) handleLoadPreset(p);
                }}
                onOpenPath={() => setPathOpen(true)}
                takeFocus={taskFocus}
                onFocusTaken={handleTaskFocusTaken}
              />
            ) : null}
            {challenge && challengePassed && phone && inspectorVisible ? (
              <PassStrip
                name={challenge.name}
                onShow={() => setSelectedIds(new Set<string>())}
              />
            ) : null}
            {challenge && check ? (
              <ChallengePanel
                challenge={challenge}
                live={live}
                liveFlowing={(snapshot?.system.goodputRps ?? 0) > 0}
                check={check.view}
                budget={check.budget}
                hintsShown={attemptFor(chalStore, challenge)?.hintsShown ?? 0}
                onHint={handleHint}
                onCheckAgain={check.checkAgain}
                onWatch={handleWatchRun}
                onStartOver={check.key !== freshKey ? handleStartOver : null}
                onNext={
                  briefAfter ? handleBriefNext : next ? handleNextChallenge : null
                }
                nextLabel={
                  briefAfter
                    ? `Next: ${stepName(briefAfter)}`
                    : next
                      ? `Next challenge: ${next.name}`
                      : undefined
                }
                onLeave={handleLeaveChallenge}
                onCopyLink={handleCopyChallengeLink}
                focusSignal={panelFocus}
                nameOf={nameOf}
                besideInspector={inspectorVisible && !phone}
                onSheetResize={handleSheetResize}
                fresh={check.key === freshKey}
                liveMs={snapshot ? snapshot.system.timeMs : null}
              />
            ) : null}
            {incident ? (
              <IncidentPanel
                incident={incident}
                caption={incidentCaption}
                onWatch={handleWatchIncident}
                onFix={handleFixIncident}
                onClose={handleCloseIncident}
                focusSignal={incidentFocus}
                foldOnStart={false}
                onSheetResize={handleSheetResize}
              />
            ) : null}
            {breakShown ? (
              <BreakPanel
                search={breakPanelSearch}
                names={breakNames}
                nodes={topology.nodes}
                onClose={handleCloseBreak}
                onWatch={handleWatchBreak}
                onReplayLink={handleBreakLink}
                onMarkChargeable={handleMarkChargeable}
                watch={breakWatchView}
                watchAtMs={breakWatchView ? engine.now : 0}
                onStopWatch={endBreakWatch}
                foldOnStart={false}
                onSheetResize={handleSheetResize}
              />
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-icon stage-toggle stage-toggle-library"
              data-chrome="layout"
              aria-expanded={libraryOpen}
              aria-label={libraryOpen ? 'Hide components' : 'Show components'}
              title={libraryOpen ? 'Hide components (C)' : 'Show components (C)'}
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
                routes={routes}
                pin={pinned}
                rps={offeredRps}
                onPin={setPinned}
                idle={
                  !topology.nodes.some((n) => n.kind === 'client')
                    ? 'no-client'
                    : !running && snapshot.system.timeMs === 0
                      ? 'not-started'
                      : undefined
                }
              />
            ) : null}
            {snapshot ? <StripCue /> : null}
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

        {/*
          The rails come after the canvas in the page, though the components
          rail is drawn on its left: Tab goes bar, diagram, then panels, and
          the canvas was 82 presses in behind 33 rail rows. They float, so the
          order changes nothing on screen.
        */}
        <PanelSlot
          open={libraryOpen}
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

        <PanelSlot
          open={inspectorVisible}
          edge="right"
          onDismiss={phone ? toggleInspector : undefined}
          scrim={false}
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
            lockedFields={challenge ? lockedFor : undefined}
            suggestions={challenge === undefined}
            faults={inspectorFaults}
            onEdgeLoss={handleEdgeLoss}
            onDuplicate={handleDuplicate}
            onCopy={handleCopySelection}
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

        {/*
        The toasts sit inside .app-body so its has-* classes can centre them
        on the uncovered canvas, above the zoom row, and on a phone just
        under the header (App.css). Fixed at the window's foot they covered
        the stats bar, the charts toggle and the phone's tab bar.
      */}
        {toast || importError ? (
          <div className="app-toast-dock" data-chrome="toast">
            {/*
            Undo/redo receipt. role="status" (polite live region) so a screen
            reader hears the same confirmation a sighted user sees; keyed by id
            so rapid consecutive undos restart the entrance rather than sitting
            still on a message that appears not to change.
          */}
            {toast ? (
              <div key={`toast-${toast.id}`} className="app-toast" role="status">
                {toast.text}
                {toast.action ? (
                  <button
                    type="button"
                    className="btn btn-sm app-toast-action"
                    onClick={toast.action.run}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
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
          </div>
        ) : null}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={paletteCommands}
          recent={recentCommands}
          onRun={runCommand}
        />

        {menu ? (
          <CanvasMenu
            key={menu.seq}
            request={menu.req}
            topology={topology}
            snapshot={snapshot}
            selectedIds={selectedIds}
            engine={engine}
            faults={faultActions}
            canPaste={copied !== null || (!coarse && !!navigator.clipboard?.readText)}
            coarse={coarse}
            actions={menuActions}
            onClose={closeMenu}
          />
        ) : null}
      </div>

      {/*
        The phone tab bar.

        CSS decides whether this is visible, not JS: it reads the same panel
        state the desktop's edge toggles read, so the two can never disagree
        about whether a panel is open. Above the breakpoint it is
        display:none and costs a reader nothing.

        The inspector tab is dimmed rather than hidden when nothing is
        selected. A tab bar whose tabs come and go moves the others under
        the thumb mid-tap, and the dimmed state teaches what the tab is
        for: select something and it lights up. aria-disabled rather than
        disabled, so a tap on it can still say how to light it up.
      */}
      <nav className="app-tabbar" aria-label="Panels">
        <button
          type="button"
          className="app-tab"
          aria-expanded={libraryOpen}
          onClick={toggleLibrary}
        >
          <PanelGlyph edge="left" />
          Build
        </button>
        <button
          type="button"
          className="app-tab"
          aria-expanded={inspectorVisible}
          aria-disabled={!hasSelection || undefined}
          onClick={
            hasSelection
              ? toggleInspector
              : () => say('Tap a part on the canvas to see its settings and break it.')
          }
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
      <TooltipLayer />
      <Glossary open={glossaryOpen} onClose={closeGlossary} focusId={glossaryFocusId} />
      <Shortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Share
        // Prefixed: the toast above is a keyed sibling with its own counter.
        key={`share-${shareSession}`}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        replayable={shareRun !== null || hasReplay(topology)}
        onBuild={handleBuildLink}
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
        canSave={topology.nodes.length > 0}
        onOpenFile={() => fileInputRef.current?.click()}
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
        onOpenPath={() => setPathOpen(true)}
        incidents={challenge ? [] : INCIDENTS}
        onOpenIncident={handleOpenIncident}
      />
      <Challenges
        open={challengesOpen}
        onClose={() => setChallengesOpen(false)}
        challenges={CHALLENGES}
        onStart={handleStartChallenge}
        badgeOf={badgeOf}
      />
      <LearningPath
        open={pathOpen}
        onClose={() => setPathOpen(false)}
        presets={PRESETS}
        challenges={ALL_BRIEFS}
        explored={explored}
        badgeOf={badgeOf}
        activePresetId={presetId}
        activeChallengeId={challengeId}
        activeIncidentId={incident ? incident.id : null}
        onLoadExample={handlePathExample}
        onStartChallenge={handleStartChallenge}
        onOpenIncident={handleOpenPathIncident}
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
