import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import type {
  EdgeState,
  FailureKind,
  NodeConfig,
  NodeKind,
  NodeStats,
  RouteStats,
  SimEdge,
  SimNode,
  SimSnapshot,
  Topology,
} from '../sim/types';
import {
  ICON_BOX,
  ICON_STROKE,
  KIND_GROUPS,
  KIND_ICON,
  KIND_NAME,
  NODE_DND_MIME,
  cellStrip,
  groupOfKind,
  stackBadge,
  stackLayers,
} from './nodeVisuals';
import { behaviourFor } from '../sim/behaviour';
import {
  formatCount,
  formatElapsed,
  formatMs,
  formatPct,
  formatRate,
  healthOfErr,
  healthOfLatency,
  healthOfLoad,
} from './format';
import type { Health } from './format';
import type { TextStyle } from './textMetrics';
import { measureText, resetTextMetrics, truncateToWidth } from './textMetrics';
import { useCoarsePointer } from '../useCoarsePointer';
import { buildClipboardText, parseClipboardText } from '../clipboard';
import type { ClipboardSubgraph } from '../clipboard';
import { arrowPath, previewPath, routeEdge } from './edgeRoute';
import type { EdgeRoute } from './edgeRoute';
import {
  beginPinch,
  dragThresholdFor,
  endPointer,
  isPalmTouch,
  pinchFrame,
  pressAction,
  snapsToGrid,
} from './pointerInput';
import type { PinchState, TouchMap } from './pointerInput';
import {
  ANN_DND_MIME,
  NEW_NOTE_TEXT,
  NEW_SECTION_H,
  NEW_SECTION_W,
  RESIZE_DIRS,
  handleAnchor,
  layoutNoteOf,
  resizeRect,
} from './annotationLayout';
import { textWysiwyg } from './textWysiwyg';
import type { TextWysiwyg } from './textWysiwyg';
import type { ResizeDir } from './annotationLayout';
import {
  SECTION_MIN_HEIGHT,
  SECTION_MIN_WIDTH,
  ANNOTATION_FONTS,
  NOTE_MAX_SCALE,
  NOTE_MAX_WIDTH,
  NOTE_MIN_SCALE,
  NOTE_MIN_WIDTH,
  SECTION_TONE_COUNT,
  isNote,
  isSection,
} from '../sim/annotations';
import type { Annotation, AnnotationFont, Note, Section } from '../sim/annotations';
import { usePreference } from '../content/preferences';
import { Minimap } from './Minimap';
import { DETAIL_ZOOM, MINIMAL_ZOOM, fitViewport } from './fit';
import { EmptyCanvas } from './EmptyCanvas';
import { EdgeCues } from './EdgeCues';
import type { EmptyCanvasProps } from './EmptyCanvas';
import { glanceLayout, glanceScale } from './glance';
import type { GlanceLayout } from './glance';
import { useSettledHealthMap } from './settledHealth';
import { serialiseSvg } from '../imageExport';
import './Canvas.css';

/* ------------------------------------------------------------------ *
 * Geometry.
 *
 * Preset coordinates treat x/y as the node's top-left corner. 184x88 is
 * measured against the real preset spacing, not chosen for looks:
 *
 *   async-workers   worker(730,200) and db(860,380) overlap horizontally
 *                   (130px apart, 184px wide) and read only because of the
 *                   vertical gap: 380 - (200 + 88) = 92px. Safe.
 *   load-balanced   api1/api2/api3 stack at y=80/220/360. At H=88 the gutter
 *                   is 140 - 88 = 52px, enough for three edges to fan
 *                   through. At H=96 it would be 44px and the fan-out that
 *                   preset exists to teach starts to crowd.
 *   async-workers   api(260) -> queue(500) is the tightest horizontal pair:
 *                   240 - 184 = 56px of edge. Fine.
 *
 * Any future change to these two numbers must be re-checked against those
 * three pairs.
 * ------------------------------------------------------------------ */

export const NODE_W = 184;
export const NODE_H = 88;
/** Radii come from the design scale (3/4/6). The node body is the 6. */
const NODE_R = 6;
/** The spotlight ring's gap from the node, and its tag's size. */
const SPOT_PAD = 8;
const SPOT_TAG_W = 48;
const SPOT_TAG_H = 22;
/**
 * Gap between the node's outline and the selection ring drawn around it.
 *
 * 3px. Large enough that the ring is a separate object rather than a fringe
 * on the border, small enough that at 0.4x zoom (where it is 1.2 device px)
 * the ring has not visually detached from the node it belongs to.
 */
const RING_GAP = 3;

/**
 * Internal layout.
 *
 * The node is a single surface divided by WHITESPACE and one hairline, never
 * by nested boxes — "boundary priority: whitespace, then background shift,
 * then border last". Vertical rhythm, all on the 4px space scale:
 *
 *    0   top edge, health rule rides here
 *    8   glyph top (18px box)
 *   26   header baseline area ends
 *   30   hairline under the header
 *   52   primary value baseline
 *   68   secondary row baseline
 *   80   meter
 *
 * The old layout put a vertical divider rule at x=104 to fence the sparkline
 * off from the numbers. That rule is gone: two type sizes and 12px of gap
 * separate them more quietly than a line does.
 */
const HEAD_H = 30;
/** Horizontal inset for everything inside the body. */
const PAD_X = 12;

/**
 * Width budget for ONE side of the two-cell secondary row.
 *
 * The row is two texts anchored to opposite edges of the node, so they grow
 * toward each other. Half the interior each, minus a gutter so they never
 * touch even when both are at their limit.
 */
const SEC_HALF = (NODE_W - PAD_X * 2 - 14) / 2;

/**
 * The three text styles a node draws, as measurable descriptions.
 *
 * These mirror .cv-val / .cv-cap / .cv-node-name in Canvas.css. They exist
 * so that layout code can ask what a string will ACTUALLY measure instead of
 * multiplying its length by a constant — see textMetrics.ts for the sizes
 * that guesswork produced and why it could not be made to work.
 */
const VAL_STYLE: TextStyle = { size: 12, weight: 650, family: 'mono' };
const VAL_PRIMARY_STYLE: TextStyle = { size: 16, weight: 650, family: 'mono' };
const VAL_SELECTED_STYLE: TextStyle = { size: 22, weight: 650, family: 'mono' };
/** 11px uppercase, letter-spaced 0.06em = 0.66px per character. */
const CAP_STYLE: TextStyle = {
  size: 11,
  weight: 650,
  family: 'sans',
  tracking: 0.66,
  uppercase: true,
};
const NAME_STYLE: TextStyle = { size: 14, weight: 450, family: 'sans' };

/** The dx between a cell's value and label tspans. */
const CELL_GAP_W = 3;

/** Rendered width of one value+label cell at secondary size. */
function cellWidth(value: string, label: string): number {
  const gap = value && label ? CELL_GAP_W : 0;
  return measureText(value, VAL_STYLE) + measureText(label, CAP_STYLE) + gap;
}

/**
 * Constrain a secondary cell to a width budget.
 *
 * Returns `textLength` only when the cell would genuinely overflow, because
 * applying it unconditionally makes short strings render subtly wrong (the
 * browser redistributes spacing to hit the exact length even when it did not
 * need to). `lengthAdjust` condenses the glyphs themselves rather than only
 * the gaps, which stays readable far longer.
 */
function fitCell(
  value: string,
  label: string,
  budget: number,
): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  if (cellWidth(value, label) <= budget) return {};
  return { textLength: budget, lengthAdjust: 'spacingAndGlyphs' };
}

/**
 * Constrain the primary readout, accounting for the selected font bump.
 *
 * Its budget stops short of the sparkline and vessel slot at SPARK_X.
 * (Budget computed at call time because SPARK_X is declared further down.)
 */
function fitPrimary(
  value: string,
  label: string,
  selected: boolean,
): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  const budget = SPARK_X - PAD_X - 6;
  const vs = selected ? VAL_SELECTED_STYLE : VAL_PRIMARY_STYLE;
  const gap = value && label ? CELL_GAP_W + 1 : 0;
  const w = measureText(value, vs) + measureText(label, CAP_STYLE) + gap;
  if (w <= budget) return {};
  return { textLength: budget, lengthAdjust: 'spacingAndGlyphs' };
}

/** fitPrimary for the glance line: the full inner width is its budget. */
function fitGlance(
  value: string,
  label: string,
  gl: GlanceLayout,
): { textLength?: number; lengthAdjust?: 'spacingAndGlyphs' } {
  const budget = NODE_W - PAD_X * 2;
  const w =
    measureText(value, { ...VAL_PRIMARY_STYLE, size: gl.valueSize }) +
    measureText(label, {
      ...CAP_STYLE,
      size: gl.capSize,
      tracking: gl.capSize * 0.06,
    }) +
    (value && label ? gl.capGap : 0);
  if (w <= budget) return {};
  return { textLength: budget, lengthAdjust: 'spacingAndGlyphs' };
}

const SPARK_X = 108;
const SPARK_Y = 38;
const SPARK_W = 64;
const SPARK_H = 18;
/** One sample per second over the same 60s window the charts show. */
export const SPARK_LEN = 60;

/**
 * The utilisation meter spans the FULL width of the node, flush to both
 * insets, and sits on the bottom edge. Full width matters: the bar's length
 * is the redundant, colour-blind-safe encoding of load, so it needs the
 * longest run the node can give it to be readable at a glance.
 */
/**
 * The per-unit strip's band: full inner width, in the gap above the meter.
 *
 * A shard's partitions are the node's primary content, so the strip gets the
 * full 160px rather than the sparkline's 64px slot. That width is what keeps
 * 64 partitions legible: 64 cells in 64px is 1.00px each, which cannot carry
 * a readable fill height, while 64 cells in 160px is 2.50px each, which can.
 */
const STRIP_Y = 56;
const STRIP_H = 12;

const METER_Y = 80;
const METER_H = 3;
const METER_W = NODE_W - PAD_X * 2;
/**
 * Load at which the meter grows a threshold tick.
 *
 * DERIVED from healthOfLoad rather than restated, so this file can never drift
 * out of agreement with format.ts about where warn begins. A literal 0.7 here
 * would be a second source of truth for the same number.
 */
const WARN_AT = (() => {
  for (let v = 0; v <= 1000; v++)
    if (healthOfLoad(v / 1000) === 'warn') return v / 1000;
  return 0.7;
})();

/** Grid step. Exported so the shell's paste placement snaps the same way. */
export const GRID = 8;
/** Visual radius of a port dot. */
const PORT_R = 5;
/**
 * Invisible hit radius. Roughly 3x the visual radius, per the rule that a
 * 5px target is not a target. Drawn as a transparent circle UNDER the visible
 * dot so the dot still paints at its true size.
 */
const PORT_HIT_R = 15;
const PORT_CY = NODE_H / 2;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
/** One keyboard or button zoom step. Shared so the two cannot drift. */
const ZOOM_STEP = 1.25;
/* The detail thresholds and the auto-fit floors live in fit.ts, with the
   fit arithmetic they govern. */

/*
 * The click/drag threshold lives in pointerInput.ts (dragThresholdFor) and
 * is PER POINTER TYPE: 4px for a mouse, 10px for a finger or a pen, which
 * jitter. It is measured in CSS pixels on the SCREEN, not in world units: a
 * human's hand shakes by the same number of screen pixels regardless of
 * zoom, so a world-space threshold would make the canvas feel twitchy at
 * 2.5x and sticky at 0.4x. Each press latches its own threshold at
 * pointerdown, so a pen press and a mouse press in flight together cannot
 * read each other's number.
 */

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

/**
 * Per-node sparkline samples, newest last, keyed by node id.
 *
 * `SimSnapshot.history` is system-wide — `HistoryPoint` carries no node id —
 * so there is no per-node history in the engine to draw. Since src/sim is not
 * ours to change, the ring buffer lives in the UI and is passed in. Absent or
 * short buffers render a bare baseline, never a placeholder.
 */
export type SparkData = ReadonlyMap<string, ArrayLike<number>>;

export interface CanvasProps {
  topology: Topology;
  snapshot: SimSnapshot | null;
  /** Each client's own figures, from `Engine.routes()`, for the client cards. */
  routes?: readonly RouteStats[];
  /**
   * Ids of every selected node AND edge. Node ids and edge ids share one
   * namespace here; an edge id is `from->to`, which can never collide with a
   * node id, so a single set is unambiguous.
   */
  selectedIds: ReadonlySet<string>;
  /**
   * Replaces the whole selection. The canvas always computes the next set
   * itself (including shift/ctrl toggling and marquee union) and hands the
   * finished set over, so the shell never has to reimplement selection logic.
   */
  onSelectionChange: (ids: ReadonlySet<string>) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  /**
   * Explicit gesture boundaries around a node drag, for the shell's undo
   * history. onMoveStart fires once at drag promotion, BEFORE the promotion
   * selects the grabbed node, so a history baseline captured in it holds the
   * pre-drag selection too. onMoveEnd fires exactly once when the drag ends,
   * by any route: pointerup, pointercancel, Escape, or the buttons===0
   * stale-gesture guard. onMoveNode itself fires every frame in between and
   * carries no boundary information on purpose; the shell must not have to
   * infer "the drag is over" from a gap in the stream.
   */
  onMoveStart?: (label?: string) => void;
  onMoveEnd?: () => void;
  onConnect: (fromId: string, toId: string) => void;
  /**
   * Delete everything in one gesture. The canvas partitions the selection
   * into node ids, edge ids and annotation ids and passes all three, so the
   * shell can apply a single topology edit instead of N sequential ones
   * (which would make each delete race the previous state).
   */
  onDeleteSelection: (
    nodeIds: readonly string[],
    edgeIds: readonly string[],
    annotationIds?: readonly string[],
  ) => void;
  onDropNode: (kind: NodeKind, x: number, y: number) => void;
  /**
   * Commit a rename typed into the double-click editor. Called ONCE, with
   * the finished label, when the edit commits (Enter or blur); Escape and an
   * empty name never call it.
   */
  onRename?: (id: string, label: string) => void;
  /**
   * Alt+drag: duplicate before dragging. Called once at drag promotion with
   * the grabbed node's id; the shell clones the selection IN PLACE (no
   * offset), makes the clones the selection, opens its own history gesture,
   * and returns which clones the drag should now carry: the clone of the
   * grabbed node, and the other clones with their origins. Returning null
   * degrades to a plain move. The shell's onMoveEnd still closes the
   * gesture, so a duplicate-drag is exactly one history entry.
   */
  onDuplicateForDrag?: (
    primaryId: string,
  ) => { id: string; group: { id: string; x: number; y: number }[] } | null;
  /**
   * A validated clipboard subgraph arrived via Ctrl+V. `at` is the pointer's
   * world position (or the viewport centre when the pointer is elsewhere);
   * the shell mints fresh ids and appends. Ids in `sub` are the COPIED ids
   * and must be remapped by the receiver, never trusted to be free.
   */
  onPaste?: (sub: ClipboardSubgraph, at: { x: number; y: number }) => void;
  /* ---- annotations: notes and sections ----
   *
   * Per-frame move/resize streams mirror onMoveNode: no boundary information
   * on purpose, with onMoveStart/onMoveEnd marking the gesture edges so the
   * shell's history sees exactly one entry per drag. Creation and text edits
   * are single discrete calls. All optional: a shell that wires none of them
   * simply has no annotation editing, never a crash.
   */
  /** One frame of an annotation drag, already grid-snapped. */
  onMoveAnnotation?: (id: string, x: number, y: number) => void;
  /** One frame of a section resize, minimums already enforced. */
  onResizeSection?: (id: string, x: number, y: number, w: number, h: number) => void;
  /**
   * Create a note at a world point. Returns the new note's id (so the canvas
   * can open its editor over it immediately) or null if the shell declined.
   */
  onCreateNote?: (x: number, y: number) => string | null;
  onCreateSection?: (x: number, y: number, w: number, h: number) => void;
  /**
   * Commit a note text edit. Called ONCE when the editor closes; the shell
   * removes the note outright when the text is emptied.
   */
  onEditNote?: (id: string, text: string) => void;
  onEditSectionLabel?: (id: string, label: string) => void;
  onSetNoteSize?: (id: string, size: Note['size']) => void;
  /** Recolour a section. `tone` is a palette index, never a colour. */
  onSetSectionTone?: (id: string, tone: number) => void;
  /**
   * Resize a note. Only x and width: the height is derived from the wrapped
   * text on every layout, so there is nothing else for a caller to set.
   */
  onResizeNote?: (id: string, x: number, width: number) => void;
  /**
   * Scale a note from a corner: the type and the wrap width move together,
   * so the line breaks hold and the note keeps its shape.
   */
  onScaleNote?: (id: string, x: number, width: number, scale: number) => void;
  /**
   * Restyle a note. Every field is optional so one handler serves the whole
   * toolbar; `tone: null` clears the colour, and bold toggles rather than
   * being set, because the button reports a press, not a target state.
   */
  onSetNoteStyle?: (
    id: string,
    change: {
      font?: AnnotationFont;
      tone?: number | null;
      bold?: 'toggle';
      italic?: 'toggle';
      underline?: 'toggle';
    },
  ) => void;
  /** Optional: per-node sparkline history. Omitted -> no sparklines. */
  spark?: SparkData;
  /**
   * Optional out-parameter: the canvas keeps `current` set to a getter that
   * returns the world coordinates at the centre of the current view. The
   * shell uses it to place palette CLICKS (which carry no drop point) where
   * the student is actually looking. A ref rather than state on purpose: the
   * view changes every pan/zoom frame, and nothing should re-render for it.
   */
  viewCenterRef?: MutableRefObject<(() => { x: number; y: number }) | null>;
  /**
   * Arms the note or section tool from outside, so the palette rows can put
   * the canvas into "draw the next one" instead of spawning a shape.
   *
   * A section that appears at the view centre lands on whatever is already
   * there, and every node inside its bounds is then carried along when it is
   * dragged. The student did not ask for that and gets no warning, so the
   * palette arms the same tool the B key does and the frame is drawn where
   * it was actually wanted.
   */
  armToolRef?: MutableRefObject<((tool: 'note' | 'section') => void) | null>;
  /**
   * Hands back the diagram as a standalone SVG string, framed to its own
   * content rather than to the reader's current view.
   *
   * A ref rather than a prop the shell renders, for the same reason
   * viewCenterRef is one: the shell needs to ASK the canvas something at the
   * moment a button is pressed, and nothing should re-render to make that
   * possible.
   */
  exportSvgRef?: MutableRefObject<(() => string | null) | null>;
  /** Fires when a tool is armed or disarmed, including by the N and B keys. */
  onToolChange?: (tool: 'note' | 'section' | null) => void;
  /**
   * Bumped by the shell when the diagram was replaced wholesale (a preset
   * load) and the camera should re-frame the new content. Node edits never
   * bump it, so add/delete/undo keep the camera still. See the fit effect.
   */
  fitSignal?: number;
  /**
   * Optional: an element whose bounding rect is the part of the canvas NOT
   * covered by the shell's floating panels (the .stage-safe sentinel). The
   * canvas MEASURES it whenever it aims the camera itself: zoom-to-fit
   * frames content inside this rect, palette clicks and off-pointer pastes
   * land at its centre, keyboard zoom pivots on it. It is never subscribed
   * to: a panel toggle changes the rect but must not move the camera.
   * Omitted, the whole surface is treated as visible.
   */
  visibleRef?: RefObject<HTMLElement | null>;
  /**
   * Parts "Can you break it?" is aiming at, by node or edge id: 0 for the
   * schedule being tried now, drawn as a dashed ring, and 1, 2, 3 for the
   * faults of a break it found, drawn as numbered badges.
   */
  breakMarks?: ReadonlyMap<string, number>;
  /** The starting points an empty canvas offers. Omitted, it offers none. */
  emptyActions?: EmptyCanvasProps['actions'];
  /**
   * A brief is on screen. A fit may then zoom out past the usual floor
   * rather than leave a box under the brief's panel; see FIT_MIN_TIGHT.
   */
  fitTight?: boolean;
  /**
   * A node to point at: a ring and a "Here" tag around it, drawn above the
   * nodes and never hit-tested. Set by the shell's "Find the problem", and
   * panned into view when it changes. Null or absent draws nothing.
   */
  spotlightId?: string | null;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const outPort = (n: SimNode) => ({ x: n.x + NODE_W, y: n.y + PORT_CY });

/** A node's box in the router's terms. */
const nodeRect = (n: SimNode) => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H });

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/** True when the event should not be intercepted by a canvas key handler. */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

/* ------------------------------------------------------------------ *
 * Readouts.
 *
 * Five live values per node, all from fields the engine already computes.
 * The previous two-value readout discarded eleven of thirteen NodeStats
 * fields — including `queued`, the backlog that three of the five presets
 * exist to teach.
 * ------------------------------------------------------------------ */

interface Cell {
  value: string;
  label: string;
}

interface Readout {
  primary: Cell;
  a: Cell;
  b: Cell;
  /** 0..1. Drives the meter width and the health band. */
  load: number;
  /** Health of the primary metric specifically. */
  health: Health;
  /** Value the sparkline plots, in the primary's units. */
  spark: number;
  /**
   * True when `spark` is a 0..1 fraction and the sparkline should plot it
   * against a fixed unit domain; false for counts and rates, which autoscale.
   */
  sparkUnit: boolean;
  /** True when traffic is actively being lost here. */
  losing: boolean;
}

/** A safe 0..1 ratio: 0 whenever the denominator cannot support one. */
function frac(n: number, d: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return clamp(n / d, 0, 1);
}

/**
 * The worse of two healths, so a kind can combine "how loaded" with "is it
 * refusing work" without either channel masking the other.
 */
function worstHealth(a: Health, b: Health): Health {
  if (a === 'danger' || b === 'danger') return 'danger';
  if (a === 'warn' || b === 'warn') return 'warn';
  return 'ok';
}

/**
 * The share of a blocking node's slots that are taken, working or waiting on
 * a call it made, or `util` for a node that cannot wait (the field is absent).
 */
export function heldShare(s: NodeStats, cfg: NodeConfig, util: number): number {
  const waiting = s.waitingOnDownstream;
  if (waiting === undefined) return util;
  const slots =
    cfg.capacity * Math.max(1, Math.floor(s.instances ?? cfg.instances ?? 1));
  if (!(slots > 0)) return util;
  return Math.max(util, clamp((s.inFlight + waiting) / slots, 0, 1));
}

/**
 * What the three numbers on a node MEAN, per kind.
 *
 * This switch is deliberately EXHAUSTIVE over NodeKind, with no default for
 * real kinds: the compiler proves every kind has a readout (see the `never`
 * check after the switch), so a future kind cannot silently fall back to the
 * generic utilisation triple. That fallback is exactly what made the
 * autoscaler read "0% util, 0ms p99, 0 queue" forever and look broken, and
 * the same all-zero triple was being printed on the cron, the region, the
 * rate limiter, the breaker and every other kind that serves no requests.
 *
 * Ground rules, learned the hard way:
 *  - never show a number that is structurally always zero for this kind;
 *  - a word ("open", "warming", "dark") is a legitimate value when the word
 *    is the truth;
 *  - the meter and health must be driven by what actually means trouble for
 *    THIS kind, never by a utilisation that is hardwired to zero;
 *  - `losing` must include the kind's own refusal channel (throttled,
 *    rejected, conn-refused, retention drops...), not just shed/timeout,
 *    which no gate kind ever sets;
 *  - values stay about as short as "23ms" or "3/5"; a longer word gets the
 *    cell to itself with an empty value.
 *
 * `backlog` is the summed depth of the buffer nodes feeding a pull-based
 * consumer (worker, transcoder). Their own queue is structurally always 0;
 * the work they are behind on lives in the queues that feed them.
 *
 * `route` is a client's own end-to-end figures, from `Engine.routes()`.
 */
export function readoutFor(
  kind: NodeKind,
  s: NodeStats,
  cfg: NodeConfig,
  backlog = 0,
  route: RouteStats | null = null,
): Readout {
  const util = clamp(s.utilization, 0, 1);
  const losing = s.shedRate + s.timeoutRate > 0;
  /* A node that blocks on its calls keeps a slot taken for the whole wait on
     them, and that wait is not work, so utilisation alone read a server with
     every slot held, shedding half its traffic, as 6% busy and green. The
     headline keeps meaning work; the meter and health follow the share of
     slots taken, whichever is higher. waitingOnDownstream is published only
     where waiting can happen, so every other node reads exactly as before. */
  const held = heldShare(s, cfg, util);

  switch (kind) {
    case 'client': {
      /* With its own requests settling, a client reads as the people behind
         it see the system: how slow the slowest of their requests are and
         how many fail, counting every timeout anywhere along the way. The
         node's own error rate leaves out a timeout that a node further down
         gave up on. */
      if (route !== null && route.goodputRps + route.failedRps > 0) {
        const err = clamp(route.errorRate, 0, 1);
        const p99 = route.goodputRps > 0 ? route.p99 : null;
        return {
          primary: { value: formatRate(route.offeredRps), label: 'sent' },
          // With nothing succeeding there is no p99 to show, and a 0ms one
          // would read as instant.
          a:
            p99 !== null
              ? { value: formatMs(p99), label: 'p99' }
              : { value: formatRate(0), label: 'ok' },
          b: { value: formatPct(err), label: 'failing' },
          load: err,
          health: worstHealth(healthOfErr(err), healthOfLatency(p99)),
          spark: s.arrivalRate,
          sparkUnit: false,
          losing: err > 0,
        };
      }
      // Nothing sent and nothing settling: a percentage would be of nothing.
      if (route !== null && route.offeredRps === 0) {
        return {
          primary: { value: formatRate(0), label: 'sent' },
          a: { value: formatRate(0), label: 'ok' },
          b: { value: 'idle', label: '' },
          load: 0,
          health: 'ok',
          spark: s.arrivalRate,
          sparkUnit: false,
          losing: false,
        };
      }
      const err = clamp(s.errorRate, 0, 1);
      /* The headline is what the client is SENDING, not what came back.
         Throughput counts successes, so during a total collapse it is
         genuinely 0 and the node read "0/s rps, 100% err", which looks like a
         client that has stopped generating load rather than one whose every
         request is dying. Offered load is the honest headline; the success
         rate belongs beside it, where the contrast between the two is the
         thing worth seeing. */
      return {
        primary: { value: formatRate(s.arrivalRate), label: 'sent' },
        a: { value: formatRate(s.throughput), label: 'ok' },
        b: { value: formatPct(err), label: 'failing' },
        load: err,
        health: healthOfErr(err),
        spark: s.arrivalRate,
        sparkUnit: false,
        // The err cell already shows the loss; the indicator must agree.
        losing: losing || err > 0,
      };
    }

    /* A load balancer's own utilisation is structurally ~0: 256 half-ms
       slots mean the meter cannot move below thousands of rps (measured
       0.000 at 100 rps). Throughput is the number that lives; util still
       drives the meter because it CAN saturate, and when it does the primary
       is not the place the story shows first anyway. */
    case 'lb':
      return {
        primary: { value: formatRate(s.throughput), label: 'served' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatCount(s.queued), label: 'waiting' },
        load: util,
        health: healthOfLoad(util),
        spark: s.throughput,
        sparkUnit: false,
        losing,
      };

    case 'cache': {
      const hit = clamp(s.hitRate, 0, 1);
      // A cache's meter shows misses: an empty bar is a cache doing its job.
      const miss = 1 - hit;
      return {
        primary: { value: formatPct(hit), label: 'hit' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatRate(s.throughput), label: 'served' },
        load: miss,
        health: healthOfLoad(miss),
        spark: hit,
        sparkUnit: true,
        losing,
      };
    }

    case 'queue': {
      const depth = s.queued + s.inFlight;
      // Divide by the node's own limit. The old hardcoded 500 was wrong for
      // every preset: the real limits are 5000, 512, 256, 128, 96, 64, 48, 32.
      const limit = cfg.queueLimit > 0 ? cfg.queueLimit : 1;
      const fill = clamp(depth / limit, 0, 1);
      return {
        primary: { value: formatCount(depth), label: 'waiting' },
        a: { value: formatRate(s.arrivalRate), label: 'in' },
        b: { value: formatRate(s.throughput), label: 'out' },
        load: fill,
        health: healthOfLoad(fill),
        spark: depth,
        sparkUnit: false,
        losing,
      };
    }

    /**
     * A shard reports its HOTTEST partition, not its mean.
     *
     * The mean is the number that lies. Measured on the real engine at
     * hotKeyFraction 0.85 with 8 partitions: the node mean sat at 0.17 —
     * comfortably "ok", green meter, nothing to see — while partition 0 was
     * pinned at 1.00. A student watching the mean would conclude the store
     * had 83% headroom at the exact moment one partition was melting.
     *
     * So the primary is the max, the meter is driven by the max, and health
     * is judged on the max. The strip beside it shows the spread that the
     * single number cannot, and `min` is reported next to it precisely so the
     * GAP between them is legible: 100% hot against 0% cold is the signature
     * of a hot key, and it is unmissable when both are printed.
     */
    case 'shard': {
      const hot = clamp(s.maxShardUtilization, 0, 1);
      /* Strip kind: `a` is the single cell drawn beside the primary (the
         partition strip occupies the secondary row). Coldest next to hottest
         is what makes a hot key legible: 100% against 0% is the signature. */
      return {
        primary: { value: formatPct(hot), label: 'hot' },
        a: { value: formatPct(clamp(s.minShardUtilization, 0, 1)), label: 'cold' },
        b: { value: formatCount(s.queued), label: 'waiting' },
        load: hot,
        health: healthOfLoad(hot),
        spark: hot,
        sparkUnit: true,
        losing,
      };
    }

    /**
     * A replica set reports its stale-read rate when there is one.
     *
     * Replication lag is the entire reason a read replica is a different
     * component from a database, and it was previously invisible. It is shown
     * only when non-zero: a synchronous set (replicationLagMs 0) never goes
     * stale, and printing "0% stale" on it forever would train the student to
     * stop reading the field before it ever had something to say.
     */
    case 'replica': {
      const stale = clamp(s.staleReadRate, 0, 1);
      /* Strip kind: `a` rides beside the primary. Stale reads are the whole
         reason a replica set is its own component, so they take the cell the
         moment they exist; p99 fills it on a synchronous set. */
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a:
          stale > 0
            ? { value: formatPct(stale), label: 'stale' }
            : { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatCount(s.queued), label: 'waiting' },
        load: util,
        health: healthOfLoad(util),
        spark: util,
        sparkUnit: true,
        losing,
      };
    }

    case 'autoscaler': {
      /* A controller serves no requests, so utilisation, p99 and queue depth
         are all permanently zero for it. Showing them made the autoscaler look
         broken and identical to every other box. What it is actually doing is
         watching someone else's utilisation against a setpoint, so report
         that instead: the number it is reacting to, the fleet size it wants,
         and what it is doing about it right now. */
      const watched = clamp(s.watchedUtil ?? 0, 0, 1);
      const setpoint = s.setpoint ?? 0.7;
      const want = s.targetInstances ?? 0;
      const have = s.watchedInstances ?? 0;

      // Distance from setpoint drives the meter, so the node reads calm when
      // the controller has converged and hot when it is chasing a spike.
      const drift = setpoint > 0 ? clamp(watched / setpoint, 0, 1) : 0;

      /* The secondary row is two texts anchored to opposite edges of the node,
         so they grow toward each other and collide if either is wordy. Both
         cells here must stay about as short as "23ms" and "p99". An earlier
         version put the phase word in the value slot AND a "scaling up" label
         beside it, which overlapped into mush at real fleet sizes. */
      const phase = s.scalePhase ?? 'idle';
      return {
        primary: { value: formatPct(watched), label: 'watching' },
        a: { value: `${have}/${want}`, label: 'pods' },
        b: { value: '', label: phase },
        load: drift,
        health: healthOfLoad(drift),
        spark: watched,
        sparkUnit: true,
        losing: false,
      };
    }

    /* The generic triple is honestly right for a plain server: it has slots,
       a queue and a latency, and all three move. */
    case 'service':
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: { value: formatCount(s.queued), label: 'waiting' },
        load: held,
        health: healthOfLoad(held),
        spark: util,
        sparkUnit: true,
        losing,
      };

    /* A database is a service plus the write lock. While contention is quiet
       the triple reads like a server's; once writes start waiting on each
       other, that wait takes the b cell, because it is the number a fleet
       slider cannot fix. */
    case 'db': {
      const lockWait = s.lockWaitMs ?? 0;
      const contended = lockWait >= 1;
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b: contended
          ? { value: formatMs(lockWait), label: 'lock' }
          : { value: formatCount(s.queued), label: 'waiting' },
        load: util,
        health:
          contended && lockWait > s.p50
            ? worstHealth(healthOfLoad(util), 'warn')
            : healthOfLoad(util),
        spark: util,
        sparkUnit: true,
        losing,
      };
    }

    /* Blob storage refuses per PREFIX, and can do so with the pool idle; a
       readout built on utilisation alone would look healthy through it. */
    case 'objectstore': {
      const slowdown = s.slowdownRate ?? 0;
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a: { value: formatMs(s.p99), label: 'p99' },
        b:
          slowdown > 0
            ? { value: formatRate(slowdown), label: 'refused' }
            : { value: formatCount(s.queued), label: 'waiting' },
        load: util,
        health: slowdown > 0 ? 'danger' : healthOfLoad(util),
        spark: slowdown > 0 ? slowdown : util,
        sparkUnit: slowdown === 0,
        losing: losing || slowdown > 0,
      };
    }

    /* A worker's own queue cell is structurally ALWAYS zero: the work it is
       behind on lives in the queue nodes feeding it. Show that backlog. */
    case 'worker':
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a: { value: formatRate(s.throughput), label: 'done' },
        b: { value: formatCount(backlog), label: 'waiting' },
        load: held,
        health: healthOfLoad(held),
        spark: util,
        sparkUnit: true,
        losing,
      };

    /* The batch regime: jobs take seconds, so "how many are running and how
       far behind are we" is the reading, not a per-request latency. */
    case 'transcoder': {
      const stuck = util >= 0.999 && backlog > 0;
      return {
        primary: { value: formatCount(s.inFlight), label: 'jobs' },
        a: { value: formatCount(backlog), label: 'waiting' },
        b: { value: formatMs(s.p50), label: 'per job' },
        load: util,
        health: stuck ? 'danger' : healthOfLoad(util),
        spark: backlog,
        sparkUnit: false,
        losing,
      };
    }

    /* A failover switch. During the dark window the old readout showed "0%
       util", healthy, losing nothing, in the middle of a TOTAL outage. */
    case 'region': {
      const total = s.regionsTotal ?? 1;
      const healthy = s.regionsHealthy ?? total;
      const dark = s.failingOver === true;
      const err = clamp(s.errorRate, 0, 1);
      return {
        primary: dark
          ? { value: 'dark', label: 'failover' }
          : { value: `R${s.activeRegion ?? 0}`, label: 'serving' },
        a: { value: `${healthy}/${total}`, label: 'healthy' },
        b: dark
          ? { value: formatMs(s.failoverRemainingMs), label: 'back in' }
          : { value: formatRate(s.throughput), label: 'served' },
        load: dark ? 1 : 1 - frac(healthy, total),
        health: dark || healthy === 0 ? 'danger' : healthy < total ? 'warn' : 'ok',
        spark: err,
        sparkUnit: true,
        losing: dark || err > 0,
      };
    }

    /* An edge cache: its meter can essentially never move (cap 256), but the
       origin-fetch rate is the load that actually reaches your servers. */
    case 'cdn': {
      const hit = clamp(s.hitRate, 0, 1);
      const miss = 1 - hit;
      return {
        primary: { value: formatPct(hit), label: 'hit' },
        a: { value: formatRate(s.originFetchRate), label: 'origin' },
        b: { value: formatRate(s.throughput), label: 'served' },
        load: miss,
        health: healthOfLoad(miss),
        spark: hit,
        sparkUnit: true,
        losing,
      };
    }

    /* A token bucket. Utilisation is hardwired 0 and its p99 is its
       downstream's number; what it DOES is admit and refuse. Measured while
       the old readout said "util 0%, healthy": refusing 93 rps. */
    case 'ratelimiter': {
      const throttled = s.throttledRate ?? 0;
      const admitted = s.admittedRate ?? 0;
      const burst = cfg.burst ?? cfg.rateLimitRps ?? 1;
      return {
        primary: { value: formatRate(throttled), label: 'refused' },
        a: { value: formatRate(admitted), label: 'passed' },
        b: { value: formatCount(s.tokens), label: 'tokens' },
        // A drained bucket is a limiter working hard; a full one is idle.
        load: 1 - frac(s.tokens ?? 0, burst),
        health: throttled <= 0 ? 'ok' : throttled < admitted ? 'warn' : 'danger',
        spark: throttled,
        sparkUnit: false,
        losing: throttled > 0,
      };
    }

    /* The circuit's state IS the component. A word beats a number here. */
    case 'breaker': {
      const state = s.breakerState ?? 'closed';
      const errRate = clamp(s.breakerErrorRate ?? 0, 0, 1);
      const rejected = s.rejectedRate ?? 0;
      const threshold = cfg.errorThreshold ?? 0.5;
      // How close the window is to tripping; pinned full while open.
      const strain = state === 'closed' ? frac(errRate, threshold) : 1;
      return {
        primary:
          state === 'open'
            ? { value: 'OPEN', label: 'circuit' }
            : state === 'half-open'
              ? { value: 'probing', label: 'circuit' }
              : { value: 'closed', label: 'circuit' },
        a: { value: formatPct(errRate), label: 'dep fails' },
        b:
          state === 'open'
            ? { value: formatRate(rejected), label: 'refused' }
            : { value: formatCount(s.breakerTrips), label: 'trips' },
        load: strain,
        health:
          state === 'open'
            ? 'danger'
            : state === 'half-open'
              ? 'warn'
              : healthOfLoad(strain),
        spark: errRate,
        sparkUnit: true,
        losing: rejected > 0,
      };
    }

    /* The refresh lag made visible: measured 37% of searches stale while the
       node showed nothing but "util 25%". */
    case 'searchindex': {
      const stale = clamp(s.staleSearchRate ?? 0, 0, 1);
      return {
        primary: { value: formatPct(stale), label: 'stale' },
        a: { value: formatRate(s.searchRate), label: 'search' },
        b: { value: formatRate(s.indexWriteRate), label: 'index' },
        load: util,
        health: worstHealth(healthOfLoad(util), stale > 0.2 ? 'warn' : 'ok'),
        spark: stale,
        sparkUnit: true,
        losing,
      };
    }

    /* Two-class cost: the append firehose and the range queries that melt it. */
    case 'timeseriesdb':
      return {
        primary: { value: formatPct(util), label: 'busy' },
        a: { value: formatRate(s.appendRate), label: 'append' },
        b: { value: formatRate(s.rangeQueryRate), label: 'range' },
        load: util,
        health: healthOfLoad(util),
        spark: util,
        sparkUnit: true,
        losing,
      };

    /* The depth multiplier, measured: what one traversal actually costs. */
    case 'graphdb':
      return {
        primary: { value: formatMs(s.traversalCostMs), label: 'query' },
        a: { value: formatPct(util), label: 'busy' },
        b: { value: formatRate(s.throughput), label: 'served' },
        load: util,
        health: healthOfLoad(util),
        spark: s.traversalCostMs ?? 0,
        sparkUnit: false,
        losing,
      };

    /* Multi-second retrieval is this component's entire identity, so the
       measured latency takes the headline. There is no queue to report: the
       vault runs restore jobs against a quota and refuses the excess, so the
       b cell carries the refusals once they start. */
    case 'coldstorage': {
      const denied = s.throttledRate ?? 0;
      return {
        primary: { value: formatMs(s.p99), label: 'restore' },
        a: { value: formatPct(util), label: 'busy' },
        b:
          denied > 0
            ? { value: formatRate(denied), label: 'refused' }
            : { value: formatCount(s.inFlight), label: 'jobs' },
        load: util,
        health: denied > 0 ? 'danger' : healthOfLoad(util),
        spark: util,
        sparkUnit: true,
        losing: losing || denied > 0,
      };
    }

    /* The recall slider read backwards: measured cost per query. */
    case 'vectordb':
      return {
        primary: { value: formatMs(s.queryCostMs), label: 'query' },
        a: { value: formatPct(util), label: 'busy' },
        b: { value: formatRate(s.throughput), label: 'served' },
        load: util,
        health: healthOfLoad(util),
        spark: s.queryCostMs ?? 0,
        sparkUnit: false,
        losing,
      };

    /* Strip kind: the partition strip carries the spread; `a` is the single
       cell beside the primary. Lag against retention is the meter, and a
       retention drop is data loss, not lateness: it forces danger. */
    case 'streambroker': {
      const lag = s.consumerLag ?? 0;
      const dropRate = s.retentionDropRate ?? 0;
      const fill = frac(lag, s.queueLimit);
      return {
        primary: { value: formatCount(lag), label: 'lag' },
        a:
          dropRate > 0
            ? { value: formatRate(dropRate), label: 'lost' }
            : { value: formatRate(s.deliveryRate), label: 'deliver' },
        b: { value: formatRate(s.throughput), label: 'publish' },
        load: fill,
        health: dropRate > 0 ? 'danger' : healthOfLoad(fill),
        spark: lag,
        sparkUnit: false,
        losing: dropRate > 0 || losing,
      };
    }

    /* One publish in, fanout deliveries out. The amplification IS the
       component; a topic has no fill of its own, so the meter stays flat. */
    case 'pubsub':
      return {
        primary: { value: formatRate(s.deliveryRate), label: 'out' },
        a: { value: formatRate(s.throughput), label: 'in' },
        b: { value: `x${s.fanout ?? 0}`, label: 'fan-out' },
        load: 0,
        health: 'ok',
        spark: s.deliveryRate ?? 0,
        sparkUnit: false,
        losing: false,
      };

    /* The scarce resource is connections HELD, not requests per second.
       Measured at saturation the old readout said "util 100%, p99 0ms,
       queue 0" and losing=false while refusing 11 conn/s. */
    case 'websocket': {
      const open = s.connectionsOpen ?? 0;
      const max = s.maxConnections ?? 0;
      const refused = s.connectionRejectRate ?? 0;
      const fill = frac(open, max);
      return {
        primary: { value: formatCount(open), label: 'conns' },
        a: { value: formatCount(max), label: 'slots' },
        b:
          refused > 0
            ? { value: formatRate(refused), label: 'refused' }
            : { value: formatRate(s.connectRate), label: 'new' },
        load: fill,
        health: refused > 0 ? 'danger' : healthOfLoad(fill),
        spark: fill,
        sparkUnit: true,
        losing: refused > 0,
      };
    }

    /* The front door: admitted against the two reasons it refuses. Its own
       utilisation is structurally ~0 (measured 0.008 at 353 rps). */
    case 'apigateway': {
      const admitted = s.admittedRate ?? 0;
      const throttled = s.throttledRate ?? 0;
      const badAuth = s.authRejectRate ?? 0;
      const burst = cfg.burst ?? cfg.rateLimitRps ?? 1;
      return {
        primary: { value: formatRate(admitted), label: 'passed' },
        a: { value: formatRate(throttled), label: 'limited' },
        b: { value: formatRate(badAuth), label: 'denied' },
        load: 1 - frac(s.tokens ?? 0, burst),
        health: throttled > admitted ? 'danger' : throttled > 0 ? 'warn' : 'ok',
        spark: admitted,
        sparkUnit: false,
        losing: throttled + badAuth > 0,
      };
    }

    /* Envoy-style outlier ejection: the proxy's state in a word, plus the
       failure rate it is judging its upstream by. */
    case 'sidecar': {
      const state = s.breakerState ?? 'closed';
      const fails = s.upstreamFailRate ?? 0;
      const rejected = s.rejectedRate ?? 0;
      const after = Math.max(1, cfg.outlierAfter ?? 5);
      const strain = state === 'closed' ? frac(s.consecutiveFails ?? 0, after) : 1;
      return {
        primary:
          state === 'open'
            ? { value: 'EJECTED', label: 'upstream' }
            : state === 'half-open'
              ? { value: 'probing', label: 'upstream' }
              : { value: 'proxying', label: '' },
        a: { value: formatRate(fails), label: 'fails' },
        b:
          state === 'open'
            ? { value: formatRate(rejected), label: 'refused' }
            : { value: formatMs(s.p99), label: 'p99' },
        load: strain,
        health:
          state === 'open'
            ? 'danger'
            : state === 'half-open' || strain > 0
              ? 'warn'
              : 'ok',
        spark: fails,
        sparkUnit: false,
        losing: rejected > 0,
      };
    }

    /* Serverless: the cold-start story was invisible behind "util 45%". */
    case 'lambda': {
      const cold = clamp(s.coldStartRate ?? 0, 0, 1);
      const running = s.runningNow ?? 0;
      const cap = Math.max(1, cfg.maxConcurrency ?? 1);
      const throttled = s.throttledRate ?? 0;
      const fill = frac(running, cap);
      return {
        primary: { value: formatPct(cold), label: 'cold' },
        a: { value: `${formatCount(running)}/${formatCount(cap)}`, label: 'running' },
        b:
          throttled > 0
            ? { value: formatRate(throttled), label: 'refused' }
            : { value: formatCount(s.warmIdle), label: 'warm' },
        load: fill,
        health:
          throttled > 0
            ? 'danger'
            : worstHealth(healthOfLoad(fill), cold > 0.5 ? 'warn' : 'ok'),
        spark: cold,
        sparkUnit: true,
        losing: throttled > 0,
      };
    }

    /* A job on a clock. The countdown is the movement: between firings the
       node used to sit at "0% util, 0ms p99, 0 queue" forever, the exact
       all-zero box the autoscaler was before its fix. */
    case 'cron': {
      const interval = Math.max(1, cfg.intervalMs ?? 20000);
      const next = s.nextFireInMs ?? interval;
      return {
        primary: { value: formatMs(next), label: 'next run' },
        a: { value: formatCount(s.burstSize), label: 'burst' },
        b: { value: formatCount(s.batchEmitted), label: 'sent' },
        // Fills toward the firing, like a fuse. A cron is never unhealthy.
        load: 1 - frac(next, interval),
        health: 'ok',
        spark: s.batchEmitted ?? 0,
        sparkUnit: false,
        losing: false,
      };
    }

    /* Pool occupancy is the earliest possible warning a dependency slowed:
       the pool fills within one round trip, long before errors show. Its
       p99 IS the dependency's, which is the number the pool protects. */
    case 'bulkhead': {
      const inUse = s.bulkheadInFlight ?? 0;
      const limit = s.bulkheadLimit ?? 0;
      const refused = s.bulkheadRejectedRate ?? 0;
      const fill = frac(inUse, limit);
      return {
        primary: {
          value: `${formatCount(inUse)}/${formatCount(limit)}`,
          label: 'pool',
        },
        a: { value: formatRate(refused), label: 'refused' },
        b: { value: formatMs(s.p99), label: 'p99' },
        load: fill,
        health: refused > 0 ? 'danger' : healthOfLoad(fill),
        spark: fill,
        sparkUnit: true,
        losing: refused > 0,
      };
    }

    /* Failures with somewhere to go: the dead-letter shelf is the bill, the
       redelivery rate the early warning that it is about to grow. */
    case 'retryqueue': {
      const dead = s.deadLetters ?? 0;
      const deadRate = s.deadLetterRate ?? 0;
      const redeliver = s.redeliveryRate ?? 0;
      const fill = frac(s.queued, s.queueLimit);
      return {
        primary: { value: formatCount(dead), label: 'dead' },
        a: { value: formatRate(s.deliveredRate), label: 'deliver' },
        b: { value: formatRate(redeliver), label: 'retry' },
        load: fill,
        health:
          deadRate > 0
            ? 'danger'
            : worstHealth(healthOfLoad(fill), redeliver > 0 ? 'warn' : 'ok'),
        spark: dead,
        sparkUnit: false,
        losing: deadRate > 0 || losing,
      };
    }

    /* The split is the component: what the PoP answers against what still
       pays the full origin path. */
    case 'edgecompute': {
      const handled = s.edgeHandledRate ?? 0;
      const passed = s.passedThroughRate ?? 0;
      const share = frac(handled, handled + passed);
      return {
        primary: { value: formatPct(share), label: 'at edge' },
        a: { value: formatRate(passed), label: 'origin' },
        b: { value: formatMs(s.p99), label: 'p99' },
        // The meter shows what still reaches the origin; its own small pool
        // can also melt, which health tracks separately.
        load: 1 - share,
        health: healthOfLoad(util),
        spark: share,
        sparkUnit: true,
        losing,
      };
    }

    /* Every dirty write is a write the caller was told is safe and a crash
       would lose. That population is the headline, not a generic queue. */
    case 'writebehind': {
      const failRate = s.flushFailRate ?? 0;
      return {
        primary: { value: formatCount(s.dirtyWrites), label: 'at risk' },
        a: { value: formatRate(s.flushedRate), label: 'flushed' },
        b: { value: formatRate(s.throughput), label: 'acked' },
        // Utilisation here genuinely means buffer fill (measured 0.146 with
        // 44 dirty writes), so the meter keeps it.
        load: util,
        health: failRate > 0 ? 'danger' : healthOfLoad(util),
        spark: s.dirtyWrites ?? 0,
        sparkUnit: false,
        losing: losing || failRate > 0,
      };
    }

    /* Triage in numbers: low-priority drops are the component doing its job;
       any high-priority drop means the protection is exhausted. */
    case 'loadshedder': {
      const lowShed = s.lowSheddedRate ?? 0;
      const highShed = s.highSheddedRate ?? 0;
      const highIn = s.highAdmittedRate ?? 0;
      const burst = cfg.burst ?? cfg.rateLimitRps ?? 1;
      return {
        primary: { value: formatRate(lowShed), label: 'shed low' },
        a: { value: formatRate(highIn), label: 'high in' },
        b:
          highShed > 0
            ? { value: formatRate(highShed), label: 'shed high' }
            : { value: formatCount(s.tokens), label: 'tokens' },
        load: 1 - frac(s.tokens ?? 0, burst),
        health: highShed > 0 ? 'danger' : lowShed > 0 ? 'warn' : 'ok',
        spark: lowShed + highShed,
        sparkUnit: false,
        losing: lowShed + highShed > 0,
      };
    }
  }

  /* Compile-time exhaustiveness: if a NodeKind is ever added without a case
     above, `kind` no longer narrows to `never` here and the build fails,
     which is precisely what stops the dead-box bug returning. The runtime
     fallback below it can then only be reached by data from outside the
     type system (a corrupted save), and shows the generic triple rather
     than crashing the canvas. */
  return ((k: never): Readout => {
    void k;
    return {
      primary: { value: formatPct(util), label: 'busy' },
      a: { value: formatMs(s.p99), label: 'p99' },
      b: { value: formatCount(s.queued), label: 'waiting' },
      load: util,
      health: healthOfLoad(util),
      spark: util,
      sparkUnit: true,
      losing,
    };
  })(kind);
}

/**
 * Summed buffer depth feeding each pull-based consumer, keyed by node id.
 *
 * A worker's own `queued` is structurally ALWAYS zero: it pulls, so its
 * backlog lives in the queue nodes wired to it. The engine knows this
 * (its pump walks `sources`) but does not publish the sum, so it is derived
 * here from the same wiring rule buildNodes() uses: a neighbour in EITHER
 * direction whose kind buffers for consumers. Pure snapshot reads only, so
 * the readout can never perturb the simulation.
 *
 * Exported for App.tsx, whose sparkline recorder plots the same series the
 * readout headlines.
 */
export function sourceBacklogs(
  topology: Topology,
  nodes: Record<string, NodeStats>,
): Map<string, number> {
  const out = new Map<string, number>();
  const kindById = new Map<string, NodeKind>();
  for (const n of topology.nodes) kindById.set(n.id, n.kind);

  const add = (consumerId: string, bufferId: string) => {
    const s = nodes[bufferId];
    if (!s) return;
    out.set(consumerId, (out.get(consumerId) ?? 0) + Math.max(0, s.queued));
  };

  for (const e of topology.edges) {
    if (e.control) continue;
    const fromKind = kindById.get(e.from);
    const toKind = kindById.get(e.to);
    if (!fromKind || !toKind) continue;
    // buffer -> consumer, and consumer -> buffer: the engine accepts both
    // drawings, so the readout must too.
    if (
      behaviourFor(toKind).pullsFromQueues &&
      behaviourFor(fromKind).buffersForConsumers
    ) {
      add(e.to, e.from);
    } else if (
      behaviourFor(fromKind).pullsFromQueues &&
      behaviourFor(toKind).buffersForConsumers
    ) {
      add(e.from, e.to);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Sparkline
 * ------------------------------------------------------------------ */

/** Round up to a friendly ceiling so the y-domain does not jitter each sample. */
function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

interface SparkProps {
  data: ArrayLike<number> | undefined;
  /** Fractions (utilization, hit rate) prefer a fixed 0..1 domain. */
  unit: boolean;
}

const Spark = memo(function Spark({ data, unit }: SparkProps) {
  const points = useMemo(() => {
    if (!data || data.length < 2) return '';
    let max = 0;
    let filled = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      filled += 1;
      if (v > max) max = v;
    }
    // A single sample is a dot, not a trend; draw nothing until there are two.
    if (filled < 2) return '';
    /**
     * Fractional series read against a fixed 0..1 domain, so a node at 20%
     * looks like a node at 20% rather than being auto-scaled to fill the box.
     *
     * The exception is a series that never leaves the bottom of that domain —
     * a load balancer runs at ~0.01% utilization, and against a domain of 1
     * every sample lands on the baseline, producing a flat line that cannot
     * show variation no matter what the node does. Below 10% the domain
     * relaxes to the data so the trace still carries information.
     */
    const top = unit && max >= 0.1 ? 1 : niceCeil(max * 1.15);
    const n = data.length;
    const out: string[] = [];
    // Only sampled slots are plotted. The newest sample stays pinned to the
    // right edge and the trace grows leftwards as history accumulates, so a
    // 5-second-old node shows a short honest trace instead of a full-width
    // line that is mostly fabricated zeros.
    for (let i = n - filled; i < n; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) continue;
      const x = filled > 1 ? ((i - (n - filled)) / (filled - 1)) * SPARK_W : SPARK_W;
      const y = SPARK_H - clamp(v / top, 0, 1) * SPARK_H;
      out.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return out.join(' ');
  }, [data, unit]);

  return (
    <g transform={`translate(${SPARK_X},${SPARK_Y})`}>
      <line
        className="cv-spark-base"
        x1={0}
        y1={SPARK_H + 0.5}
        x2={SPARK_W}
        y2={SPARK_H + 0.5}
      />
      {points && <polyline className="cv-spark" points={points} />}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Glyph
 * ------------------------------------------------------------------ */

/**
 * Rendered glyph size, in world units.
 *
 * 18, not 14. The set was rendered and inspected at both: at 14px the denser
 * icons (the globe, the film frame, the calendar-clock) close up into solid
 * blobs, because the stroke eats too much of a 14px box. 18px is the
 * smallest size at which the whole set stays distinguishable, and it is
 * also the header's 14px name cap-height plus its 4px breathing room, so
 * the icon and the name read as one line.
 */
const GLYPH_PX = 18;
const GLYPH_SCALE = GLYPH_PX / ICON_BOX;

/* --------------------------------------------------------------------------
   Header geometry — ONE definition, shared by every element on the line.

   The glyph, the name, the status mark and the instance badge all sit on the
   header row, and each used to compute its own position. They disagreed:
   measured at design scale, the glyph's ink centre landed at y=13.0 while the
   name's centre landed at 19.44, a 3.7px stagger that at 150% zoom read as
   the icon floating above its own label. The marks disagreed too — the warn
   ring spanned 9.5-15.5 where the danger disc and fault square both spanned
   9-16, so the marker visibly changed size as a node degraded.

   Everything below is derived from HEAD_CENTER_Y, so the row cannot drift
   apart again.
   -------------------------------------------------------------------------- */

/** The optical centre line of the header row. Every element centres on this. */
const HEAD_CENTER_Y = 15;
/** Gap between the glyph and the name, and between the name and the badge. */
const NAME_GAP = 8;
/** Diameter of the status mark, so all three silhouettes match exactly. */
const MARK_SIZE = 7;
/** Horizontal room a status mark claims at the right edge, gap included. */
const MARK_RESERVE = MARK_SIZE + NAME_GAP;
/**
 * Optical centre of the icon grid, in grid units.
 *
 * MEASURED, across all 33 icons, with getBBox() on the rendered primitives:
 * ink centres land between 12.0 and 13.0 with a mean of 12.11 — never at the
 * grid's geometric centre of 12.0 by accident, and never far from it. Lucide
 * draws its ink slightly high in the 24-unit box, consistently.
 *
 * So the grid is aligned with that offset applied once, rather than each icon
 * being centred on its own ink. Two reasons for the grid and not the ink:
 * the spread is only 1.0 unit, which is a quarter-pixel once scaled, while
 * ink-centring would put a tall glyph and a short one on visibly different
 * lines; and the shared grid is exactly what makes 33 icons read as one
 * family, so it is the thing worth holding true.
 */
const GLYPH_INK_CENTER = 12.11;

/**
 * Top-left of the glyph box, placed so the icons' measured optical centre —
 * not the box's geometric centre — lands on the header line.
 */
const GLYPH_Y = HEAD_CENTER_Y - GLYPH_INK_CENTER * GLYPH_SCALE;

/**
 * Trim a node label to what actually fits on the node.
 *
 * Width is estimated rather than measured, deliberately. Measuring would mean
 * getComputedTextLength() on every node on every one of the 10Hz snapshots —
 * a forced synchronous layout per node per tick, which is precisely the kind
 * of thing that turns a smooth canvas into a stuttering one. An estimate that
 * is slightly conservative costs at most one character of a label; a layout
 * thrash costs frames.
 *
 * The badge is mono at 12px, the same style the badge itself renders in.
 */
const BADGE_STYLE: TextStyle = { size: 12, weight: 650, family: 'mono' };

/**
 * `badgeText` is the instance-count badge as actually rendered ("17x+1"),
 * whose width the name budget must reserve, and `hasMark` whether a status
 * mark occupies the corner.
 */
function truncateLabel(
  label: string,
  showHeader: boolean,
  badgeText: string,
  hasMark: boolean,
): string {
  const startX = showHeader ? PAD_X + GLYPH_PX + NAME_GAP : PAD_X;
  const reserve = showHeader
    ? (hasMark ? MARK_RESERVE : 0) +
      (badgeText ? measureText(badgeText, BADGE_STYLE) + NAME_GAP : 0)
    : 0;
  const avail = NODE_W - PAD_X - startX - reserve;
  return truncateToWidth(label, avail, NAME_STYLE);
}

/**
 * One kind icon, painted as raw SVG primitives inside the node's <svg>.
 *
 * A Lucide COMPONENT renders its own <svg> root, which inside another svg
 * would be a nested viewport with its own coordinate system; instead the
 * icon's primitive list (KIND_ICON, the same data the component is built
 * from) is painted straight into the positioned <g> the caller provides,
 * exactly the way the old hand-drawn <path> was. Stroke properties sit on
 * this group so each primitive inherits them; the few primitives that carry
 * their own fill (chart-scatter's points) keep it via the attribute
 * spread. Colour is always currentColor, so the surrounding token decides.
 *
 * memo on `kind` (a string) means the 10Hz snapshot re-renders skip this
 * subtree entirely; the primitives are only ever built when a node first
 * appears or changes kind.
 */
const Glyph = memo(function Glyph({ kind }: { kind: NodeKind }) {
  return (
    <g
      className="cv-glyph"
      fill="none"
      stroke="currentColor"
      // Lucide's native weight (2/24 of the box), stated in screen px
      // because .cv-glyph uses non-scaling-stroke to stay crisp under zoom.
      strokeWidth={(ICON_STROKE * GLYPH_PX) / ICON_BOX}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {KIND_ICON[kind].map(([tag, attrs], i) =>
        createElement(tag, { key: i, ...attrs }),
      )}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

/**
 * Edge routing lives in edgeRoute.ts as pure geometry (rects in, path out),
 * because anchors, path shape and arrowhead orientation are ONE coupled
 * decision: the router picks which SIDE of each box the wire leaves and
 * enters from the boxes' relative positions, builds the filleted orthogonal
 * run between them, and reports the arrival direction the arrowhead must
 * point along. See that module for the side-selection rule and thresholds.
 *
 * The wires still read as a bus: every path is straight legs plus shared
 * fillet radii, so the picture is built from a small vocabulary of repeated
 * shapes, which is what makes a schematic scan cleanly at a glance.
 */

/**
 * Stroke width from flow. Logarithmic so 10rps and 1000rps stay in one visual
 * family while still ranking unambiguously:
 *   0 -> 1.0   1 -> 1.26   10 -> 1.85   100 -> 2.71   1k -> 3.55   5k -> 4.16
 */
function edgeWidth(f: number): number {
  return f <= 0 ? 1 : clamp(1 + Math.log10(1 + f) * 0.85, 1, 4.5);
}

interface EdgeViewProps {
  edge: SimEdge;
  /** Top-left of the SOURCE node's box; the router picks its own anchors. */
  ax: number;
  ay: number;
  /** Top-left of the TARGET node's box. */
  bx: number;
  by: number;
  /**
   * -1 | 0 | +1. Non-zero when the reverse edge also exists: the pair is
   * shifted LANE_OFFSET to either side of the shared corridor so the two
   * wires and their arrowheads stay individually visible.
   */
  lane: number;
  flow: number;
  /**
   * Why this wire is or is not carrying traffic, straight from the engine.
   *
   * This is NOT derivable from `flow`, and assuming it was is the specific
   * dishonesty this prop exists to fix. Measured on the circuit-breaker
   * preset at 3x load: for 665 of 900 frames the breaker's downstream edge
   * was 'blocked', and `edgeFlow` on that edge read as high as 314 rps the
   * whole time — that number is traffic ARRIVING at the breaker and being
   * failed fast, not traffic crossing to payments. Drawing width from flow
   * alone painted the single most severed link on the canvas as one of the
   * thickest and busiest. State gates flow; it does not blend with it.
   */
  state: EdgeState;
  /**
   * True when this edge is a CONTROL relationship — an autoscaler driving the
   * node it resizes — rather than a request path. No request ever crosses it.
   */
  control: boolean;
  selected: boolean;
  /** Health of the TARGET node — a failing sink colors its inbound wire. */
  targetHealth: Health;
  showLabel: boolean;
  /**
   * Vertical offset for this edge's rate label, in world px. Two edges whose
   * midpoints coincide (a fan-out to two targets symmetric around the source
   * row anchors BOTH labels at the identical point; measured, three such
   * pairs in one topology rendered "3k/3k/s" garble) are de-conflicted by
   * the parent, which buckets anchors and staggers the collisions.
   */
  labelDy: number;
  /** See `CanvasProps.breakMarks`. Undefined when the edge is not a target. */
  breakMark?: number;
}

const EdgeView = memo(function EdgeView({
  edge,
  ax,
  ay,
  bx,
  by,
  lane,
  flow,
  state,
  control,
  selected,
  targetHealth,
  showLabel,
  labelDy,
  breakMark,
}: EdgeViewProps) {
  // The router arrives axis-aligned from whichever side it picked, so the
  // arrowhead is one of four fixed triangles and needs no trigonometry.
  // Memoised on the raw coordinates (scalars, so the memo around EdgeView
  // keeps working): a route only recomputes when an endpoint node moves.
  const route: EdgeRoute = useMemo(
    () =>
      routeEdge(
        { x: ax, y: ay, w: NODE_W, h: NODE_H },
        { x: bx, y: by, w: NODE_W, h: NODE_H },
        lane,
      ),
    [ax, ay, bx, by, lane],
  );
  const d = route.d;

  /**
   * A wire that cannot carry traffic is never drawn as if it might.
   *
   * `cut` and `blocked` are STRUCTURAL assertions the engine stands behind:
   * nothing is crossing, whatever `edgeFlow` says about what is arriving at
   * the source. Both therefore force the width to its minimum and kill the
   * flow animation outright, rather than being tinted variants of a live
   * wire. A control edge is the same case for a different reason — it is not
   * a request path at all — so it also never animates.
   */
  const severed = state === 'cut' || state === 'blocked';
  const width = severed || control ? 1 : edgeWidth(flow);
  const active = !severed && !control && flow > 0.05;

  /**
   * Flow is encoded as dash DENSITY, and the animation only carries speed.
   *
   * `--dash` is the cycle length in user units: heavy flow packs the dashes
   * tightly, light flow spaces them out. That is the channel a reader can
   * still measure with the animation stopped, which is why it survives
   * prefers-reduced-motion.
   *
   * `animationDuration` is derived so one cycle takes proportionally less time
   * as the rate climbs, and is clamped at both ends: below 0.35s the dashes
   * strobe, above 2.4s they look frozen. Driving it from a CSS custom property
   * means React never touches this per frame — the canvas re-renders at 10Hz,
   * and the browser interpolates the motion continuously in between.
   */
  const style = useMemo(() => {
    if (!active) return undefined;
    // Cycle length in USER UNITS (not px): dense at high flow, sparse at low.
    const cycle = clamp(20 - Math.log10(1 + flow) * 4, 7, 20);
    const on = 3;
    return {
      '--dash-on': on.toFixed(1),
      '--dash-off': (cycle - on).toFixed(1),
      // Travel exactly one cycle per iteration so the pattern never jumps.
      '--dash-cycle': (-cycle).toFixed(1),
      animationDuration: `${clamp(3.2 / Math.log10(10 + flow), 0.35, 2.4).toFixed(2)}s`,
    } as CSSProperties;
  }, [active, flow]);

  /**
   * Anchor for the flow label and the delete button.
   *
   * This must land on a part of the wire that is NOT covered by a node, and
   * that is a stricter requirement than "the middle of the path". Nodes are
   * painted after edges, so anything the edge draws underneath a node body is
   * both invisible and unclickable — the delete button silently stopped
   * working on exactly those edges, which is the same class of dead-overlay
   * bug the input rebuild was done to kill.
   *
   * The safe region is the wire's mid leg, which the router places in the
   * clear corridor strictly BETWEEN the two boxes, whichever sides the route
   * uses. routeEdge reports that point as `label`, so back-edges and
   * vertical routes get an exposed anchor for free.
   */
  const midX = route.label.x;
  const midY = route.label.y;

  return (
    <g
      className={`cv-edge${selected ? ' is-selected' : ''}${
        active ? ' is-active' : ''
      }${control ? ' is-control' : ''} is-state-${state} is-${
        /* A severed wire takes its own state, not the health of the node
           behind it. A breaker that is doing its job protects a downstream
           that is failing, so colouring the blocked wire by that downstream's
           danger would paint the protection and the problem identically. */
        severed || control ? 'ok' : targetHealth
      }`}
    >
      {/* Fat invisible hit area — a 1px line is impossible to click. The
          data-* attributes are what the surface's pointerdown router reads;
          no handler is attached here, so nothing can be swallowed before the
          router sees it. */}
      <path d={d} className="cv-edge-hit" data-hit="edge" data-id={edge.id} />
      <path d={d} className="cv-edge-line" strokeWidth={width} />
      {active && (
        <path d={d} className="cv-edge-flow" strokeWidth={width * 0.75} style={style} />
      )}
      {/* Arrowhead: one of four fixed triangles, pointed along the path's
          actual final direction as reported by the router. */}
      <path d={arrowPath(route.tip, route.dir)} className="cv-edge-arrow" />
      {breakMark !== undefined && <path d={d} className="cv-break-wire" />}
      {breakMark !== undefined && breakMark > 0 && (
        <BreakBadge x={midX} y={midY + 14} n={breakMark} />
      )}

      {/*
        THE BREAK. A severed wire gets a physical gap with two cut ends, not
        just a fainter stroke.

        This is the difference between "quiet" and "disconnected", and it has
        to survive being read at a glance across a diagram. A dashed grey line
        reads as low traffic; a line with a piece visibly MISSING from it
        reads as broken, which is what has actually happened. The mark is
        drawn over the wire's own midpoint gap, so the wire appears to stop,
        break, and resume.
      */}
      {severed && (
        <g className="cv-edge-break" transform={`translate(${midX},${midY})`}>
          <rect className="cv-edge-break-gap" x={-7} y={-7} width={14} height={14} />
          <path
            className="cv-edge-break-mark"
            d="M-4.5,-5 L-1.5,0 L-4.5,5 M4.5,-5 L1.5,0 L4.5,5"
          />
        </g>
      )}

      {/*
        A control edge says what it IS, in a word.

        The dashing and the hollow arrowhead already separate it from a
        request path, but "this line means something categorically different"
        is not a thing a student can be expected to infer from a stroke
        pattern. One word removes the guess. It is shown at the same zoom the
        rate labels appear at, so it obeys the existing detail budget.
      */}
      {showLabel && control && (
        <text className="cv-edge-label is-control" x={midX} y={midY - 6 + labelDy}>
          scales
        </text>
      )}

      {/* How traffic splits at a fan-out. Invisible before this change. */}
      {showLabel && active && (
        <text className="cv-edge-label" x={midX} y={midY - 6 + labelDy}>
          {formatRate(flow)}
        </text>
      )}

      {selected && (
        <g
          className="cv-edge-del"
          transform={`translate(${midX},${midY})`}
          data-hit="edge-delete"
          data-id={edge.id}
          role="button"
          aria-label="Delete connection"
        >
          {/* Invisible hit pad, same pattern as the ports: the visible
              button is 18x18 world px, which at zoom 1 is far below a
              fingertip. The pad only exists while the edge is selected, so
              the click that selected the edge is never stolen by it. */}
          <rect className="cv-edge-del-hit" x={-22} y={-22} width={44} height={44} />
          <rect x={-9} y={-9} width={18} height={18} rx={3} />
          <path d="M-3.5,-3.5 L3.5,3.5 M3.5,-3.5 L-3.5,3.5" />
        </g>
      )}
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Annotations: sections and notes
 *
 * PAINT ORDER IS THE CONTRACT. Sections render in their own group BEFORE
 * the edges, so a section is always behind every wire and every node it
 * frames; notes render AFTER the nodes, so a note is never hidden by the
 * diagram it comments on. Selection chrome for both (rings, resize handles,
 * the note size switch) lives in a final top group, because a handle drawn
 * in the section's own back layer would be buried under any node sitting on
 * the border.
 *
 * A SECTION'S INTERIOR IS POINTER-TRANSPARENT. The tinted fill is
 * pointer-events:none, so a press inside the frame falls through to the
 * node, edge or background beneath it exactly as if the section were not
 * there. Only three things about a section are grabbable: the border (a fat
 * invisible stroke with pointer-events:stroke), the label plate, and the
 * resize handles while selected. Getting this wrong makes every node inside
 * a section unusable, which is why the transparency is structural (what
 * elements exist) rather than a conditional in a handler.
 * ------------------------------------------------------------------ */

/** Label plate metrics, shared by the SVG label and its hit target. */
/** Names for the face buttons, which all read "Aa" in their own face. */
const FONT_LABEL: Record<AnnotationFont, string> = {
  sans: 'Interface',
  hand: 'Handwritten',
  serif: 'Serif',
  mono: 'Monospace',
};

/**
 * A note's handles: two sides that reflow the text, four corners that scale
 * it. Listed once so the chrome and the cursor rules cannot disagree.
 */
/**
 * Inset of the rectangle drawn around a note, in world px: the hit rect,
 * the selection ring and the editing frame all use it, so a note is the
 * same box whether it is pointed at, selected or being edited.
 */
const NOTE_RING_PAD_X = 6;
const NOTE_RING_PAD_Y = 4;

const NOTE_HANDLES = [
  { dir: 'w', corner: false },
  { dir: 'e', corner: false },
  { dir: 'nw', corner: true },
  { dir: 'ne', corner: true },
  { dir: 'sw', corner: true },
  { dir: 'se', corner: true },
] as const;

const SEC_LABEL_STYLE: TextStyle = { size: 12, weight: 550, family: 'sans' };
const SEC_LABEL_PAD_X = 10;
const SEC_LABEL_H = 24;
/** Minimum plate width, so an empty label still leaves a grab tab. */
const SEC_LABEL_MIN_W = 28;

/**
 * The topmost section whose bounds contain a point, or null.
 *
 * Used for the drop-target highlight while a node is dragged. The point is
 * the node's CENTRE rather than its corner, because a person aims the middle
 * of the thing they are holding at the frame they mean; matching on a corner
 * makes a node appear to join a section it is only touching.
 *
 * Later annotations win, matching paint order: a section drawn over another
 * is the one the eye reads as the target.
 */
function sectionAtPoint(
  annotations: readonly Annotation[] | undefined,
  x: number,
  y: number,
): string | null {
  if (!annotations) return null;
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const a = annotations[i]!;
    if (a.kind !== 'section') continue;
    if (x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) {
      return a.id;
    }
  }
  return null;
}

function sectionLabelWidth(label: string): number {
  return Math.max(
    SEC_LABEL_MIN_W,
    measureText(label, SEC_LABEL_STYLE) + SEC_LABEL_PAD_X * 2,
  );
}

interface SectionViewProps {
  section: Section;
  selected: boolean;
  /** Hide the SVG label while the in-place editor floats over it. */
  editingLabel: boolean;
  /** A node is being dragged over this section and will land inside it. */
  dropTarget: boolean;
  /** See NoteViewProps.metricsEpoch. */
  metricsEpoch: number;
}

/**
 * The back-layer body of one section. Memoised: its props only change when
 * the section itself is edited or its selection flips, so the 10Hz snapshot
 * renders skip this subtree entirely.
 */
const SectionView = memo(function SectionView({
  section: s,
  selected,
  editingLabel,
  dropTarget,
  // Read for nothing but the re-render its change forces: the label is
  // truncated against a measurement, and this is what invalidates it.
  metricsEpoch: _metricsEpoch,
}: SectionViewProps) {
  return (
    <g
      className={`cv-section${selected ? ' is-selected' : ''}${
        dropTarget ? ' is-drop-target' : ''
      }`}
      data-tone={
        ((s.tone % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) % SECTION_TONE_COUNT
      }
      // A custom colour drives the three locals the tone rules would have
      // set, so one value restyles fill, border and label together. The fill
      // is mixed down rather than used neat: a section paints behind the
      // nodes, and a solid tint at full strength makes their text unreadable.
      style={
        s.color
          ? ({
              '--sec-fill': `color-mix(in srgb, ${s.color} 12%, transparent)`,
              '--sec-line': `color-mix(in srgb, ${s.color} 55%, transparent)`,
              '--sec-ink': s.color,
            } as CSSProperties)
          : undefined
      }
    >
      {/* The tint, and the section's main hit target. Sections paint behind
          everything, so anything sitting on the frame takes the press first
          and only genuinely empty space reaches this rect. */}
      <rect
        className="cv-section-fill"
        data-hit="section"
        data-id={s.id}
        x={s.x}
        y={s.y}
        width={s.width}
        height={s.height}
        rx={8}
      />
      {/* The visible border, also inert; the invisible fat stroke below it
          is the ONLY part of the perimeter that takes the pointer. */}
      <rect
        className="cv-section-line"
        x={s.x}
        y={s.y}
        width={s.width}
        height={s.height}
        rx={8}
      />
      <rect
        className="cv-section-hit"
        data-hit="section"
        data-id={s.id}
        x={s.x}
        y={s.y}
        width={s.width}
        height={s.height}
        rx={8}
      />
      {/* Label plate, sitting ABOVE the frame rather than inside its corner.
          Inside, the plate's own rounded rect crossed the section's rounded
          border and the two radii fought: the corner read as a graphical
          mistake at every zoom. Above the top edge the border stays an
          unbroken rectangle and the label reads as a tab on it, which is the
          convention every diagramming tool settled on for the same reason.
          Still grabbable: it is the section's handle for anyone who finds a
          1.5px border too precise a target. */}
      <g className="cv-section-label" data-hit="section" data-id={s.id}>
        <rect
          className="cv-section-label-bg"
          x={s.x}
          y={s.y - SEC_LABEL_H - 4}
          width={Math.min(sectionLabelWidth(s.label), s.width)}
          height={SEC_LABEL_H}
          rx={6}
        />
        {!editingLabel && s.label && (
          <text
            className="cv-section-label-text"
            x={s.x + SEC_LABEL_PAD_X}
            y={s.y - SEC_LABEL_H / 2 - 4}
          >
            {truncateToWidth(s.label, s.width - SEC_LABEL_PAD_X * 2, SEC_LABEL_STYLE)}
          </text>
        )}
      </g>
    </g>
  );
});

interface NoteViewProps {
  note: Note;
  selected: boolean;
  /** Hide the SVG text while the in-place textarea floats over it. */
  editing: boolean;
  /**
   * Bumped by the canvas when the text measurement cache is dropped (the
   * webfont stack has finished loading). A layout memoised on the note's
   * own fields alone would keep the widths measured against the fallback
   * face forever: a hand-font note wrapped a word early on every line, and
   * its editor, a real textarea in the real face, wrapped differently, so
   * the text jumped the moment editing started. Part of the memo key, so
   * the wrap is redone once in the face that is actually painted.
   */
  metricsEpoch: number;
}

/**
 * One note: wrapped text with a full-bounds hit rect. Height is derived
 * from the text on every layout, never stored (see annotations.ts). The
 * layout is memoised on exactly the fields it reads, so a note re-wraps
 * only when its own text, width or size changes.
 */
const NoteView = memo(function NoteView({
  note,
  selected,
  editing,
  metricsEpoch,
}: NoteViewProps) {
  const layout = useMemo(
    () => layoutNoteOf(note, note.text),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      note.text,
      note.width,
      note.autoResize,
      note.size,
      note.font,
      note.bold,
      note.italic,
      note.scale,
      metricsEpoch,
    ],
  );
  return (
    <g
      className={`cv-note is-${note.size}${selected ? ' is-selected' : ''}${
        note.bold ? ' is-bold' : ''
      }${note.italic ? ' is-italic' : ''}${note.underline ? ' is-underline' : ''}`}
      data-font={note.font ?? 'sans'}
      data-tone={note.tone ?? undefined}
      // A note with no colour inherits the theme's ink; one with a colour has
      // been given it deliberately and overrides. The value is validated in
      // sanitizeAnnotations, which is the only way one can arrive untrusted.
      style={note.color ? { color: note.color } : undefined}
      transform={`translate(${note.x},${note.y})`}
    >
      <rect
        className="cv-note-hit"
        data-hit="note"
        data-id={note.id}
        x={-NOTE_RING_PAD_X}
        y={-NOTE_RING_PAD_Y}
        width={layout.width + NOTE_RING_PAD_X * 2}
        height={layout.height + NOTE_RING_PAD_Y * 2}
      />
      {!editing && (
        <text
          className="cv-note-text"
          x={0}
          y={0}
          // Painted from the LAYOUT, not left to the size class, because a
          // corner-scaled note has a font size the three preset classes
          // cannot express. Set only when it differs, so an unscaled note
          // still takes its size from the stylesheet and the two cannot
          // drift apart.
          style={note.scale ? { fontSize: layout.font } : undefined}
        >
          {layout.lines.map((line, i) => (
            <tspan key={i} x={0} y={layout.baseline + i * layout.lineH}>
              {line === '' ? ' ' : line}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
});

/**
 * Selection chrome for one section: the ring and the eight resize handles.
 * Drawn in the TOP layer, so a node sitting on the border can never bury a
 * handle. `ui` is 1/zoom: handle geometry is specified in screen px and
 * divided back into world units, so a handle is the same size under the
 * finger at every zoom instead of shrinking into an untouchable speck.
 */
function SectionChrome({
  section: s,
  ui,
  flipTones,
}: {
  section: Section;
  ui: number;
  /** Put the shade row above the frame; set when below is off screen. */
  flipTones?: boolean;
}) {
  const rect = { x: s.x, y: s.y, w: s.width, h: s.height };
  const hs = 9 * ui;
  const hit = 36 * ui;
  // The shade row sits BELOW the frame by default, because ABOVE is where
  // the label plate lives and the two would fight for the same strip. It
  // flips above when there is no room below: a section near the bottom of
  // the viewport would otherwise put its own picker under the charts strip,
  // where it cannot be clicked at all. When it flips it clears the plate.
  const sw = 15 * ui;
  const swGap = 4 * ui;
  const below = s.y + s.height + 10 * ui;
  const flip = flipTones ?? false;
  const swY = flip ? s.y - SEC_LABEL_H - 12 * ui - sw : below;
  return (
    <g className="cv-ann-sel">
      <rect
        className="cv-ann-ring"
        x={s.x - 3 * ui}
        y={s.y - 3 * ui}
        width={s.width + 6 * ui}
        height={s.height + 6 * ui}
        rx={8 + 3 * ui}
      />

      {/* Shade swatches. An index per swatch, not a colour: the stylesheet
          resolves it per theme, so a shade chosen here survives a switch to
          dark instead of becoming an unreadable pale plate. */}
      <g className="cv-sec-tones">
        {Array.from({ length: SECTION_TONE_COUNT }, (_, i) => (
          <rect
            key={i}
            className={`cv-sec-tone${s.tone === i ? ' is-active' : ''}`}
            data-hit="section-tone"
            data-id={s.id}
            data-tone={i}
            role="button"
            aria-label={`Section shade ${i + 1}`}
            x={s.x + i * (sw + swGap)}
            y={swY}
            width={sw}
            height={sw}
            rx={3 * ui}
          />
        ))}
      </g>
      {RESIZE_DIRS.map((dir) => {
        const a = handleAnchor(rect, dir);
        return (
          <g key={dir}>
            <rect
              className="cv-handle"
              x={a.x - hs / 2}
              y={a.y - hs / 2}
              width={hs}
              height={hs}
              rx={2 * ui}
            />
            {/* The generous invisible target, ON TOP of the visible square
                (paint order = hit order), sized for a fingertip. */}
            <rect
              className="cv-handle-hit"
              data-hit="section-resize"
              data-id={s.id}
              data-dir={dir}
              x={a.x - hit / 2}
              y={a.y - hit / 2}
              width={hit}
              height={hit}
            />
          </g>
        );
      })}
    </g>
  );
}

/**
 * Selection chrome for one note: the ring plus the S/M/L size switch. The
 * switch floats above the note's top-left in screen-constant units, the
 * same reasoning as the section handles.
 */
function NoteChrome({
  note,
  ui,
  metricsEpoch,
}: {
  note: Note;
  ui: number;
  /** See NoteViewProps.metricsEpoch: the ring is sized from the same wrap. */
  metricsEpoch: number;
}) {
  const layout = useMemo(
    () => layoutNoteOf(note, note.text),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      note.text,
      note.width,
      note.autoResize,
      note.size,
      note.font,
      note.bold,
      note.italic,
      note.scale,
      metricsEpoch,
    ],
  );
  // The frame, four corner squares, and two invisible edge strips.
  // Everything that STYLES the note lives in the floating bar above the
  // charts strip: a toolbar anchored to the note is wider than a default
  // note, so it clipped against the viewport edge and moved under the
  // reader's hand on every pan.
  //
  // The frame is the same rectangle the editor draws (NoteTextBox), so
  // selected and editing differ only by the handles and the caret: a
  // hairline at the ring inset, square corners, screen-constant. The look
  // is Eraser's text box.
  const hs = 8 * ui;
  const hit = 36 * ui;
  const x0 = note.x - NOTE_RING_PAD_X;
  const y0 = note.y - NOTE_RING_PAD_Y;
  const w = layout.width + NOTE_RING_PAD_X * 2;
  const h = layout.height + NOTE_RING_PAD_Y * 2;
  return (
    <g className="cv-ann-sel">
      <rect className="cv-ann-ring is-note" x={x0} y={y0} width={w} height={h} />

      {/* Two kinds of handle, because a note has two things worth changing.
          An EDGE reflows the text at its current size: the wrap width moves
          and the words rearrange. It is drawn as nothing, the way Eraser's
          is; the cursor changes over the strip. A CORNER scales the type and
          the width together, so the line breaks stay where they are and the
          whole note simply gets bigger; it is the visible square.

          There is no bottom or top handle. A note's height is DERIVED from
          its wrapped text on every layout and never stored, so a vertical
          drag would set a number the next render throws away and the gesture
          would appear to work and then snap back. */}
      {NOTE_HANDLES.map(({ dir, corner }) => {
        const x = dir.includes('w') ? x0 : x0 + w;
        if (!corner) {
          // The whole edge, a fingertip wide, so the strip can be found
          // without hunting for a midpoint.
          return (
            <rect
              key={dir}
              className="cv-handle-hit"
              data-hit="note-resize"
              data-id={note.id}
              data-dir={dir}
              x={x - hit / 2}
              y={y0}
              width={hit}
              height={h}
            />
          );
        }
        const y = dir.startsWith('n') ? y0 : y0 + h;
        return (
          <g key={dir}>
            <rect
              className="cv-handle is-corner"
              x={x - hs / 2}
              y={y - hs / 2}
              width={hs}
              height={hs}
            />
            {/* The generous invisible target ON TOP of the visible square,
                sized for a fingertip, matching the section handles. */}
            <rect
              className="cv-handle-hit"
              data-hit="note-scale"
              data-id={note.id}
              data-dir={dir}
              x={x - hit / 2}
              y={y - hit / 2}
              width={hit}
              height={hit}
            />
          </g>
        );
      })}
    </g>
  );
}

const EMPTY_ANNOTATIONS: readonly Annotation[] = [];

/** The S/M/L steps the editor's Ctrl+Shift+> and < walk. */
const NOTE_SIZE_ORDER: readonly Note['size'][] = ['sm', 'md', 'lg'];

/**
 * The frame around a note being edited: Excalidraw's renderTextBox in role,
 * Eraser's in look. The selection ring's exact rectangle (same inset, same
 * hairline, square corners) drawn from the DRAFT so it grows with the
 * typing, without the handles. Entering and leaving the editor then changes
 * nothing about the frame, only whether the corners and the caret are there.
 */
function NoteTextBox({ note, draft }: { note: Note; draft: string }) {
  const layout = layoutNoteOf(note, draft || ' ');
  return (
    <rect
      className="cv-text-box"
      x={note.x - NOTE_RING_PAD_X}
      y={note.y - NOTE_RING_PAD_Y}
      width={layout.width + NOTE_RING_PAD_X * 2}
      height={layout.height + NOTE_RING_PAD_Y * 2}
    />
  );
}

/* ================================================================== *
 * What a node is MADE OF
 *
 * Four small components, one per structural truth the engine exposes and the
 * canvas used to throw away. Each is memoised separately from the node body
 * so that a node whose structure did not change this frame does not re-render
 * its units just because its p99 moved.
 *
 * The shared rule for all four: EVERY element they emit is
 * `pointer-events: none` (set in Canvas.css on `.cv-units`, `.cv-strip`,
 * `.cv-vessel` and their children). They are decoration painted inside the
 * node group, and the node group already carries the `data-hit="node"` that
 * the pointer router reads. If any of these could take a pointer, a press on
 * a shard cell would resolve to the cell rather than to the node, and
 * `closest('[data-hit]')` would still find the node — but the extra elements
 * would sit above the ports' 15px hit discs and eat link gestures near the
 * node's edges. Making them inert is what keeps the input layer untouched.
 * ================================================================== */

/**
 * The layered cards behind a node body that say "this is several machines".
 *
 * Drawn as siblings BEHIND the body rect (earlier in paint order), each
 * offset up and to the right, so the node reads as the front card of a stack.
 * Offsetting up-right rather than down-right matters: down-right would push
 * the stack toward the meter and the ports, which live along the bottom and
 * sides, and would collide with the node below in a stacked preset.
 */
const InstanceStack = memo(function InstanceStack({
  live,
  pending,
}: {
  live: number;
  pending: number;
}) {
  const layers = stackLayers(live, pending);
  if (layers.length === 0) return null;
  return (
    <g className="cv-units" aria-hidden="true">
      {layers.map((l) => (
        <rect
          key={`${l.offset}-${l.pending ? 'p' : 'l'}`}
          className={l.pending ? 'cv-unit is-pending' : 'cv-unit'}
          x={l.offset}
          y={-l.offset}
          width={NODE_W}
          height={NODE_H}
          rx={NODE_R}
          ry={NODE_R}
        />
      ))}
    </g>
  );
});

/**
 * A strip of per-unit cells, each filled by that unit's own utilisation.
 *
 * This is the sharding lesson in one object. The node-level `utilization` a
 * shard reports is the MEAN across partitions, and with a hot key that mean is
 * reassuring while one partition is pinned at 1.0 — measured on the real
 * engine at hotKeyFraction 0.85: per-shard [1.00, 0.10, 0.05, 0.03, 0.09,
 * 0.00, 0.07, 0.03] against a node mean of 0.17. A single meter cannot say
 * that. Eight cells can, instantly, without a number being read.
 *
 * Each cell fills from the BOTTOM like a column of liquid, so the strip reads
 * as a bar chart of load rather than as a row of status lights. A cell at or
 * past the danger threshold also gets a class, so colour is a redundant
 * channel on top of height rather than the only one.
 */
const UnitStrip = memo(function UnitStrip({
  values,
  x,
  y,
  width,
  height,
  /** Index that should be marked as structurally distinct (a replica primary). */
  leadIndex = -1,
}: {
  values: readonly number[];
  x: number;
  y: number;
  width: number;
  height: number;
  leadIndex?: number;
}) {
  const n = values.length;
  if (n === 0) return null;
  const strip = cellStrip(n, width);
  return (
    <g className="cv-strip" transform={`translate(${x},${y})`} aria-hidden="true">
      {values.map((raw, i) => {
        const v = clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
        // Never render a busy unit as an empty cell: the same
        // never-print-zero rule the meter follows. 1px of fill is the
        // difference between "idle" and "barely working", and at these cell
        // sizes it is the smallest mark that still resolves.
        const fh = v > 0 ? Math.max(1, v * height) : 0;
        const cls = [
          'cv-cell-fill',
          healthOfLoad(v) === 'danger'
            ? 'is-danger'
            : healthOfLoad(v) === 'warn'
              ? 'is-warn'
              : '',
          i === leadIndex ? 'is-lead' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g key={i}>
            <rect
              className={i === leadIndex ? 'cv-cell is-lead' : 'cv-cell'}
              x={strip.x(i)}
              y={0}
              width={strip.w}
              height={height}
            />
            {fh > 0 && (
              <rect
                className={cls}
                x={strip.x(i)}
                y={height - fh}
                width={strip.w}
                height={fh}
              />
            )}
          </g>
        );
      })}
      {/* The lead marker must survive fill saturation. The outline on the
          lead CELL disappears exactly when the strip is interesting: nine
          members all pinned at 99.9% render nine identical full-red cells
          and the primary-vs-read-set distinction (the kind's whole lesson)
          vanished. A notch UNDER the cell is outside the fill's channel
          entirely, so it reads at any load. */}
      {leadIndex >= 0 && leadIndex < n && (
        <rect
          className="cv-cell-lead-notch"
          x={strip.x(leadIndex)}
          y={height + 1.5}
          width={strip.w}
          height={2}
        />
      )}
    </g>
  );
});

/**
 * A queue drawn as a vessel filling toward its limit.
 *
 * A queue's `utilization` is structurally ZERO — measured on async-workers
 * under 2.5x load: depth climbed 369 -> 946 -> 2478 while utilisation stayed
 * at 0.00 the whole time, because a buffer holds work rather than serving it.
 * So the standard meter on a queue node was not merely uninformative, it was
 * pinned empty while the backlog ran away. Depth against limit is the only
 * honest reading, and it is the one a student can watch fill and drain.
 *
 * At the limit the vessel gains a shedding state, because that is the moment
 * the queue stops being a buffer and starts destroying requests.
 */
const QueueVessel = memo(function QueueVessel({
  depth,
  limit,
  shedding,
  x,
  y,
  width,
  height,
}: {
  depth: number;
  limit: number;
  shedding: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const lim = limit > 0 ? limit : 1;
  const fill = clamp(depth / lim, 0, 1);
  const fw = fill > 0 ? Math.max(1.5, fill * width) : 0;
  return (
    <g
      className={shedding ? 'cv-vessel is-shedding' : 'cv-vessel'}
      transform={`translate(${x},${y})`}
      aria-hidden="true"
    >
      <rect
        className="cv-vessel-track"
        x={0}
        y={0}
        width={width}
        height={height}
        rx={2}
      />
      {fw > 0 && (
        <rect
          className="cv-vessel-fill"
          x={0}
          y={0}
          width={fw}
          height={height}
          rx={2}
        />
      )}
      {/* The limit wall. A vessel with no visible brim gives the fill nothing
          to be full AGAINST, so a backlog of 2478 and one of 80 look the same
          when both are drawn against their own scale. */}
      <rect
        className="cv-vessel-brim"
        x={width - 1}
        y={-1}
        width={1.5}
        height={height + 2}
      />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Node
 * ------------------------------------------------------------------ */

/** Why a node cannot be the target of the link currently in flight. */
type LinkRole = 'none' | 'source' | 'valid' | 'invalid';

interface NodeViewProps {
  node: SimNode;
  stats: NodeStats | null;
  spark: ArrayLike<number> | undefined;
  selected: boolean;
  /** 2 = full, 1 = header + meter only, 0 = name + meter. */
  detail: 0 | 1 | 2;
  /** Role in the link gesture currently in flight, if any. */
  linkRole: LinkRole;
  /** True while any link gesture is live: forces the ports visible. */
  linking: boolean;
  /** True when this node is the snapped target of the live link. */
  linkTarget: boolean;
  /**
   * An injected failure in force on this node right now, or null. Sourced from
   * `snapshot.activeFailures`, so a crashed or slowed node is marked as
   * FAULTED even when its own stats look calm — a crashed node serves nothing,
   * which reads as 0% utilisation and would otherwise paint as perfectly
   * healthy. This is the one state the metrics alone cannot express.
   */
  fault: FailureKind | null;
  /**
   * Summed backlog of the buffer nodes feeding this node, for pull-based
   * kinds (worker, transcoder) whose own queue is structurally always 0.
   * Computed by the parent from the topology; 0 for every other kind.
   */
  backlog: number;
  /** A client's own end-to-end figures, or null for every other kind. */
  route: RouteStats | null;
  /**
   * The readout's health after display hysteresis, from the parent. Absent
   * means use the readout's own, unsettled.
   */
  settledHealth?: Health;
  /**
   * World px per screen px for the glance line (glance.ts), or 0 for none.
   * Non-zero only below DETAIL_ZOOM on a touch screen.
   */
  glance: number;
  onActivate: (id: string, additive: boolean) => void;
  onNudge: (id: string, dx: number, dy: number) => void;
  /**
   * True for the one node that just arrived on an already-populated canvas
   * (a palette drop or click). Drives the entrance fade in Canvas.css.
   * Deliberately false for every node of a preset load or a restored
   * session: content that is simply present does not get an entrance.
   */
  entering: boolean;
  /** See `CanvasProps.breakMarks`. Undefined when the node is not a target. */
  breakMark?: number;
}

/**
 * A fault's number in a break the search found. A shape and a figure, so it
 * reads without its colour.
 */
function BreakBadge({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g className="cv-break-badge" transform={`translate(${x},${y})`} aria-hidden="true">
      <circle r={9} />
      <text y={4}>{n}</text>
    </g>
  );
}

/** Exported for its render test only; the canvas is its one caller. */
export const NodeView = memo(function NodeView({
  node,
  stats,
  spark,
  selected,
  detail,
  linkRole,
  linking,
  linkTarget,
  fault,
  backlog,
  route,
  settledHealth,
  glance,
  onActivate,
  onNudge,
  entering,
  breakMark,
}: NodeViewProps) {
  const readout = stats
    ? readoutFor(node.kind, stats, node.config, backlog, route)
    : null;
  // A faulted node is never reported as healthy, whatever its metrics say.
  const health: Health = fault
    ? 'danger'
    : readout
      ? (settledHealth ?? readout.health)
      : 'ok';

  /* ---- structure: what this node is made of -----------------------
     `instances === undefined` means "this kind is genuinely one thing" and
     must fall back to the scalar meters — never be treated as zero. That is
     the engine's documented contract, and it is why every branch below tests
     for undefined rather than for a count. */
  const units = stats?.perInstance;
  const pending = stats?.instancesPending ?? 0;
  const badge = stackBadge(stats?.instances);

  /**
   * Which structural drawing this kind gets. One kind, one answer — the
   * three are mutually exclusive, so a node can never draw two competing
   * pictures of itself.
   *
   *   strip   the units are INDEPENDENT and their individual values carry
   *           the lesson (shard partitions, replica set members, a stream
   *           broker's partitions filled by worst-group lag).
   *   vessel  the node is a buffer, and depth-against-limit is the reading
   *           (queue).
   *   stack   the units are INTERCHANGEABLE machines and the count is the
   *           lesson (service, worker, db, cache, lb, cdn).
   *
   * The broker moved from stack to strip deliberately: its partitions are
   * independent (per-partition lag exists and the behaviour reports it),
   * and drawing 8 broker partitions as a stack of interchangeable machines
   * while 64 shard partitions drew a strip used two pictures for one
   * concept. The "Nx" badge now means partitions on both kinds.
   */
  const structure: 'strip' | 'vessel' | 'stack' | 'none' =
    node.kind === 'shard' || node.kind === 'replica' || node.kind === 'streambroker'
      ? 'strip'
      : node.kind === 'queue'
        ? 'vessel'
        : units && units.length > 1
          ? 'stack'
          : pending > 0
            ? 'stack'
            : 'none';

  const handleKey = useCallback(
    (e: React.KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        // Shift/ctrl+Enter toggles, matching shift/ctrl-click.
        onActivate(node.id, e.shiftKey || e.ctrlKey || e.metaKey);
        return;
      }
      /*
       * Arrows nudge by one grid step; SHIFT+arrow moves by a single pixel.
       * The inversion is deliberate: the arrow step is the grid, so the fine
       * step is the escape hatch a grid user actually needs, where a coarser
       * shift step would just be a faster version of what plain arrows
       * already do.
       *
       * This pair is its own feature and does not read the snap preference:
       * Shortcuts calls them "one grid step" and "1px, off the grid", so the
       * escape hatch is already the shift key rather than the setting.
       *
       * A SELECTED node lets the event through untouched: the canvas-level
       * handler moves the whole selection (this node included), and handling
       * it here too would move this node twice.
       */
      if (selected) return;
      const step = e.shiftKey ? 1 : GRID;
      let dx = 0;
      let dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      onNudge(node.id, dx, dy);
    },
    [node.id, selected, onActivate, onNudge],
  );

  // A working node must never render an empty meter: 2px minimum whenever
  // load is non-zero. This is the geometric twin of the never-print-zero rule.
  const load = readout ? clamp(readout.load, 0, 1) : 0;
  const meterW = load > 0 ? Math.max(2, load * METER_W) : 0;

  // Fractional metrics pin the sparkline domain to 0..1 so a utilization
  // trace does not rescale itself into looking permanently full. The flag
  // comes from the readout, which knows what its own spark series is, so a
  // count series (a cron's emitted total, a broker's lag) autoscales.
  const sparkUnit = readout ? readout.sparkUnit : true;

  const full = detail === 2;
  // The glance line takes the header's room: the icon and the 14px name
  // are both unreadable at the zooms it is drawn at.
  const gl = glance > 0 && !full ? glanceLayout(glance) : null;
  const showHeader = detail >= 1 && !gl;
  // The status mark survives the glance line, counter-scaled to the same
  // screen size and level with its name: it is the shape channel for health,
  // and a phone at fit zoom must not lose it. The unit badge does not, since
  // at 11px the name would keep only a few letters beside both; the stack
  // behind the card still shows that there are several.
  const showCorner = showHeader || gl !== null;
  const cs = gl ? glance : 1;
  const cornerY = gl ? gl.nameY : HEAD_CENTER_Y;
  const markSize = MARK_SIZE * cs;

  /** The badge string as actually rendered; the name budget reserves it. */
  const badgeText = badge ? `${badge}${pending > 0 ? `+${pending}` : ''}` : '';
  const shownName = gl
    ? truncateToWidth(
        node.label,
        NODE_W -
          PAD_X * 2 -
          (fault || health !== 'ok' ? (MARK_SIZE + NAME_GAP / 2) * cs : 0),
        { ...NAME_STYLE, size: gl.nameSize },
      )
    : truncateLabel(
        node.label,
        showHeader,
        badgeText,
        Boolean(fault) || health !== 'ok',
      );

  const linkClass =
    linkRole === 'none'
      ? ''
      : ` is-link-${linkRole}${linkTarget ? ' is-link-target' : ''}`;

  return (
    <g
      className={`cv-node is-${health}${selected ? ' is-selected' : ''}${
        readout?.losing ? ' is-losing' : ''
      }${fault ? ' is-faulted' : ''}${linking ? ' is-linking' : ''}${
        // The strip's top edge at y=56 cannot clear a 22px descender from the
        // primary's baseline at 52, so strip kinds suppress the selected-state
        // font bump via this class (measured overlap: 124x3px on a shard).
        structure === 'strip' ? ' has-strip' : ''
      }${entering ? ' is-entering' : ''}${linkClass}`}
      transform={`translate(${node.x},${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={[
        // The kind is dropped when the user's own label already says it, so
        // a node called "Database" is announced once, not as "Database,
        // Database". Compared case-insensitively because the label is free
        // text the student typed.
        node.label.trim().toLowerCase() === KIND_NAME[node.kind].toLowerCase()
          ? null
          : KIND_NAME[node.kind],
        node.label,
        readout ? `${readout.primary.value} ${readout.primary.label}` : null,
        /* The structure is announced, not just drawn. A stack of cards, a
             strip of partitions and a filling vessel are all pure geometry —
             a screen-reader user has no access to any of them, and they are
             the whole point of this pass. Said in words rather than as a
             count alone: "4 partitions" beats "4x". */
        badge
          ? node.kind === 'shard' || node.kind === 'streambroker'
            ? `${stats?.instances} partitions`
            : node.kind === 'replica'
              ? `primary plus ${(stats?.instances ?? 1) - 1} read replicas`
              : `${stats?.instances} instances`
          : null,
        pending > 0 ? `${pending} warming up` : null,
        // The fault is announced, not just drawn: a screen-reader user has
        // no access to the square mark in the corner.
        fault ? `faulted: ${fault}` : null,
        breakMark === undefined
          ? null
          : breakMark > 0
            ? `fault ${breakMark} of the break`
            : 'being tested for a break',
      ]
        .filter(Boolean)
        .join(', ')}
      aria-pressed={selected}
      data-hit="node"
      data-id={node.id}
      /* Drives the per-kind colour trio in Canvas.css. Identity is expressed
         entirely through CSS custom properties keyed off this one attribute,
         so no colour value is ever computed in JS. */
      data-kind={node.kind}
      onKeyDown={handleKey}
    >
      {/* The fleet, BEHIND the body. Painted first so the body is the front
          card of the stack rather than an object sitting on top of one. */}
      {structure === 'stack' && showCorner && (
        <InstanceStack live={units?.length ?? 1} pending={pending} />
      )}

      {/* Body. One surface. No header band fill, no card-in-card. */}
      <rect
        className="cv-node-body"
        width={NODE_W}
        height={NODE_H}
        rx={NODE_R}
        ry={NODE_R}
      />

      {/*
        Selection ring.

        Drawn as a SEPARATE rect OUTSIDE the body, offset by 3px, rather than
        as a border on the body itself. Three reasons, and on a per-kind
        palette the third is decisive:

          - it can be 2px without changing the body's geometry (a thicker
            border would shift every child by a pixel);
          - offsetting it outward leaves a 3px gap of raw canvas between ring
            and node, and that gap is what makes it read as a ring AROUND the
            component rather than as a recolouring of its outline;
          - the node now has its own kind colour on its border. If selection
            simply repainted that border, selecting a node would destroy the
            identity cue the whole redesign exists to establish. Keeping them
            on separate geometry means a selected database is still visibly
            a database.

        Measured: --accent against the palest of the fourteen kind fills is
        5.42:1, so the ring is unmistakable on every node in the system.
      */}
      {selected && (
        <rect
          className="cv-node-ring"
          x={-RING_GAP}
          y={-RING_GAP}
          width={NODE_W + RING_GAP * 2}
          height={NODE_H + RING_GAP * 2}
          rx={NODE_R + RING_GAP}
          ry={NODE_R + RING_GAP}
        />
      )}

      {breakMark !== undefined && (
        <rect
          className="cv-break-ring"
          x={-RING_GAP * 2}
          y={-RING_GAP * 2}
          width={NODE_W + RING_GAP * 4}
          height={NODE_H + RING_GAP * 4}
          rx={NODE_R + RING_GAP * 2}
          ry={NODE_R + RING_GAP * 2}
        />
      )}
      {breakMark !== undefined && breakMark > 0 && (
        <BreakBadge x={0} y={0} n={breakMark} />
      )}

      {/* No kind rule along the top edge. It used to sit at y=0, but the body
          rect is stroked and a stroke straddles its own path, so half the
          border already occupies that row. The bar landed on top of the inner
          half and stopped flat where the corner radius curved away, which read
          as a misaligned second border. The kind colour is on the border
          itself, so the bar was saying the same thing twice anyway. */}

      {showHeader && (
        <>
          <line
            className="cv-node-hair"
            x1={PAD_X}
            y1={HEAD_H}
            x2={NODE_W - PAD_X}
            y2={HEAD_H}
          />

          <g
            className="cv-node-icon"
            transform={`translate(${PAD_X},${GLYPH_Y}) scale(${GLYPH_SCALE})`}
          >
            <Glyph kind={node.kind} />
          </g>
        </>
      )}

      {/*
        The node name, truncated to the width actually available.

        SVG <text> has no text-overflow: it simply paints past its container,
        so a long label used to run straight out of the node and across the
        canvas (measured: 125px of overhang on a 36-character label, over open
        background and neighbouring wires). Since the student types this
        label, "nobody would do that" is not a defence.

        The budget is derived from the real geometry rather than hardcoded, so
        it stays correct if the glyph size or insets ever change. The full
        label is always available: it is in the accessible name, and <title>
        gives it a native hover tooltip.
      */}
      <text
        className="cv-node-name"
        x={showHeader ? PAD_X + GLYPH_PX + NAME_GAP : PAD_X}
        y={gl ? gl.nameY : showHeader ? HEAD_CENTER_Y : 24}
        style={gl ? { fontSize: gl.nameSize } : undefined}
      >
        {shownName}
        {shownName !== node.label && <title>{node.label}</title>}
      </text>

      {gl && readout && (
        <text
          className="cv-node-primary"
          x={PAD_X}
          y={gl.valueY}
          style={{ fontSize: gl.valueSize }}
          {...fitGlance(readout.primary.value, readout.primary.label, gl)}
        >
          <tspan className="cv-val">{readout.primary.value}</tspan>
          <tspan className="cv-cap" dx={gl.capGap} style={{ fontSize: gl.capSize }}>
            {readout.primary.label}
          </tspan>
        </text>
      )}

      {/*
        Status mark, top right. Redundant with colour by SHAPE, which is the
        rule that keeps the diagram readable under deuteranopia (where warn and
        danger converge to the same yellow-green):

          ok      nothing at all — a healthy node carries no mark
          warn    a hollow ring
          danger  a filled disc
          fault   a square, which no metric state ever produces

        So the three states differ in fill and the fourth in silhouette,
        before any colour is applied.
      */}
      {showCorner && fault && (
        <rect
          className="cv-node-mark is-fault"
          x={NODE_W - PAD_X - markSize}
          y={cornerY - markSize / 2}
          width={markSize}
          height={markSize}
        />
      )}
      {showCorner && !fault && health === 'danger' && (
        <circle
          className="cv-node-mark is-danger"
          cx={NODE_W - PAD_X - markSize / 2}
          cy={cornerY}
          r={markSize / 2}
        />
      )}
      {showCorner && !fault && health === 'warn' && (
        <circle
          className="cv-node-mark is-warn"
          cx={NODE_W - PAD_X - markSize / 2}
          cy={cornerY}
          r={(MARK_SIZE / 2 - 1) * cs}
          style={gl ? { strokeWidth: 2 * cs } : undefined}
        />
      )}

      {/*
        Unit count. The PRECISE channel for how many things this node is,
        where the stack behind it is only the approximate one — past five
        instances the stack stops growing and this is what still tells the
        truth. Sits left of the status mark so the two never overlap, and is
        suppressed entirely at one unit (see stackBadge).

        `+n` is appended while units are warming up. That is a different claim
        from the count itself — "5 running, 3 on the way" — and keeping it in
        one label rather than two stops a scaling node from gaining and losing
        a whole separate element every few seconds.
      */}
      {showHeader && badgeText && (
        <text
          className={pending > 0 ? 'cv-node-badge is-warming' : 'cv-node-badge'}
          x={NODE_W - PAD_X - (fault || health !== 'ok' ? MARK_RESERVE : 0)}
          y={HEAD_CENTER_Y}
          textAnchor="end"
        >
          {badgeText}
        </text>
      )}

      {full && readout && (
        <>
          {/* The primary is width-guarded like every other cell: it shares
              its row with the sparkline / vessel (or, on strip kinds, the
              side cell), and an unguarded value was measured 13px inside the
              sparkline at a six-figure queue depth. Strip kinds never take
              the selected font bump (see has-strip above), so their fit is
              computed at the base size. */}
          <text
            className="cv-node-primary"
            x={PAD_X}
            y={52}
            {...fitPrimary(
              readout.primary.value,
              readout.primary.label,
              selected && structure !== 'strip',
            )}
          >
            <tspan className="cv-val">{readout.primary.value}</tspan>
            <tspan className="cv-cap" dx={4}>
              {readout.primary.label}
            </tspan>
          </text>

          {/* Strip kinds drop the two-cell secondary row (the strip occupies
              that band), which previously cost them EVERY number beyond the
              primary. The right half of the primary row is empty on these
              kinds, so the single most useful companion figure rides there:
              coldest partition beside hottest, stale rate beside a replica's
              utilisation, delivery (or loss) rate beside a broker's lag. */}
          {structure === 'strip' && (readout.a.value || readout.a.label) && (
            <text
              className="cv-node-sec"
              x={NODE_W - PAD_X}
              y={52}
              textAnchor="end"
              {...fitCell(readout.a.value, readout.a.label, 60)}
            >
              <tspan className="cv-val">{readout.a.value}</tspan>
              {readout.a.value && readout.a.label ? (
                <tspan className="cv-cap" dx={3}>
                  {readout.a.label}
                </tspan>
              ) : (
                <tspan className="cv-cap">{readout.a.label}</tspan>
              )}
            </text>
          )}

          {/*
            The sparkline slot carries the STRUCTURE when the node has one,
            and the trend otherwise.

            For a shard or a replica set this is a straight upgrade, not a
            trade: the sparkline there plots the node-level MEAN, which is the
            single most misleading number those two kinds produce. A shard at
            hotKeyFraction 0.85 traces a calm flat 0.17 while partition 0 is
            pinned at 1.00 and shedding. The strip shows both facts at once and
            the trend is still available on the meter and in the Inspector.
          */}
          {structure === 'strip' && units ? (
            <UnitStrip
              values={units}
              /* FULL BODY WIDTH, not the sparkline's 64px slot.

                 For a shard the strip is not a secondary indicator sitting
                 beside the numbers — it IS the node's primary content, and
                 the width directly buys legibility at high partition counts.
                 Measured: 64 partitions in the 64px slot gives 1.00px cells,
                 which is below the point where a fill height can be read; the
                 same 64 partitions across the full 160px inner width give
                 2.50px cells, which still resolve as distinct bars. The
                 numbers move left to their own column to make room. */
              x={PAD_X}
              /* Sits in the band between the secondary readout (baseline 70)
                 and the meter (80): a 10px strip at y=58 clears the primary
                 text above it and the meter below without either moving. */
              y={STRIP_Y}
              width={METER_W}
              height={STRIP_H}
              // A replica set is [primary, ...replicas]: index 0 is a
              // different KIND of thing from the rest, not just another
              // member, and the write pool saturating while the read set
              // idles is the lesson. A shard has no privileged partition.
              leadIndex={node.kind === 'replica' ? 0 : -1}
            />
          ) : structure === 'vessel' && stats ? (
            <QueueVessel
              depth={stats.queued}
              limit={stats.queueLimit}
              shedding={stats.shedRate > 0}
              x={SPARK_X}
              y={SPARK_Y + SPARK_H - 10}
              width={SPARK_W}
              height={10}
            />
          ) : (
            <Spark data={spark} unit={sparkUnit} />
          )}

          {/*
            The two secondary metrics are anchored to OPPOSITE edges — the
            first to the left inset, the second to the right — rather than the
            second sitting at a fixed x offset from the first.

            The fixed offset was a real bug, not a style preference: it
            assumed the left metric never got wide. At three-digit latency
            ("117ms P99") the left pair overran the offset and printed
            straight through the right pair, rendering "P99" and "89%" on top
            of each other. Anchoring them to opposite edges makes the two grow
            AWAY from one another, so the gap between them shrinks under
            pressure instead of going negative.
          */}
          {/* The strip occupies this row and already shows the spread these
              two numbers summarise, so they are dropped for those kinds
              rather than printed on top of it. The exact hottest/coldest
              figures remain one click away in the Inspector. */}
          {structure !== 'strip' && (
            <>
              {/* Each half gets a hard width budget and textLength forces the
                  glyphs to fit it. SVG text neither wraps nor ellipsises, so
                  without this a wordy readout simply grows across the node and
                  collides with its neighbour, which is exactly what happened
                  when the autoscaler printed a phase word here. Condensing is
                  ugly at extremes but it is always legible, and it can never
                  overlap. */}
              <text
                className="cv-node-sec"
                x={PAD_X}
                y={70}
                {...fitCell(readout.a.value, readout.a.label, SEC_HALF)}
              >
                <tspan className="cv-val">{readout.a.value}</tspan>
                {readout.a.value && readout.a.label ? (
                  <tspan className="cv-cap" dx={3}>
                    {readout.a.label}
                  </tspan>
                ) : (
                  <tspan className="cv-cap">{readout.a.label}</tspan>
                )}
              </text>
              <text
                className="cv-node-sec"
                x={NODE_W - PAD_X}
                y={70}
                textAnchor="end"
                {...fitCell(readout.b.value, readout.b.label, SEC_HALF)}
              >
                <tspan className="cv-val">{readout.b.value}</tspan>
                {readout.b.value && readout.b.label ? (
                  <tspan className="cv-cap" dx={3}>
                    {readout.b.label}
                  </tspan>
                ) : (
                  <tspan className="cv-cap">{readout.b.label}</tspan>
                )}
              </text>
            </>
          )}
        </>
      )}

      {/* Meter. Length is the primary encoding of load — it survives both
          colourblindness and the zoom levels where text has dropped out. */}
      <rect
        className="cv-meter-track"
        x={PAD_X}
        y={METER_Y}
        width={METER_W}
        height={METER_H}
        rx={1.5}
      />
      {meterW > 0 && (
        <rect
          className="cv-meter-fill"
          x={PAD_X}
          y={METER_Y}
          width={meterW}
          height={METER_H}
          rx={1.5}
        />
      )}
      {/* Threshold tick. A fixed landmark at the warn line, so a bar can be
          read against WHERE trouble starts, not just against its own length. */}
      <rect
        className="cv-meter-tick"
        x={PAD_X + METER_W * WARN_AT}
        y={METER_Y - 1}
        width={1}
        height={METER_H + 2}
      />

      {/*
        Ports. Input left, output right.

        Each port is TWO circles: a transparent 15px hit disc and the 5px dot
        that is actually seen. The hit disc is what the pointerdown router
        finds via closest('[data-hit]'), so aiming is forgiving while the
        drawing stays precise. The hit disc is drawn first so the visible dot
        paints over it.
      */}
      <circle
        className="cv-port-hit"
        cx={0}
        cy={PORT_CY}
        r={PORT_HIT_R}
        data-hit="port-in"
        data-id={node.id}
      />
      <circle className="cv-port cv-port-in" cx={0} cy={PORT_CY} r={PORT_R} />

      <circle
        className="cv-port-hit"
        cx={NODE_W}
        cy={PORT_CY}
        r={PORT_HIT_R}
        data-hit="port-out"
        data-id={node.id}
      />
      <circle className="cv-port cv-port-out" cx={NODE_W} cy={PORT_CY} r={PORT_R} />
    </g>
  );
});

/* ------------------------------------------------------------------ *
 * Input layer
 *
 * ONE pointerdown router lives on `.cv-surface`, an element that contains the
 * SVG and nothing else. Every piece of overlay chrome (zoom controls, ledger,
 * empty-state copy) is a SIBLING of the surface, not a descendant, so a press
 * on a button can never reach this code and can never be swallowed by pointer
 * capture. That is the structural half of the fix; the router also bails on
 * anything matching `button, input, select, textarea, a, [data-chrome]` as a
 * belt-and-braces second half.
 *
 * The state machine has two phases:
 *
 *   PENDING   pointerdown recorded what was hit and where, and NOTHING else.
 *             No capture, no state change, no selection change. A release in
 *             this phase is a CLICK and is routed by what was hit.
 *
 *   ACTIVE    the pointer travelled more than DRAG_THRESHOLD screen px, so
 *             the gesture is promoted to the drag its hit target implies and
 *             the pointer is captured at that moment — never earlier.
 *
 * `pendingLink` is a third, modeless state: a completed click on an output
 * port arms a link that the NEXT click completes. That gives beginners a
 * two-click alternative to a precise drag.
 * ------------------------------------------------------------------ */

/** What a pointerdown landed on, resolved once at press time. */
type HitKind =
  | 'node'
  | 'port-in'
  | 'port-out'
  | 'edge'
  | 'edge-delete'
  | 'background'
  | 'note'
  | 'section'
  | 'section-resize'
  | 'note-resize'
  | 'note-scale'
  | 'note-size'
  | 'note-bold'
  | 'note-font'
  | 'note-tone'
  | 'section-tone';

interface Hit {
  kind: HitKind;
  id: string | null;
  /** Resize handle direction, for 'section-resize' hits. */
  dir: string | null;
  /** Requested size, for 'note-size' hits. */
  size: string | null;
  /** Requested shade index, for 'section-tone' and 'note-tone' hits. */
  tone: string | null;
  /** Requested face, for 'note-font' hits. */
  fontName: string | null;
}

const BACKGROUND_HIT: Hit = {
  kind: 'background',
  id: null,
  dir: null,
  size: null,
  tone: null,
  fontName: null,
};

interface Pending {
  pointerId: number;
  hit: Hit;
  /**
   * Drag-promotion threshold in screen px, latched from the pointer type at
   * press time: 4 for a mouse, 10 for a finger or a pen (see pointerInput).
   */
  threshold: number;
  /** Screen coords at press. Drag promotion is measured from here. */
  screenX: number;
  screenY: number;
  /** World coords at press. Node drags compute their grab offset from here. */
  worldX: number;
  worldY: number;
  shift: boolean;
  ctrl: boolean;
  /** Alt at press: promoting a node drag duplicates first (alt+drag copy). */
  alt: boolean;
  /** Viewport at press, so a pan is absolute rather than incremental. */
  vx: number;
  vy: number;
  /** True once promoted past the threshold. */
  active: boolean;
  /** Which drag it was promoted to. Only meaningful when active. */
  mode:
    | 'pan'
    | 'node'
    | 'link'
    | 'marquee'
    | 'ann'
    | 'ann-resize'
    | 'note-resize'
    | 'note-scale'
    | 'draw-section'
    | null;
  /** Grab offset for a node drag, in world units. Set at promotion. */
  grabDx: number;
  grabDy: number;
  /** Ids moved as a group with the primary node (a multi-selection drag). */
  groupIds: string[];
  /** Origin of each grouped node at promotion, so moves stay relative. */
  groupOrigins: Map<string, { x: number; y: number }>;
  /** Annotation ids riding along with a multi-selection drag. */
  groupAnnIds: string[];
  groupAnnOrigins: Map<string, { x: number; y: number }>;
  /** Section rect at promotion, for an 'ann-resize' drag. */
  annRect: { x: number; y: number; w: number; h: number } | null;
  /**
   * A note's WRAP width at grab time, for a corner scale. `annRect.w` holds
   * the box the text occupies, which is where the handle was and what the
   * drag is measured from; the wrap width is what the scale multiplies.
   */
  noteWrap: number;
  /** The armed annotation tool latched at press time, if any. */
  tool: 'note' | 'section' | null;
}

/** Live marquee rectangle, in world units. */
interface Marquee {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Live link gesture: preview endpoint and the snapped target, if any. */
interface LinkState {
  from: string;
  /** World coords of the loose end. */
  x: number;
  y: number;
  /** Node the pointer is currently over, if any. */
  over: string | null;
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

export default function Canvas({
  topology,
  snapshot,
  routes,
  selectedIds,
  onSelectionChange,
  onMoveNode,
  onMoveStart,
  onMoveEnd,
  onConnect,
  onDeleteSelection,
  onDropNode,
  onRename,
  onDuplicateForDrag,
  onPaste,
  onMoveAnnotation,
  onResizeSection,
  onCreateNote,
  onCreateSection,
  onEditNote,
  onEditSectionLabel,
  onSetNoteSize,
  onSetSectionTone,
  onResizeNote,
  onScaleNote,
  onSetNoteStyle,
  spark,
  viewCenterRef,
  armToolRef,
  exportSvgRef,
  onToolChange,
  fitSignal = 0,
  visibleRef,
  breakMarks,
  emptyActions,
  fitTight = false,
  spotlightId = null,
}: CanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const spaceRef = useRef(false);
  /**
   * Last pointer position over the surface, in CLIENT coords, or null when
   * the pointer is elsewhere. Ctrl+V pastes here; client coords because the
   * viewport can pan or zoom between the move and the paste, and converting
   * at paste time stays correct through both.
   */
  const lastClientRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Live touch contacts on the surface, keyed by pointerId, in
   * surface-relative coords. Only 'touch' pointers are tracked: a mouse and
   * a pen are one-pointer devices by nature, and only fingers pinch.
   */
  const touchesRef = useRef<TouchMap>(new Map());
  /** Live two-finger pinch/pan, or null. See pointerInput.ts. */
  const pinchRef = useRef<PinchState | null>(null);
  /**
   * True while a pen is in CONTACT (not merely hovering). While it is, every
   * touch-down is rejected as a palm: the hand holding the pen is resting on
   * the glass. Hover must not set this, or a teacher pointing with the pen
   * an inch off the board would lock out their other hand entirely.
   */
  const penDownRef = useRef(false);

  const [view, setView] = useState<Viewport>({ x: 0, y: 0, k: 1 });

  /* Read here rather than threaded down as a prop. usePreference subscribes
     to one primitive through useSyncExternalStore, so this component
     re-renders only when THIS flag changes, and the shell does not gain a
     prop it would only be passing through. */
  const showMinimap = usePreference('minimap');
  /*
   * Snap was hard-wired on, and `snapToGrid` was stored, defaulted and
   * offered in Settings while nothing read it: the toggle moved a boolean
   * nobody asked. Ctrl was the only real bypass, which is a bad deal on a
   * trackpad and no deal at all on a touchscreen.
   */
  const snapOn = usePreference('snapToGrid');

  /**
   * The surface's size in screen px, for the minimap's viewport rectangle.
   *
   * State rather than a measurement taken at paint, because the rectangle
   * has to move when the WINDOW resizes as well as when the camera does, and
   * nothing else re-renders on a resize. Only tracked while the minimap is
   * on: a ResizeObserver running for a feature nobody enabled is a cost paid
   * by every reader for one who is not there.
   */
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!showMinimap) return;
    const el = surfaceRef.current;
    if (!el) return;
    // Measured off the element rather than read from the entry's
    // contentRect: the map is switched on long after mount, and the first
    // callback can carry a zero rect, which collapsed the viewport
    // rectangle to nothing and left it that way until the window resized.
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSurfaceSize({ width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showMinimap]);
  /**
   * Mirror of `view` for use inside pointer handlers. Keeping the live value
   * in a ref lets `toWorld` stay identity-stable, so the memoized node and
   * edge subtrees do not rebuild on every pan/zoom frame. Synced in a layout
   * effect rather than during render so concurrent rendering cannot observe
   * a torn value.
   */
  const viewRef = useRef(view);
  useLayoutEffect(() => {
    viewRef.current = view;
  }, [view]);

  const [cursor, setCursor] = useState<'grab' | 'grabbing' | 'crosshair' | 'default'>(
    'default',
  );
  /** Live drag-link preview, or null. */
  const [link, setLink] = useState<LinkState | null>(null);
  /**
   * Click-to-link: an output port that was CLICKED (not dragged). The next
   * click on a node completes the edge. Kept separate from `link` because it
   * survives across pointer gestures.
   */
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [dropHint, setDropHint] = useState(false);

  /* ---------------- annotation tools & editors ---------------- */

  /**
   * The armed annotation tool. Press N to arm the note tool (the next click
   * drops a note), B to arm the section tool (the next drag draws a frame,
   * a click drops a default one). Modeless in the same way pendingLink is:
   * it survives across gestures until spent or Escaped.
   */
  const [tool, setTool] = useState<'note' | 'section' | null>(null);
  const toolRef = useRef(tool);
  useLayoutEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  /** Live section-draw preview rect, world units. */
  const [draft, setDraft] = useState<Marquee | null>(null);

  /**
   * The section a dragged node is currently over, or null.
   *
   * Purely a drop-target highlight. Membership in this app is spatial and
   * resolved from geometry whenever it is needed, so nothing is committed
   * when a node is released: dropping a node inside a frame does not write a
   * parent anywhere. What this state buys is the thing that was missing,
   * which is knowing BEFORE you let go that the frame is going to claim what
   * you are holding.
   */
  const [dropSection, setDropSection] = useState<string | null>(null);

  /**
   * In-place note text editor: which note, the live draft, and the scene
   * point that was double-clicked (null selects everything, for a note that
   * was just placed). The draft is the ONLY copy of the text being typed:
   * nothing reaches the topology until the editor submits, which it does
   * exactly once (see textWysiwyg).
   */
  const [noteEdit, setNoteEdit] = useState<{
    id: string;
    draft: string;
    caret: { x: number; y: number } | null;
  } | null>(null);
  /** In-place section label editor. */
  const [labelEdit, setLabelEdit] = useState<{ id: string; draft: string } | null>(
    null,
  );
  const labelEditDoneRef = useRef(false);

  const annotations = topology.annotations ?? EMPTY_ANNOTATIONS;
  const annIdSet = useMemo(() => new Set(annotations.map((a) => a.id)), [annotations]);

  /* ---------------- live mirrors for pointer handlers ---------------- */

  /**
   * Handlers run from native listeners on the window during a drag, and must
   * see the CURRENT topology and selection without being re-created (which
   * would tear down and rebuild the listeners mid-gesture). Refs are the
   * mechanism; they are written in a layout effect so a render can never be
   * observed half-applied.
   */
  const topoRef = useRef(topology);
  const selRef = useRef(selectedIds);
  useLayoutEffect(() => {
    topoRef.current = topology;
    selRef.current = selectedIds;
  }, [topology, selectedIds]);

  /* ---------------- coordinate conversion ---------------- */

  /**
   * Screen (client) -> world. This is the inverse of the <g> transform
   * `translate(vx,vy) scale(k)` applied inside an SVG whose top-left is at
   * the surface element's bounding rect. Getting this wrong makes every drag
   * drift under zoom, so it is the single source of truth: nothing else in
   * this file does its own math.
   *
   *   screen = world * k + v          =>      world = (screen - v) / k
   *
   * The consequence that matters, and that the test suite asserts: a screen
   * delta of D always corresponds to a world delta of exactly D / k, at every
   * zoom level, because the offset terms cancel in the subtraction.
   */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    const v = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (clientX - r.left - v.x) / v.k,
      y: (clientY - r.top - v.y) / v.k,
    };
  }, []);

  /**
   * The two rects every camera-aiming decision reads: the surface (what the
   * view transform is relative to) and the VISIBLE part of it (the shell's
   * uncovered-area sentinel, when provided). The panels float over the
   * canvas, so "centre of the canvas" and "centre of what the student can
   * see" are different points whenever a panel is open; fit, palette
   * placement, paste and keyboard zoom all want the second one. Measured at
   * call time, never subscribed to, so a panel toggle changes future aims
   * without ever moving the camera by itself.
   */
  const visibleRect = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return null;
    const surface = el.getBoundingClientRect();
    const v = visibleRef?.current?.getBoundingClientRect();
    // A degenerate sentinel (absent, or crushed to nothing by a tiny
    // window) falls back to the whole surface rather than to NaN maths.
    const view = v && v.width > 0 && v.height > 0 ? v : surface;
    return { surface, view };
  }, [visibleRef]);

  /**
   * Publish the view-centre getter for the shell's palette-click placement.
   * Reads the refs through visibleRect/toWorld, so the value is always
   * current without this effect ever re-running per pan/zoom frame. The
   * centre is the centre of the UNCOVERED area: a palette click happens
   * with the rail open by definition, and a node placed at the centre of
   * the full surface would land offset toward, or under, that very rail.
   */
  // Reported from an effect rather than at each call site, so the keyboard
  // shortcuts, the palette and the tool clearing itself after a draw all
  // reach the shell through one path.
  useEffect(() => {
    onToolChange?.(tool);
  }, [tool, onToolChange]);

  useEffect(() => {
    if (!exportSvgRef) return;
    exportSvgRef.current = () => {
      const svg = surfaceRef.current?.querySelector('svg.cv-svg');
      const nodes = topoRef.current.nodes;
      if (!svg || nodes.length === 0) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
        if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
      }
      // Annotations sit outside the node bounds by design, so a frame drawn
      // from the nodes alone would crop the notes explaining them.
      for (const a of topoRef.current.annotations ?? []) {
        // A note's height is derived from its wrapped text, so it has to be
        // laid out to be measured. Taking zero here cropped every note that
        // ran past the lowest node, which is most of them.
        const box = isSection(a)
          ? { width: a.width, height: a.height }
          : layoutNoteOf(a, a.text);
        const h = box.height;
        if (a.x < minX) minX = a.x;
        // A section's label plate paints ABOVE its frame.
        if ((isSection(a) ? a.y - 28 : a.y) < minY) {
          minY = isSection(a) ? a.y - 28 : a.y;
        }
        if (a.x + box.width > maxX) maxX = a.x + box.width;
        if (a.y + h > maxY) maxY = a.y + h;
      }
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim();
      return serialiseSvg(
        svg as SVGSVGElement,
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        bg || '#ffffff',
      );
    };
    return () => {
      exportSvgRef.current = null;
    };
  }, [exportSvgRef]);

  useEffect(() => {
    if (!armToolRef) return;
    armToolRef.current = (t) => {
      setPendingLink(null);
      // Re-arming the tool already armed disarms it, matching the keyboard.
      setTool((cur) => (cur === t ? null : t));
    };
    return () => {
      armToolRef.current = null;
    };
  }, [armToolRef]);

  useEffect(() => {
    if (!viewCenterRef) return;
    viewCenterRef.current = () => {
      const rects = visibleRect();
      if (!rects) return { x: 0, y: 0 };
      const { view } = rects;
      return toWorld(view.left + view.width / 2, view.top + view.height / 2);
    };
    return () => {
      viewCenterRef.current = null;
    };
  }, [viewCenterRef, toWorld, visibleRect]);

  /* ---------------- the zoom write ---------------- */

  /**
   * THE zoom write. Every path that changes the scale — the wheel, the
   * two-finger pinch, the keyboard chords, the corner buttons, the 100%
   * reset — funnels through this one function, so a single clamp and a
   * single rounding govern all of them and no two paths can drift to
   * different limits. The rounding (three decimals) also stops repeated
   * in/out steps accumulating float residue that would make "100%" quietly
   * render as 99%.
   *
   * `next` maps the current scale to the wanted one; (px, py) is the point
   * in surface coords that stays pinned while the scale changes.
   *
   * Declared before the pointer handlers because the pinch path inside
   * onSurfaceMove closes over it.
   */
  const zoomAt = useCallback((px: number, py: number, next: (k: number) => number) => {
    setView((v) => {
      const k = clamp(Math.round(next(v.k) * 1000) / 1000, MIN_ZOOM, MAX_ZOOM);
      if (k === v.k) return v;
      const wx = (px - v.x) / v.k;
      const wy = (py - v.y) / v.k;
      return { k, x: px - wx * k, y: py - wy * k };
    });
  }, []);

  /* ---------------- selection helpers ---------------- */

  const nodeIdSet = useMemo(
    () => new Set(topology.nodes.map((n) => n.id)),
    [topology.nodes],
  );

  /* ---------------- node entrances ---------------- */

  /**
   * The one node whose arrival earns an entrance: the single id present now
   * that was absent a render ago, and only when it arrived ALONE onto a
   * canvas that already had content. That shape is exactly a palette drop or
   * a palette click. A preset load or session restore replaces many ids at
   * once and the very first render has no previous set at all, so neither
   * animates: content that is simply present does not get an entrance.
   *
   * Sticky by design: the id is kept, not cleared on the next render,
   * because renders arrive every 100ms while the simulation runs and
   * removing the class mid-flight would cut the animation off. The keyframe
   * runs once per element, so the stale class on a settled node costs
   * nothing. Render-phase ref writes guarded by an identity check, so
   * StrictMode's double render observes identical values both times.
   */
  const prevIdsRef = useRef<ReadonlySet<string> | null>(null);
  const enteredIdRef = useRef<string | null>(null);
  if (prevIdsRef.current !== nodeIdSet) {
    const prev = prevIdsRef.current;
    prevIdsRef.current = nodeIdSet;
    if (prev && prev.size > 0 && nodeIdSet.size === prev.size + 1) {
      let added: string | null = null;
      for (const id of nodeIdSet) {
        if (!prev.has(id)) {
          if (added !== null) {
            added = null;
            break;
          }
          added = id;
        }
      }
      if (added !== null) enteredIdRef.current = added;
    }
  }

  const setSelection = useCallback(
    (ids: ReadonlySet<string>) => {
      const cur = selRef.current;
      // Skip the callback when nothing actually changed, so a plain click on
      // an already-selected node does not churn the shell's state.
      if (cur.size === ids.size) {
        let same = true;
        for (const id of ids) {
          if (!cur.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      onSelectionChange(ids);
    },
    [onSelectionChange],
  );

  /** Click semantics: plain replaces, shift/ctrl toggles. */
  const selectOne = useCallback(
    (id: string, additive: boolean) => {
      if (!additive) {
        setSelection(new Set([id]));
        return;
      }
      const next = new Set(selRef.current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
    },
    [setSelection],
  );

  const clearSelection = useCallback(() => {
    setSelection(EMPTY_SELECTION);
  }, [setSelection]);

  /* ---------------- link validity ---------------- */

  /**
   * Whether an edge from -> to may be created. Rejects a self-link and a
   * duplicate. Both rejections are reported to the user by the target
   * refusing to highlight, and both make the drop a silent no-op.
   */
  const canLink = useCallback((from: string, to: string): boolean => {
    if (from === to) return false;
    const t = topoRef.current;
    if (!t.nodes.some((n) => n.id === from)) return false;
    if (!t.nodes.some((n) => n.id === to)) return false;
    return !t.edges.some((e) => e.from === from && e.to === to);
  }, []);

  /** World-space hit test against node rects. Topmost (last drawn) wins. */
  const nodeAt = useCallback((wx: number, wy: number): string | null => {
    const nodes = topoRef.current.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (wx >= n.x && wx <= n.x + NODE_W && wy >= n.y && wy <= n.y + NODE_H) {
        return n.id;
      }
    }
    return null;
  }, []);

  /* ---------------- gesture teardown ---------------- */

  const cancelGesture = useCallback(() => {
    const p = pendingRef.current;
    if (p) {
      const el = surfaceRef.current;
      try {
        if (el && el.hasPointerCapture?.(p.pointerId)) {
          el.releasePointerCapture(p.pointerId);
        }
      } catch {
        // Same reasoning as the capture above: releasing a pointer the
        // browser has already reclaimed is not an error worth propagating.
      }
      // Every way a node drag can end funnels through here: the pointerup
      // path, pointercancel, Escape, and the buttons===0 stale-gesture
      // guard. Announcing the boundary in this ONE place means the shell's
      // history sees exactly one end per begin, whichever exit fired.
      // Annotation drags share the node drag's history contract: one end
      // per begin, through this single funnel, whichever exit fired.
      if (
        p.active &&
        (p.mode === 'node' ||
          p.mode === 'ann' ||
          p.mode === 'ann-resize' ||
          p.mode === 'note-resize' ||
          p.mode === 'note-scale')
      ) {
        onMoveEnd?.();
      }
    }
    pendingRef.current = null;
    setLink(null);
    setMarquee(null);
    setDraft(null);
    setDropSection(null);
    setCursor(spaceRef.current ? 'grab' : 'default');
  }, [onMoveEnd]);

  /* ---------------- pointerdown: route, do not capture ---------------- */

  /**
   * Resolve what was pressed. Reads `data-hit` attributes rather than relying
   * on per-element React handlers, so the decision is made in ONE place with
   * full knowledge, instead of being raced by stopPropagation calls scattered
   * across the tree.
   */
  const hitTest = useCallback((target: EventTarget | null): Hit => {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') {
      return BACKGROUND_HIT;
    }
    const found = el.closest('[data-hit]');
    if (!found) return BACKGROUND_HIT;
    const kind = found.getAttribute('data-hit') as HitKind | null;
    if (!kind) return BACKGROUND_HIT;
    return {
      kind,
      id: found.getAttribute('data-id'),
      dir: found.getAttribute('data-dir'),
      size: found.getAttribute('data-size'),
      tone: found.getAttribute('data-tone'),
      fontName: found.getAttribute('data-font-name'),
    };
  }, []);

  const onSurfaceDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // (A) Interactive chrome is never the canvas's business. Structurally
      // it is not even a descendant of this element, but a stray button
      // rendered inside the surface later must still be safe.
      const el = e.target as Element | null;
      if (el?.closest?.('button, input, select, textarea, a, [data-chrome]')) {
        return;
      }

      // Route the press by button AND pointer type: a primary press starts a
      // gesture, the mouse middle button forces a pan, and everything else —
      // right button (the context menu is already suppressed), a pen's
      // barrel button (button 2), a pen's eraser tip (button 5) — is ignored
      // outright, so a barrel-button press can never be misread as a normal
      // press.
      const action = pressAction(e.button, e.pointerType);
      if (action === 'none') return;
      const middle = action === 'pan';

      // PALM REJECTION, decided once at press time: a touch that is either
      // palm-sized or landing while the pen is in contact never becomes a
      // gesture, is never tracked, and therefore can never start or join a
      // pinch. See pointerInput.ts for the policy and its limits.
      if (isPalmTouch(e.pointerType, e.width, e.height, penDownRef.current)) {
        return;
      }
      if (e.pointerType === 'pen') penDownRef.current = true;

      if (e.pointerType === 'touch') {
        const rect = e.currentTarget.getBoundingClientRect();
        touchesRef.current.set(e.pointerId, {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });

        // A third finger joining mid-pinch changes nothing: the pinch keeps
        // its original pair, and the extra contact is merely tracked.
        if (pinchRef.current) return;

        if (touchesRef.current.size >= 2) {
          // SECOND FINGER DOWN = PINCH. Whatever the first finger had
          // started was almost certainly the opening of this pinch rather
          // than a deliberate drag, so abort it — and a node drag that had
          // already moved puts its nodes back first, so the aborted
          // fragment leaves no trace on the diagram.
          const prior = pendingRef.current;
          if (prior?.active && prior.mode === 'node' && prior.hit.id) {
            onMoveNode(
              prior.hit.id,
              prior.worldX + prior.grabDx,
              prior.worldY + prior.grabDy,
            );
            for (const [gid, o] of prior.groupOrigins) onMoveNode(gid, o.x, o.y);
          }
          cancelGesture();
          pinchRef.current = beginPinch(touchesRef.current, viewRef.current.k);
          return;
        }
      }

      const hit = middle ? BACKGROUND_HIT : hitTest(e.target);
      const w = toWorld(e.clientX, e.clientY);
      const v = viewRef.current;

      // An armed annotation tool claims the press whatever is under it: the
      // student asked to place something, so the next gesture is placement,
      // not selection. Space-held and middle-drag still win, because "get me
      // out of here" must always work.
      const armedTool = spaceRef.current || middle ? null : toolRef.current;

      pendingRef.current = {
        pointerId: e.pointerId,
        threshold: dragThresholdFor(e.pointerType),
        // Space-held or middle-drag forces a pan regardless of what is under
        // the pointer, which is the documented escape hatch for panning while
        // the viewport is full of nodes.
        hit: spaceRef.current || middle || armedTool ? BACKGROUND_HIT : hit,
        screenX: e.clientX,
        screenY: e.clientY,
        worldX: w.x,
        worldY: w.y,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
        vx: v.x,
        vy: v.y,
        active: false,
        mode: null,
        grabDx: 0,
        grabDy: 0,
        groupIds: [],
        groupOrigins: new Map(),
        groupAnnIds: [],
        groupAnnOrigins: new Map(),
        annRect: null,
        noteWrap: 0,
        tool: armedTool,
      };

      // (B) NO setPointerCapture here. That single line was the whole bug:
      // capturing on press retargets the subsequent pointerup to this
      // element, which suppresses the browser's synthesized `click` on any
      // button underneath and makes every overlay control inert. Capture
      // happens at promotion, in onSurfaceMove, once the gesture is known to
      // be a drag.
    },
    [hitTest, toWorld, cancelGesture, onMoveNode],
  );

  /* ---------------- pointermove: promote, then drag ---------------- */

  const promote = useCallback(
    (p: Pending, clientX: number, clientY: number) => {
      p.active = true;

      // An armed tool owns the whole gesture. The section tool draws its
      // frame; the note tool is a click gesture, so a drag under it degrades
      // to a pan rather than placing a note somewhere the pointer no longer
      // is.
      if (p.tool === 'section') {
        p.mode = 'draw-section';
        setDraft({ x: snap(p.worldX), y: snap(p.worldY), w: 0, h: 0 });
        setCursor('crosshair');
        try {
          surfaceRef.current?.setPointerCapture(p.pointerId);
        } catch {
          // See the capture note below: optional, never a precondition.
        }
        return;
      }
      if (p.tool === 'note') {
        p.mode = 'pan';
        setCursor('grabbing');
        try {
          surfaceRef.current?.setPointerCapture(p.pointerId);
        } catch {
          // Ditto.
        }
        return;
      }

      switch (p.hit.kind) {
        case 'node': {
          const id = p.hit.id;
          const node = id ? topoRef.current.nodes.find((n) => n.id === id) : null;
          if (!node || !id) {
            p.mode = 'pan';
            break;
          }
          p.mode = 'node';

          /*
           * ALT+DRAG DUPLICATES, then drags the copies. The shell clones in
           * place, selects the clones and opens its own history gesture, so
           * onMoveStart is NOT fired for this path (one begin per end). The
           * drag origin is RESET to the pointer's position at this moment:
           * the clones were born here, and measuring their motion from the
           * original pointerdown would make them jump by the promotion
           * threshold the instant they appeared.
           */
          if (p.alt && onDuplicateForDrag) {
            const dup = onDuplicateForDrag(id);
            if (dup) {
              const cw = toWorld(clientX, clientY);
              p.hit = {
                kind: 'node',
                id: dup.id,
                dir: null,
                size: null,
                tone: null,
                fontName: null,
              };
              p.worldX = cw.x;
              p.worldY = cw.y;
              p.grabDx = node.x - cw.x;
              p.grabDy = node.y - cw.y;
              for (const g of dup.group) {
                p.groupIds.push(g.id);
                p.groupOrigins.set(g.id, { x: g.x, y: g.y });
              }
              break;
            }
          }

          // The drag is now real: give the shell its history baseline BEFORE
          // the selectOne below, so the baseline still holds the pre-drag
          // selection and undo restores it along with the position.
          onMoveStart?.();
          p.grabDx = node.x - p.worldX;
          p.grabDy = node.y - p.worldY;
          // Dragging a node that is part of a multi-selection moves the whole
          // selection. Dragging an unselected node moves only that node and
          // makes it the selection, which is what a user expects from a
          // direct grab.
          const sel = selRef.current;
          if (sel.has(id) && sel.size > 1) {
            for (const other of topoRef.current.nodes) {
              if (other.id !== id && sel.has(other.id)) {
                p.groupIds.push(other.id);
                p.groupOrigins.set(other.id, { x: other.x, y: other.y });
              }
            }
            // Selected annotations ride along, so a marqueed cluster moves
            // as one object whichever member was grabbed.
            for (const a of topoRef.current.annotations ?? []) {
              if (sel.has(a.id)) {
                p.groupAnnIds.push(a.id);
                p.groupAnnOrigins.set(a.id, { x: a.x, y: a.y });
              }
            }
          } else {
            selectOne(id, false);
          }
          break;
        }

        case 'note':
        case 'section': {
          const id = p.hit.id;
          const ann = id
            ? (topoRef.current.annotations ?? []).find((a) => a.id === id)
            : undefined;
          if (!ann || !id) {
            p.mode = 'pan';
            break;
          }
          p.mode = 'ann';
          // Same contract as a node drag: the baseline goes to the shell
          // BEFORE promotion selects the grabbed annotation.
          onMoveStart?.('move');
          p.grabDx = ann.x - p.worldX;
          p.grabDy = ann.y - p.worldY;
          const sel = selRef.current;
          if (sel.has(id) && sel.size > 1) {
            for (const other of topoRef.current.nodes) {
              if (sel.has(other.id)) {
                p.groupIds.push(other.id);
                p.groupOrigins.set(other.id, { x: other.x, y: other.y });
              }
            }
            for (const a of topoRef.current.annotations ?? []) {
              if (a.id !== id && sel.has(a.id)) {
                p.groupAnnIds.push(a.id);
                p.groupAnnOrigins.set(a.id, { x: a.x, y: a.y });
              }
            }
          } else {
            selectOne(id, false);

            /* Dragging a section carries what it contains.
             *
             * Membership stays SPATIAL, which is the model's whole point: no
             * parent pointer is stored, nothing is reparented, and a node
             * dragged out of a frame simply stops being inside it. The set is
             * resolved once here, at grab time, from the geometry as it stands
             * at that instant, so the frame cannot collect nodes it merely
             * sweeps over on the way.
             *
             * A node counts as inside when its whole box is inside, not when
             * it merely overlaps. Dragging a group is a deliberate act, and
             * hauling along a node that happens to clip an edge of the frame
             * is the kind of surprise that makes a person distrust the tool.
             */
            if (ann.kind === 'section') {
              for (const n of topoRef.current.nodes) {
                const inside =
                  n.x >= ann.x &&
                  n.y >= ann.y &&
                  n.x + NODE_W <= ann.x + ann.width &&
                  n.y + NODE_H <= ann.y + ann.height;
                if (inside) {
                  p.groupIds.push(n.id);
                  p.groupOrigins.set(n.id, { x: n.x, y: n.y });
                }
              }
            }
          }
          break;
        }

        case 'section-resize': {
          const id = p.hit.id;
          const ann = id
            ? (topoRef.current.annotations ?? []).find((a) => a.id === id)
            : undefined;
          if (!ann || !id || !isSection(ann) || !p.hit.dir) {
            p.mode = 'pan';
            break;
          }
          p.mode = 'ann-resize';
          onMoveStart?.('resize');
          p.annRect = { x: ann.x, y: ann.y, w: ann.width, h: ann.height };
          break;
        }

        case 'note-resize':
        case 'note-scale': {
          const id = p.hit.id;
          const ann = id
            ? (topoRef.current.annotations ?? []).find((a) => a.id === id)
            : undefined;
          if (!ann || !id || !isNote(ann) || !p.hit.dir) {
            p.mode = 'pan';
            break;
          }
          p.mode = p.hit.kind === 'note-scale' ? 'note-scale' : 'note-resize';
          onMoveStart?.('resize');
          // w is the box the text occupies, not the wrap width: that is
          // where the handle sat, and a drag has to continue from the edge
          // under the pointer rather than jump to a wrap width the reader
          // never saw. h carries the note's scale at grab time rather than
          // a height: the height is derived from the text and is not ours
          // to set, and a scale drag needs its starting multiplier.
          const box = layoutNoteOf(ann, ann.text).width;
          p.annRect = { x: ann.x, y: ann.y, w: box, h: ann.scale ?? 1 };
          p.noteWrap = ann.width;
          break;
        }

        case 'note-size':
        case 'note-bold':
        case 'note-font':
        case 'note-tone':
        case 'section-tone':
          // Dragging a toolbar button or a swatch means nothing; the click
          // path handles all of them.
          p.mode = 'pan';
          break;

        case 'port-out':
          p.mode = 'link';
          setPendingLink(null);
          setLink({ from: p.hit.id!, x: p.worldX, y: p.worldY, over: null });
          break;

        case 'port-in':
        case 'edge':
        case 'edge-delete':
          // Dragging an edge or an input port is not a gesture this canvas
          // defines. Falling through to a pan is better than dead-ending the
          // pointer, because the user still gets motion for their effort.
          p.mode = 'pan';
          break;

        default:
          // Empty background: shift or ctrl starts a marquee, a plain drag
          // pans. Panning is the more common intent, and the marquee stays
          // one modifier away.
          p.mode = p.shift || p.ctrl ? 'marquee' : 'pan';
          break;
      }

      setCursor(p.mode === 'link' ? 'crosshair' : 'grabbing');

      // NOW the gesture is real, so take the pointer. From here on, moves and
      // the terminating up are guaranteed to reach this element even if the
      // pointer leaves the window.
      //
      // Capture is an OPTIMISATION, never a precondition: it throws
      // NotFoundError whenever the id does not belong to a live pointer —
      // a pointer released between the down and this promotion, or a
      // synthetic event from a test harness. Letting that escape would abort
      // the rest of promote() and leave the gesture half-built, which is a
      // far worse failure than a drag that stops tracking outside the window.
      try {
        surfaceRef.current?.setPointerCapture(p.pointerId);
      } catch {
        // Without capture the gesture still works inside the surface, which
        // is where essentially all of it happens.
      }
    },
    [selectOne, onMoveStart, onDuplicateForDrag, toWorld],
  );

  const onSurfaceMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Remembered for Ctrl+V, which pastes at the pointer. Client coords,
      // not world: the viewport can pan and zoom between this move and the
      // paste, and converting at paste time stays honest through both.
      lastClientRef.current = { x: e.clientX, y: e.clientY };

      // PINCH / TWO-FINGER PAN. A tracked touch updates its position; while
      // a pinch is live, each frame pans by the midpoint's travel and then
      // zooms to the ABSOLUTE target scale (initial scale times the finger
      // distance ratio) about the moving midpoint. The zoom goes through
      // zoomAt like every other zoom path, so the pinch obeys the same
      // clamp and rounding as the wheel, the buttons and the keyboard.
      if (e.pointerType === 'touch' && touchesRef.current.has(e.pointerId)) {
        const rect = e.currentTarget.getBoundingClientRect();
        touchesRef.current.set(e.pointerId, {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
        const pinch = pinchRef.current;
        if (pinch) {
          const frame = pinchFrame(pinch, touchesRef.current);
          if (frame) {
            setView((v) => ({ ...v, x: v.x + frame.dx, y: v.y + frame.dy }));
            zoomAt(frame.mid.x, frame.mid.y, () => frame.k);
            pinch.lastMid = frame.mid;
          }
          return;
        }
      }

      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;

      // The button is no longer down, so whatever this gesture was, it ended
      // somewhere we could not see.
      //
      // Capture is deliberately deferred until the drag threshold, which is
      // what keeps overlay buttons clickable. The cost is a window where a
      // press can leave the surface uncaptured: press a node, slide off before
      // the threshold, release outside the window, and no pointerup ever
      // reaches us. A mouse keeps one pointerId for its whole life, so the
      // next time the cursor crossed the canvas the stale entry would clear
      // the threshold and promote a drag with no button held, leaving a node
      // stuck to the cursor.
      //
      // One exception keeps ordinary clicks alive: browsers (and automation
      // that drives them) may deliver a hover move with buttons already 0 at
      // the press point, between pointerdown and pointerup. A pending press
      // that has not moved is a click in progress, not a stale gesture, so it
      // is left for pointerup to resolve. The stale-entry scenario above is
      // unaffected: a cursor re-entering the canvas has always moved.
      if (e.buttons === 0) {
        const sdx = e.clientX - p.screenX;
        const sdy = e.clientY - p.screenY;
        if (p.active || sdx * sdx + sdy * sdy >= 1) {
          cancelGesture();
        }
        return;
      }

      /*
       * Where this drag puts things. One decision for the whole gesture:
       * every branch below used to compute the same line, which meant four
       * copies to keep in step the moment the snap gained a second input.
       */
      const place = snapsToGrid(snapOn, e.ctrlKey || e.metaKey) ? snap : Math.round;

      if (!p.active) {
        const dx = e.clientX - p.screenX;
        const dy = e.clientY - p.screenY;
        // Squared comparison: no sqrt on the hot path. The threshold is the
        // one latched at press time for this pointer's type.
        if (dx * dx + dy * dy < p.threshold * p.threshold) return;
        promote(p, e.clientX, e.clientY);
      }

      if (p.mode === 'pan') {
        setView((v) => ({
          ...v,
          x: p.vx + (e.clientX - p.screenX),
          y: p.vy + (e.clientY - p.screenY),
        }));
        return;
      }

      const w = toWorld(e.clientX, e.clientY);

      if (p.mode === 'node') {
        const id = p.hit.id!;
        /*
         * Ctrl (or Cmd) held DURING the drag bypasses the 8px grid snap.
         * Checked live on every move, not latched at pointerdown, so the
         * escape hatch can be pressed for the last few pixels of an
         * otherwise snapped drag, which is exactly how it is used. Rounded
         * to whole pixels so a free-placed node never carries fractional
         * world coordinates into the saved session.
         */
        const nx = place(w.x + p.grabDx);
        const ny = place(w.y + p.grabDy);
        onMoveNode(id, nx, ny);
        // Highlight whichever section this node is about to land in, so the
        // grouping is visible before the drop rather than discovered after.
        setDropSection(
          sectionAtPoint(topoRef.current.annotations, nx + NODE_W / 2, ny + NODE_H / 2),
        );
        // Grouped members translate by the same snapped delta, so the shape
        // of a multi-selection is preserved exactly rather than each member
        // being snapped independently.
        if (p.groupIds.length > 0 || p.groupAnnIds.length > 0) {
          const mdx = nx - place(p.worldX + p.grabDx);
          const mdy = ny - place(p.worldY + p.grabDy);
          for (const other of p.groupIds) {
            const o = p.groupOrigins.get(other);
            if (o) onMoveNode(other, o.x + mdx, o.y + mdy);
          }
          for (const other of p.groupAnnIds) {
            const o = p.groupAnnOrigins.get(other);
            if (o) onMoveAnnotation?.(other, o.x + mdx, o.y + mdy);
          }
        }
        return;
      }

      if (p.mode === 'ann') {
        const id = p.hit.id!;
        // The same live snap-bypass a node drag honours.
        const nx = place(w.x + p.grabDx);
        const ny = place(w.y + p.grabDy);
        onMoveAnnotation?.(id, nx, ny);
        if (p.groupIds.length > 0 || p.groupAnnIds.length > 0) {
          const mdx = nx - place(p.worldX + p.grabDx);
          const mdy = ny - place(p.worldY + p.grabDy);
          for (const other of p.groupIds) {
            const o = p.groupOrigins.get(other);
            if (o) onMoveNode(other, o.x + mdx, o.y + mdy);
          }
          for (const other of p.groupAnnIds) {
            const o = p.groupAnnOrigins.get(other);
            if (o) onMoveAnnotation?.(other, o.x + mdx, o.y + mdy);
          }
        }
        return;
      }

      if (p.mode === 'ann-resize' && p.annRect) {
        const r = resizeRect(
          p.annRect,
          p.hit.dir as ResizeDir,
          w.x - p.worldX,
          w.y - p.worldY,
          place,
          SECTION_MIN_WIDTH,
          SECTION_MIN_HEIGHT,
        );
        onResizeSection?.(p.hit.id!, r.x, r.y, r.w, r.h);
        return;
      }

      if (p.mode === 'note-resize' && p.annRect) {
        // Only the dragged edge moves. Pulling the WEST handle moves the
        // note's x as well as its width, so the east edge stays put and the
        // note grows leftward rather than sliding across the canvas.
        const dx = w.x - p.worldX;
        const east = p.annRect.x + p.annRect.w;
        let x = p.annRect.x;
        let width: number;
        if (p.hit.dir === 'w') {
          x = place(p.annRect.x + dx);
          width = east - x;
          if (width < NOTE_MIN_WIDTH) {
            width = NOTE_MIN_WIDTH;
            x = east - NOTE_MIN_WIDTH;
          } else if (width > NOTE_MAX_WIDTH) {
            width = NOTE_MAX_WIDTH;
            x = east - NOTE_MAX_WIDTH;
          }
        } else {
          width = clamp(place(p.annRect.w + dx), NOTE_MIN_WIDTH, NOTE_MAX_WIDTH);
        }
        onResizeNote?.(p.hit.id!, x, width);
        return;
      }

      if (p.mode === 'note-scale' && p.annRect) {
        // Proportional: the type and the wrap width grow by the same factor,
        // so the line breaks stay where they are and the note keeps its
        // shape. Driven by the HORIZONTAL delta alone, because the height is
        // derived from the text and cannot be dragged: taking the larger of
        // dx and dy would make the note jump when the pointer moved
        // vertically over a dimension it does not control.
        const dx = w.x - p.worldX;
        const grow = p.hit.dir?.includes('w') ? -dx : dx;
        const factor = (p.annRect.w + grow) / p.annRect.w;
        const scale = clamp(p.annRect.h * factor, NOTE_MIN_SCALE, NOTE_MAX_SCALE);
        // The width tracks the SAME clamped factor, so a note pinned at the
        // scale limit stops growing rather than stretching its box on alone.
        const applied = scale / p.annRect.h;
        const width = clamp(snap(p.noteWrap * applied), NOTE_MIN_WIDTH, NOTE_MAX_WIDTH);
        // A west-side corner keeps the east edge of the BOX still, exactly
        // as the side handle does: the box grows by the same factor.
        const x = p.hit.dir?.includes('w')
          ? p.annRect.x + p.annRect.w - p.annRect.w * applied
          : p.annRect.x;
        onScaleNote?.(p.hit.id!, x, width, scale);
        return;
      }

      if (p.mode === 'draw-section') {
        const x0 = snap(Math.min(p.worldX, w.x));
        const y0 = snap(Math.min(p.worldY, w.y));
        setDraft({
          x: x0,
          y: y0,
          w: snap(Math.max(p.worldX, w.x)) - x0,
          h: snap(Math.max(p.worldY, w.y)) - y0,
        });
        return;
      }

      if (p.mode === 'link') {
        // Snap to the whole node body, not to the input port. Requiring a
        // 5px port as the drop target is the single biggest reason linking
        // felt unreliable.
        const over = nodeAt(w.x, w.y);
        setLink((cur) => (cur ? { from: cur.from, x: w.x, y: w.y, over } : cur));
        return;
      }

      if (p.mode === 'marquee') {
        setMarquee({
          x: Math.min(p.worldX, w.x),
          y: Math.min(p.worldY, w.y),
          w: Math.abs(w.x - p.worldX),
          h: Math.abs(w.y - p.worldY),
        });
      }
    },
    [
      promote,
      toWorld,
      onMoveNode,
      onMoveAnnotation,
      onResizeSection,
      nodeAt,
      cancelGesture,
      zoomAt,
      snapOn,
    ],
  );

  /* ---------------- pointerup: click, or finish the drag ---------------- */

  const onSurfaceUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Multi-pointer bookkeeping first, whatever else this up means: the
      // pen is no longer in contact (touches stop being palm-rejected), and
      // a lifted finger leaves the touch map. Lifting either finger of a
      // pinch ends the pinch; the surviving finger deliberately starts
      // nothing, because its pending gesture was cancelled at pinch start
      // and inventing a pan from its stale position would jump the view.
      if (e.pointerType === 'pen') penDownRef.current = false;
      if (e.pointerType === 'touch') {
        pinchRef.current = endPointer(
          touchesRef.current,
          pinchRef.current,
          e.pointerId,
        );
      }

      const p = pendingRef.current;
      if (!p || p.pointerId !== e.pointerId) return;

      if (!p.active) {
        /* ---- CLICK ---- */
        const additive = p.shift || p.ctrl;

        // An armed annotation tool spends itself on this click: the note
        // lands under the pointer with its editor already open, the section
        // lands centred on the point at its default size. Either way the
        // tool disarms, so a second placement is a deliberate second arm.
        if (p.tool) {
          if (p.tool === 'note') {
            const id = onCreateNote?.(snap(p.worldX), snap(p.worldY)) ?? null;
            setTool(null);
            if (id) setNoteEdit({ id, draft: NEW_NOTE_TEXT, caret: null });
          } else {
            onCreateSection?.(
              snap(p.worldX - NEW_SECTION_W / 2),
              snap(p.worldY - NEW_SECTION_H / 2),
              NEW_SECTION_W,
              NEW_SECTION_H,
            );
            setTool(null);
          }
          cancelGesture();
          return;
        }

        // A click while a click-link is armed always tries to complete it,
        // whatever it landed on. That is what makes two-click linking feel
        // like one gesture rather than two unrelated clicks.
        if (pendingLink !== null) {
          const from = pendingLink;
          setPendingLink(null);
          let target: string | null = null;
          if (
            p.hit.kind === 'node' ||
            p.hit.kind === 'port-in' ||
            p.hit.kind === 'port-out'
          ) {
            target = p.hit.id;
          } else {
            target = nodeAt(p.worldX, p.worldY);
          }
          if (target && canLink(from, target)) {
            onConnect(from, target);
            cancelGesture();
            return;
          }
          // Invalid or empty: the arm is spent and the click falls through to
          // ordinary selection, so a mis-aimed second click is not a dead end.
        }

        switch (p.hit.kind) {
          case 'edge-delete':
            if (p.hit.id) {
              onDeleteSelection([], [p.hit.id]);
              clearSelection();
            }
            break;

          case 'node':
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'edge':
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'port-out':
            // Arm a click-to-link. Selecting the node too would fight the
            // arming state visually, so a port click does only this.
            if (p.hit.id) setPendingLink(p.hit.id);
            break;

          case 'port-in':
            // An input port click selects its node; there is nothing to arm
            // from an input.
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'note':
          case 'section':
          case 'section-resize':
          case 'note-resize':
          case 'note-scale':
            // A handle click without a drag is a click on what it belongs to.
            if (p.hit.id) selectOne(p.hit.id, additive);
            break;

          case 'note-size':
            if (
              p.hit.id &&
              (p.hit.size === 'sm' || p.hit.size === 'md' || p.hit.size === 'lg')
            ) {
              onSetNoteSize?.(p.hit.id, p.hit.size);
            }
            break;

          case 'section-tone': {
            const tone = Number(p.hit.tone);
            if (p.hit.id && Number.isInteger(tone)) {
              onSetSectionTone?.(p.hit.id, tone);
            }
            break;
          }

          case 'note-bold':
            if (p.hit.id) onSetNoteStyle?.(p.hit.id, { bold: 'toggle' });
            break;

          case 'note-font': {
            const f = p.hit.fontName;
            if (p.hit.id && f && (ANNOTATION_FONTS as readonly string[]).includes(f)) {
              onSetNoteStyle?.(p.hit.id, { font: f as AnnotationFont });
            }
            break;
          }

          case 'note-tone': {
            if (!p.hit.id) break;
            // "none" is a real choice, not a missing value: it puts the note
            // back to the body text colour, which no swatch can express.
            if (p.hit.tone === 'none') {
              onSetNoteStyle?.(p.hit.id, { tone: null });
              break;
            }
            const t = Number(p.hit.tone);
            if (Number.isInteger(t)) onSetNoteStyle?.(p.hit.id, { tone: t });
            break;
          }

          default:
            if (!additive) clearSelection();
            break;
        }

        cancelGesture();
        return;
      }

      /* ---- END OF DRAG ---- */

      if (p.mode === 'link') {
        const w = toWorld(e.clientX, e.clientY);
        const target = nodeAt(w.x, w.y);
        if (target && canLink(p.hit.id!, target)) {
          onConnect(p.hit.id!, target);
        }
        // Releasing over empty space, over the source, or over an existing
        // target is a clean no-op: cancelGesture below drops the preview.
      } else if (p.mode === 'marquee') {
        const w = toWorld(e.clientX, e.clientY);
        const x0 = Math.min(p.worldX, w.x);
        const y0 = Math.min(p.worldY, w.y);
        const x1 = Math.max(p.worldX, w.x);
        const y1 = Math.max(p.worldY, w.y);
        // Intersection, not containment: a box that clips a node selects it.
        // Containment forces a user to lasso generously around big nodes.
        const next = new Set<string>(p.shift || p.ctrl ? selRef.current : []);
        for (const n of topoRef.current.nodes) {
          if (n.x <= x1 && n.x + NODE_W >= x0 && n.y <= y1 && n.y + NODE_H >= y0) {
            next.add(n.id);
          }
        }
        for (const a of topoRef.current.annotations ?? []) {
          if (isSection(a)) {
            // CONTAINMENT for sections, deliberately breaking the
            // intersection rule above: a section frames the very nodes a
            // marquee inside it sweeps up, so intersection would make it
            // impossible to box-select a section's contents without also
            // grabbing (and then dragging, or deleting) the frame itself.
            // A marquee that swallows the whole frame plainly means it.
            if (a.x >= x0 && a.x + a.width <= x1 && a.y >= y0 && a.y + a.height <= y1) {
              next.add(a.id);
            }
          } else {
            const box = layoutNoteOf(a, a.text);
            if (
              a.x <= x1 &&
              a.x + box.width >= x0 &&
              a.y <= y1 &&
              a.y + box.height >= y0
            ) {
              next.add(a.id);
            }
          }
        }
        setSelection(next);
      } else if (p.mode === 'draw-section') {
        const w = toWorld(e.clientX, e.clientY);
        const x0 = snap(Math.min(p.worldX, w.x));
        const y0 = snap(Math.min(p.worldY, w.y));
        const dw = snap(Math.max(p.worldX, w.x)) - x0;
        const dh = snap(Math.max(p.worldY, w.y)) - y0;
        // The minimums also rescue an accidental micro-drag: whatever was
        // drawn, a real section appears where the gesture happened.
        onCreateSection?.(
          x0,
          y0,
          Math.max(dw, SECTION_MIN_WIDTH),
          Math.max(dh, SECTION_MIN_HEIGHT),
        );
        setDraft(null);
        setTool(null);
      }

      cancelGesture();
    },
    [
      pendingLink,
      nodeAt,
      canLink,
      onConnect,
      onDeleteSelection,
      onCreateNote,
      onCreateSection,
      onSetNoteSize,
      onSetSectionTone,
      onResizeNote,
      onScaleNote,
      onSetNoteStyle,
      clearSelection,
      selectOne,
      setSelection,
      toWorld,
      cancelGesture,
    ],
  );

  /* ---------------- pointercancel: the browser took the pointer ----------
   *
   * Fired when the OS or browser reclaims a pointer mid-gesture: digitizer-
   * level palm rejection, an incoming system edge gesture, a pen leaving
   * the hover range mid-press. Treated exactly like the buttons===0 guard —
   * whatever was in flight is dropped cleanly instead of staying armed
   * forever — plus the same multi-pointer bookkeeping as pointerup, so a
   * cancelled finger also ends a pinch it was half of.
   */
  const onSurfaceCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'pen') penDownRef.current = false;
      if (e.pointerType === 'touch') {
        pinchRef.current = endPointer(
          touchesRef.current,
          pinchRef.current,
          e.pointerId,
        );
      }
      const p = pendingRef.current;
      if (p && p.pointerId === e.pointerId) cancelGesture();
    },
    [cancelGesture],
  );

  /* ---------------- marquee drag on empty background ----------------
   *
   * A plain drag on empty background pans; shift/ctrl+drag box-selects.
   * Documented here and in the on-canvas hint so the choice is discoverable.
   */

  /* ---------------- wheel: zoom + pan ---------------- */

  // Attached natively (not via React's onWheel) because React attaches wheel
  // listeners as passive at the root, and ctrl+wheel must be preventable to
  // stop the browser's own page zoom on trackpad pinch.
  /* Text measurements taken before the font stack settles are measured
     against whatever face the browser had at the time, so every cached width
     is wrong once the real one arrives. Drop the cache and repaint. */
  const [metricsEpoch, forceRemeasure] = useState(0);
  useEffect(() => {
    if (!document.fonts?.ready) return;
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      resetTextMetrics();
      // The counter is threaded into every memoised text layout below, so
      // this is not only a repaint: the annotation views are React.memo
      // and would otherwise keep both their render and their memoised
      // wrap through it. Measured before the fix: a 340px hand-font note
      // painted five lines against the fallback face's widths where the
      // loaded face fits four.
      forceRemeasure((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Zoom about the visible centre: the keyboard and button path. The pivot
   * is the centre of the UNCOVERED area, not of the surface, so repeated
   * zooming with a panel open does not walk the content toward (and then
   * under) that panel.
   */
  const zoomCentered = useCallback(
    (next: (k: number) => number) => {
      const rects = visibleRect();
      if (!rects) return;
      const { surface: r, view: vr } = rects;
      zoomAt(vr.left - r.left + vr.width / 2, vr.top - r.top + vr.height / 2, next);
    },
    [zoomAt, visibleRect],
  );
  /** For the note editor's zoom chords, which are bound once per edit. */
  const zoomCenteredRef = useRef(zoomCentered);
  useLayoutEffect(() => {
    zoomCenteredRef.current = zoomCentered;
  }, [zoomCentered]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      // Trackpad pinch arrives as ctrlKey wheel events on every platform.
      // Keep the world point under the CURSOR pinned to the cursor.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(
          e.clientX - r.left,
          e.clientY - r.top,
          (k) => k * Math.exp(-e.deltaY * 0.0022),
        );
        return;
      }
      // Plain wheel / two-finger scroll pans.
      e.preventDefault();
      setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  /* ---------------- space-to-pan ---------------- */

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      // Only claim space when the canvas is what the user is looking at.
      if (
        hostRef.current?.contains(document.activeElement) ||
        document.activeElement === document.body
      ) {
        spaceRef.current = true;
        if (!pendingRef.current) setCursor('grab');
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      if (!pendingRef.current) setCursor('default');
    };
    const blur = () => {
      spaceRef.current = false;
      if (!pendingRef.current) setCursor('default');
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ---------------- keyboard: delete, escape, select-all ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      if (e.key === 'Escape') {
        // Escape unwinds one layer at a time is tempting, but a beginner
        // pressing Escape means "get me out of whatever this is". So it
        // cancels the in-flight gesture, the armed link, the armed
        // annotation tool AND the selection.
        if (pendingRef.current) cancelGesture();
        setPendingLink(null);
        setLink(null);
        setMarquee(null);
        setTool(null);
        clearSelection();
        return;
      }

      /*
       * Annotation tools. N arms the note tool, B (a "block" of nodes) the
       * section tool; pressing the same key again disarms, so a mistaken
       * arm costs one keystroke. Modifiers are required absent so the
       * chords cannot shadow Ctrl+N / Ctrl+B in the browser, matching the
       * shell's single-letter panel toggles. Arming clears a pending
       * click-link: two armed "the next click does something" modes at once
       * would make the next click ambiguous.
       */
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          setPendingLink(null);
          setTool((t) => (t === 'note' ? null : 'note'));
          return;
        }
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          setPendingLink(null);
          setTool((t) => (t === 'section' ? null : 'section'));
          return;
        }
      }

      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const all = new Set<string>();
        for (const n of topology.nodes) all.add(n.id);
        for (const ed of topology.edges) all.add(ed.id);
        for (const a of annotations) all.add(a.id);
        setSelection(all);
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        e.preventDefault();
        const nodes: string[] = [];
        const edges: string[] = [];
        const anns: string[] = [];
        for (const id of selectedIds) {
          if (nodeIdSet.has(id)) nodes.push(id);
          else if (annIdSet.has(id)) anns.push(id);
          else edges.push(id);
        }
        onDeleteSelection(nodes, edges, anns);
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    selectedIds,
    nodeIdSet,
    annIdSet,
    topology.nodes,
    topology.edges,
    annotations,
    onDeleteSelection,
    clearSelection,
    setSelection,
    cancelGesture,
  ]);

  /* ---------------- keyboard activation from a node ---------------- */

  const onActivate = useCallback(
    (id: string, additive: boolean) => {
      // Enter on an output-port-armed canvas completes the link, matching the
      // click path.
      if (pendingLink !== null && canLink(pendingLink, id)) {
        onConnect(pendingLink, id);
        setPendingLink(null);
        return;
      }
      selectOne(id, additive);
    },
    [pendingLink, canLink, onConnect, selectOne],
  );

  const onNudge = useCallback(
    (id: string, dx: number, dy: number) => {
      const n = topology.nodes.find((m) => m.id === id);
      if (!n) return;
      // Deliberately unsnapped: the step itself is the grid unit for a plain
      // arrow, and the shift+arrow fine step exists precisely to move OFF
      // the grid, which a snap here would silently undo.
      onMoveNode(id, n.x + dx, n.y + dy);
    },
    [topology.nodes, onMoveNode],
  );

  /* ---------------- double-click rename ----------------
   *
   * The universal canvas convention: double-click a node, type, Enter or
   * click away commits, Escape cancels, an empty name reverts. The editor is
   * an HTML input floated over the node's header (SVG has no editable text),
   * positioned from the same world-to-screen maths the canvas itself uses so
   * it tracks the node at any zoom. It is a sibling of the surface, so the
   * pointer router never sees presses on it, and its keystrokes are safe
   * from every shortcut via the isTypingTarget guards.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  /** Guards the commit-on-blur that follows an Escape or Enter unmount. */
  const renameDoneRef = useRef(false);

  const onSurfaceDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = e.target as Element | null;
      if (el?.closest?.('button, input, select, textarea, a, [data-chrome]')) return;
      const hit = hitTest(e.target);
      if (!hit.id) return;

      // Double-click a note: edit its text in place, with the caret on the
      // character that was double-clicked (Excalidraw's
      // initialCaretSceneCoords). Double-click a section border, label or
      // handle: edit its label, with the rename editor's contract.
      // A handle counts as the note: the first click of the double-click
      // selects the note and grows its handles under the pointer, so a
      // double-click near an edge lands its second click on a handle.
      if (
        hit.kind === 'note' ||
        hit.kind === 'note-resize' ||
        hit.kind === 'note-scale'
      ) {
        const ann = (topoRef.current.annotations ?? []).find((a) => a.id === hit.id);
        if (!ann || !isNote(ann)) return;
        e.preventDefault();
        setNoteEdit({
          id: ann.id,
          draft: ann.text,
          caret: toWorld(e.clientX, e.clientY),
        });
        return;
      }
      if (hit.kind === 'section' || hit.kind === 'section-resize') {
        const ann = (topoRef.current.annotations ?? []).find((a) => a.id === hit.id);
        if (!ann || !isSection(ann)) return;
        e.preventDefault();
        labelEditDoneRef.current = false;
        setLabelEdit({ id: ann.id, draft: ann.label });
        return;
      }

      if (hit.kind !== 'node') return;
      const node = topoRef.current.nodes.find((n) => n.id === hit.id);
      if (!node) return;
      e.preventDefault();
      renameDoneRef.current = false;
      setRenameDraft(node.label);
      setRenaming(node.id);
    },
    [hitTest, toWorld],
  );

  const commitRename = useCallback(() => {
    if (renameDoneRef.current) return;
    renameDoneRef.current = true;
    const id = renaming;
    setRenaming(null);
    if (!id || !onRename) return;
    const node = topoRef.current.nodes.find((n) => n.id === id);
    const label = renameDraft.trim();
    // An empty name reverts silently: a node must always have a name, and
    // "you cleared the box so the label is gone" helps nobody.
    if (!node || label === '' || label === node.label) return;
    onRename(id, label);
  }, [renaming, renameDraft, onRename]);

  const cancelRename = useCallback(() => {
    renameDoneRef.current = true;
    setRenaming(null);
  }, []);

  /* ---------------- annotation editors ----------------
   *
   * The note editor is Excalidraw's textWysiwyg (see textWysiwyg.ts): a
   * textarea created imperatively when an edit starts, appended to the
   * editor container below (a sibling of the surface, so the pointer router
   * never sees it), updated from the live note and view on every render,
   * and torn down by its own submit. Enter inserts a newline; Escape,
   * Ctrl+Enter and blur submit; a press on the format bar or the zoom
   * control disarms the blur submit until the following pointerup, so
   * restyling while typing keeps the caret where it was. The shell removes
   * a note whose submitted text is empty. There is no cancel: undo is the
   * way back, and a silent revert would throw typing away.
   *
   * The label editor is a single-line input with the rename editor's exact
   * contract.
   */

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<TextWysiwyg | null>(null);
  /** Live mirror, read once when an edit starts. */
  const noteEditRef = useRef(noteEdit);
  useLayoutEffect(() => {
    noteEditRef.current = noteEdit;
  }, [noteEdit]);

  const editingNoteId = noteEdit?.id ?? null;
  useLayoutEffect(() => {
    if (!editingNoteId) return;
    const host = editorHostRef.current;
    const surface = surfaceRef.current;
    const start = noteEditRef.current;
    if (!host || !surface || !start || start.id !== editingNoteId) return;
    const id = editingNoteId;
    const findNote = () => {
      const ann = (topoRef.current.annotations ?? []).find((a) => a.id === id);
      return ann && isNote(ann) ? ann : null;
    };
    if (!findNote()) return;

    // deselect all other elements when inserting text
    setSelection(EMPTY_SELECTION);

    const editor = textWysiwyg({
      getNote: findNote,
      initialText: start.draft,
      getViewportCoords: (x, y) => {
        const v = viewRef.current;
        return [x * v.k + v.x, y * v.k + v.y];
      },
      getZoom: () => viewRef.current.k,
      container: host,
      surface,
      chromeSelector: '[data-chrome="format"], [data-chrome="zoom"]',
      autoSelect: !coarsePointerRef.current,
      initialCaretSceneCoords: start.caret,
      onChange: (text) => {
        setNoteEdit((cur) => (cur && cur.id === id ? { ...cur, draft: text } : cur));
      },
      onSubmit: ({ viaKeyboard, nextText }) => {
        editorRef.current = null;
        setNoteEdit((cur) => (cur && cur.id === id ? null : cur));
        const ann = findNote();
        if (ann && nextText !== ann.text) onEditNote?.(id, nextText);
        // keyboard-submit keeps focus on the edited object. Only while it
        // survives: an emptied note is removed by the shell.
        if (viaKeyboard && nextText.trim()) setSelection(new Set([id]));
      },
      actions: {
        zoomIn: () => zoomCenteredRef.current((k) => k * ZOOM_STEP),
        zoomOut: () => zoomCenteredRef.current((k) => k / ZOOM_STEP),
        resetZoom: () => zoomCenteredRef.current(() => 1),
        increaseFontSize: () => {
          const ann = findNote();
          if (!ann) return;
          const next = NOTE_SIZE_ORDER[NOTE_SIZE_ORDER.indexOf(ann.size) + 1];
          if (next) onSetNoteSize?.(id, next);
        },
        decreaseFontSize: () => {
          const ann = findNote();
          if (!ann) return;
          const next = NOTE_SIZE_ORDER[NOTE_SIZE_ORDER.indexOf(ann.size) - 1];
          if (next) onSetNoteSize?.(id, next);
        },
      },
    });
    editorRef.current = editor;
    return () => {
      // The note was deleted or replaced under the editor (a preset load),
      // or the canvas unmounted: submit, which is a no-op once destroyed
      // and finds no note to write to otherwise.
      editor.submit();
      if (editorRef.current === editor) editorRef.current = null;
    };
    // The editor's getters read refs; only the identity of the edit matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNoteId]);

  /* The editor follows the element: Excalidraw's scene.onUpdate and
     onScrollChange, which recompute the style from the live element and, on
     an element update, put focus back in the editor. */
  const editNoteLive = editingNoteId
    ? (annotations.find((a) => a.id === editingNoteId) ?? null)
    : null;
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!editNoteLive) {
      // The note was deleted or replaced under the editor (a preset load).
      // Submit finds nothing to write to, and tears the textarea down.
      editor.submit();
      return;
    }
    editor.update();
    editor.focus();
  }, [editNoteLive]);
  useLayoutEffect(() => {
    editorRef.current?.update();
  }, [view]);

  const commitLabelEdit = useCallback(() => {
    if (labelEditDoneRef.current) return;
    labelEditDoneRef.current = true;
    const edit = labelEdit;
    setLabelEdit(null);
    if (!edit || !onEditSectionLabel) return;
    const ann = (topoRef.current.annotations ?? []).find((a) => a.id === edit.id);
    if (!ann || !isSection(ann)) return;
    const label = edit.draft.trim();
    if (label === ann.label) return;
    onEditSectionLabel(edit.id, label);
  }, [labelEdit, onEditSectionLabel]);

  const cancelLabelEdit = useCallback(() => {
    labelEditDoneRef.current = true;
    setLabelEdit(null);
  }, []);

  /* ---------------- system clipboard ----------------
   *
   * Native copy/cut/paste events, not key bindings: the browser fires these
   * for whatever chord the user's platform and layout assign, focus in a
   * text field keeps its native behaviour via the isTypingTarget guard, and
   * no clipboard permission prompt is ever raised.
   *
   * The PASTE PATH IS UNTRUSTED. Whatever is on the clipboard is parsed and
   * structurally validated exactly the way a share link would be
   * (parseClipboardText); anything that does not hold up is ignored without
   * an error, and the event is left unconsumed so the browser can do
   * whatever it would otherwise have done.
   */
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const text = buildClipboardText(topoRef.current, selRef.current);
      if (!text || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
    };

    const onCut = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const text = buildClipboardText(topoRef.current, selRef.current);
      if (!text || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', text);
      // Cut = copy + the same single-edit delete the Delete key performs.
      // Annotations partition into their own bucket: the clipboard does not
      // carry them, but a selected note must still leave the canvas.
      const ids = new Set(topoRef.current.nodes.map((n) => n.id));
      const annIds = new Set((topoRef.current.annotations ?? []).map((a) => a.id));
      const nodes: string[] = [];
      const edges: string[] = [];
      const anns: string[] = [];
      for (const id of selRef.current) {
        if (ids.has(id)) nodes.push(id);
        else if (annIds.has(id)) anns.push(id);
        else edges.push(id);
      }
      onDeleteSelection(nodes, edges, anns);
      clearSelection();
    };

    const onPasteEvent = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || !onPaste) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      const sub = parseClipboardText(text);
      if (!sub) return;
      e.preventDefault();
      // At the pointer when it is over the canvas; at the centre of the
      // VISIBLE (panel-free) area when it is not (a paste right after
      // switching windows, say), so the paste never lands under a panel.
      const last = lastClientRef.current;
      let at: { x: number; y: number };
      if (last) {
        at = toWorld(last.x, last.y);
      } else {
        const rects = visibleRect();
        at = rects
          ? toWorld(
              rects.view.left + rects.view.width / 2,
              rects.view.top + rects.view.height / 2,
            )
          : { x: 0, y: 0 };
      }
      onPaste(sub, at);
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPasteEvent);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPasteEvent);
    };
  }, [onDeleteSelection, clearSelection, onPaste, toWorld, visibleRect]);

  /* ---------------- palette drops ---------------- */

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (
      !e.dataTransfer.types.includes(NODE_DND_MIME) &&
      !e.dataTransfer.types.includes(ANN_DND_MIME)
    ) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHint(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Ignore bubbling leaves from children.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHint(false);
  }, []);

  /** Set by a node drop, cleared by the refit effect it suppresses. */
  const droppedRef = useRef(false);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setDropHint(false);

      // An annotation dragged off the palette. A dropped note opens its
      // editor immediately, matching the tool-armed click path.
      const ann = e.dataTransfer.getData(ANN_DND_MIME);
      if (ann === 'note' || ann === 'section') {
        e.preventDefault();
        const w = toWorld(e.clientX, e.clientY);
        if (ann === 'note') {
          const id = onCreateNote?.(snap(w.x), snap(w.y)) ?? null;
          if (id) setNoteEdit({ id, draft: NEW_NOTE_TEXT, caret: null });
        } else {
          onCreateSection?.(
            snap(w.x - NEW_SECTION_W / 2),
            snap(w.y - NEW_SECTION_H / 2),
            NEW_SECTION_W,
            NEW_SECTION_H,
          );
        }
        return;
      }

      const kind = e.dataTransfer.getData(NODE_DND_MIME) as NodeKind;
      if (!kind) return;
      e.preventDefault();
      const w = toWorld(e.clientX, e.clientY);
      // A dropped node is already under the cursor, so there is nothing for a
      // re-fit to reveal and the canvas must not slide out from under the
      // drop. Measured on an empty canvas: the first drop panned the view 48px
      // and the second 396px, with no pan input.
      droppedRef.current = true;
      // Drop centers the node on the cursor rather than pinning its corner.
      // A node dragged in from the rail is a component being dragged like any
      // other, so it honours the same preference a move does. Without this,
      // turning the snap off and dropping still landed on the grid.
      const place = snapsToGrid(snapOn, e.ctrlKey || e.metaKey) ? snap : Math.round;
      onDropNode(kind, place(w.x - NODE_W / 2), place(w.y - NODE_H / 2));
    },
    [toWorld, onDropNode, onCreateNote, onCreateSection, snapOn],
  );

  /* ---------------- fit to content ---------------- */

  /**
   * Fit a set of nodes into the viewport. The whole diagram for Shift+1 and
   * the corner button; just the selection for Shift+2. The scale takes the
   * same rounding zoomAt applies, so a fit and a keyboard zoom can never
   * report two spellings of the same percentage.
   */
  /** The surface size the last fit framed for. See the resize observer. */
  const fittedSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fitTo = useCallback(
    (nodes: readonly SimNode[]) => {
      const rects = visibleRect();
      if (!rects || nodes.length === 0) return;
      // Scale and centring both use the VISIBLE rect (see fitViewport), so a
      // fit with panels open, or the challenge sheet up on a phone, frames
      // the diagram in the uncovered area and never under an opaque panel.
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
        if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
      }
      const next = fitViewport(
        { minX, minY, maxX, maxY },
        rects.surface,
        rects.view,
        fitTight,
      );
      if (!next) return;
      // The surface size this fit was framed for, so the resize observer can
      // tell a real resize from the size it was already fitted to.
      fittedSizeRef.current = { w: rects.surface.width, h: rects.surface.height };
      setView(next);
    },
    [visibleRect, fitTight],
  );

  /**
   * Would a section's shade row fall outside what the student can see?
   *
   * Measured against the visible rect rather than the surface, because the
   * charts strip floats over the canvas: a row inside the surface but under
   * that strip is just as unclickable as one off the bottom of the window.
   */
  const toneRowWouldClip = useCallback(
    (s: Section) => {
      const rects = visibleRect();
      if (!rects) return false;
      const { surface, view: vis } = rects;
      // Screen y of the frame's bottom, plus the row and its gap.
      const bottom =
        surface.top + (s.y + s.height) * viewRef.current.k + viewRef.current.y;
      return bottom + 34 > vis.bottom;
    },
    [visibleRect],
  );

  /**
   * The one selected note, or null.
   *
   * Null for a multi-selection on purpose: the bar shows state (which size,
   * which face, which colour), and with two notes selected any answer it
   * gave would be wrong about one of them.
   */
  const formatNote = useMemo(() => {
    // The note being edited first: editing deselects everything (as
    // Excalidraw does), and its shape actions stay up for the element
    // being edited.
    const id = editingNoteId ?? (selectedIds.size === 1 ? [...selectedIds][0] : null);
    if (!id) return null;
    const ann = (topology.annotations ?? []).find((a) => a.id === id);
    return ann && isNote(ann) ? ann : null;
  }, [editingNoteId, selectedIds, topology.annotations]);

  /* Instruction copy names the gesture the reader can actually perform: a
     hint telling a phone to "click" and press "Esc" describes an app they do
     not have. */
  const coarsePointer = useCoarsePointer();
  const coarsePointerRef = useRef(coarsePointer);
  coarsePointerRef.current = coarsePointer;

  const fitToContent = useCallback(
    () => fitTo(topology.nodes),
    [fitTo, topology.nodes],
  );

  /**
   * Re-fit ONLY when the diagram is replaced wholesale: first content on a
   * previously empty canvas (mount, session restore), or an explicit
   * `fitSignal` bump from the shell (a preset load). Everything else keeps
   * the camera where the student put it, and a node dropped from the palette
   * is an edit like any other however empty the canvas was before it.
   *
   * The old trigger — the sorted node-id set — refit on EVERY add, delete
   * and undo-restore, which yanked the viewport under the student each time
   * (measured: deleting one node moved every click target ~160px with no pan
   * input, and made three coordinate-verified clicks land on the wrong
   * node). Excalidraw never moves the camera on add/delete, and it is right:
   * an editing operation must not re-aim the view.
   */
  const topoKey = useMemo(
    () =>
      topology.nodes
        .map((n) => n.id)
        .sort()
        .join(','),
    [topology.nodes],
  );

  const hadContentRef = useRef(false);
  const fitSignalRef = useRef(fitSignal);

  useLayoutEffect(() => {
    const hadContent = hadContentRef.current;
    hadContentRef.current = topology.nodes.length > 0;
    const signalChanged = fitSignalRef.current !== fitSignal;
    fitSignalRef.current = fitSignal;
    // Read and clear in one place, so a drop that lands while some other
    // guard already holds cannot leave the flag set for a later preset load.
    const dropped = droppedRef.current;
    droppedRef.current = false;
    if (topology.nodes.length === 0) return;
    // An edit to an already-populated diagram: keep the camera.
    if (hadContent && !signalChanged) return;
    // Never refit while a pointer gesture is in flight (same guard the
    // resize refit uses). An alt-drag duplicate changes the node-id set at
    // drag PROMOTION, and refitting there moved the viewport under the
    // pointer mid-drag; measured, a 75px drag displaced the clone 312 world
    // px. The clones are born under the pointer, so there is nothing to
    // reveal anyway.
    if (pendingRef.current) return;
    // A node dropped from the palette lands under the cursor, so the same
    // argument applies: there is nothing to reveal, and re-aiming here slides
    // the canvas out from under the drop.
    if (dropped) return;
    fitToContent();
    // fitToContent is intentionally omitted: it changes identity on every node
    // move, and re-fitting mid-drag is exactly what this guard prevents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey, fitSignal]);

  /** Latest fitToContent, so the resize observer below subscribes once. */
  const fitToContentRef = useRef(fitToContent);
  useEffect(() => {
    fitToContentRef.current = fitToContent;
  }, [fitToContent]);

  /** Re-fit on container resize, but only while the user is idle. */
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    // observe() delivers the element's CURRENT size on subscription, which
    // is not a resize. This effect used to depend on fitToContent, whose
    // identity moves with every topology change, so every drop re-subscribed
    // and that initial delivery re-aimed the camera one frame later.
    // Measured: a node dropped near the canvas edge zoomed the view from
    // 1.5 to 1.21 with nothing resized anywhere. The observer lives for the
    // surface's whole life.
    //
    // A delivery is a resize when the size differs from the one the last fit
    // framed for, not merely when it is not the first. Skipping the first
    // outright could lose a real one: if the surface changes size after the
    // boot fit and before the first delivery, that delivery IS the resize.
    // Measured on a ?challenge= link at 390px, the diagram sat about 100px
    // below the centre of the room it was framed for. With no fit yet (an
    // empty canvas) the first size is only recorded.
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.target.getBoundingClientRect();
      if (!box) return;
      const fitted = fittedSizeRef.current;
      if (!fitted) {
        fittedSizeRef.current = { w: box.width, h: box.height };
        return;
      }
      if (fitted.w === box.width && fitted.h === box.height) return;
      if (pendingRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitToContentRef.current());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const zoomBy = useCallback(
    (factor: number) => zoomCentered((k) => k * factor),
    [zoomCentered],
  );

  /* ---------------- keyboard: view + selection movement ----------------
   *
   * A second window listener rather than an extension of the delete/escape
   * one purely for declaration order: these chords need zoomCentered and
   * fitTo, which are defined between the two effects.
   *
   * The zoom chords are bound by e.code — Equal, Minus, Digit0 are physical
   * positions, so the bindings survive keyboard layouts where the printed
   * symbols move (the same reasoning as binding undo to KeyZ). Ctrl+= rather
   * than Ctrl+Shift+= because the browser's own zoom accepts either, and the
   * unshifted key is the one every canvas app documents.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;

      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.code === 'Equal' || e.code === 'NumpadAdd') {
          e.preventDefault();
          zoomCentered((k) => k * ZOOM_STEP);
          return;
        }
        if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
          e.preventDefault();
          zoomCentered((k) => k / ZOOM_STEP);
          return;
        }
        if (e.code === 'Digit0' || e.code === 'Numpad0') {
          e.preventDefault();
          zoomCentered(() => 1);
          return;
        }
        return;
      }

      // Shift+1 fits everything, Shift+2 the selection: the pair every
      // canvas app ships. Positional codes again, because Shift+1 is "!"
      // only on some layouts.
      if (e.shiftKey && !e.altKey && e.code === 'Digit1') {
        e.preventDefault();
        fitTo(topology.nodes);
        return;
      }
      if (e.shiftKey && !e.altKey && e.code === 'Digit2') {
        const sel = topology.nodes.filter((n) => selectedIds.has(n.id));
        if (sel.length === 0) return;
        e.preventDefault();
        fitTo(sel);
        return;
      }

      /*
       * Arrows move the whole SELECTION: one grid step plain, ONE PIXEL with
       * shift. The inversion (shift = finer, not coarser) is deliberate: the
       * arrow step IS the grid, so the escape hatch a grid user needs is fine
       * placement, and shift is where every grid editor puts it. Like the
       * per-node arrows, this pair is its own feature and does not read the
       * snap preference. A
       * focused UNSELECTED node handles its own arrows in NodeView and stops
       * propagation, so it never arrives here; a focused selected node lets
       * the event through precisely so this handler moves it with its group.
       */
      if (
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown') &&
        !e.altKey
      ) {
        const nodes = topology.nodes.filter((n) => selectedIds.has(n.id));
        if (nodes.length === 0) return;
        e.preventDefault();
        const step = e.shiftKey ? 1 : GRID;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        for (const n of nodes) onMoveNode(n.id, n.x + dx, n.y + dy);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomCentered, fitTo, topology.nodes, selectedIds, onMoveNode]);

  /* ---------------- derived render data ---------------- */

  const nodeById = useMemo(() => {
    const m = new Map<string, SimNode>();
    for (const n of topology.nodes) m.set(n.id, n);
    return m;
  }, [topology.nodes]);

  /**
   * What the design is made of, by category: "4 traffic, 7 compute, 3 data".
   *
   * The total says how big a diagram is; the breakdown says what kind of
   * system it is, which is what a reader is trying to work out about a
   * reconstruction they did not build themselves.
   *
   * Groups print in taxonomy order, not by size, so the line matches the
   * order of the rail and does not reshuffle itself every time a node is
   * dropped. Empty groups are left out: eleven of the twenty-three examples
   * touch only three of the six, and "0 messaging" on a three-box chain is
   * noise. The group's `id` is the name printed, because "specialised
   * stores" is too long for a corner that also has to hold two totals and a
   * clock.
   */
  const nodeGroupSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of topology.nodes) {
      const group = groupOfKind(n.kind);
      if (group) counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
    }
    return KIND_GROUPS.filter((g) => counts.has(g.id))
      .map((g) => `${counts.get(g.id)} ${g.id}`)
      .join(', ');
  }, [topology.nodes]);

  const spotNode = spotlightId ? (nodeById.get(spotlightId) ?? null) : null;

  /* Pan a spotlit node into view when it is off screen or under a panel,
     keeping the zoom. Keyed on the id alone, so the camera moves once per
     answer and never fights a pan the student makes afterwards. */
  useEffect(() => {
    if (!spotlightId) return;
    const n = topoRef.current.nodes.find((x) => x.id === spotlightId);
    const rects = visibleRect();
    if (!n || !rects) return;
    const { surface, view } = rects;
    const v = viewRef.current;
    const left = surface.left + (n.x - SPOT_PAD) * v.k + v.x;
    const top = surface.top + (n.y - SPOT_PAD - SPOT_TAG_H - 4) * v.k + v.y;
    const right = surface.left + (n.x + NODE_W + SPOT_PAD) * v.k + v.x;
    const bottom = surface.top + (n.y + NODE_H + SPOT_PAD) * v.k + v.y;
    /* Panels marked [data-spot-avoid] (the answer that named this node,
       an open "What just happened") cover the canvas. One that overlaps
       the node trims the band it sits in, top or bottom, from the area the
       node is centred in. On a phone that band is most of the strip. */
    let visTop = view.top;
    let visBottom = view.bottom;
    let covered = false;
    for (const el of document.querySelectorAll('[data-spot-avoid]')) {
      const o = el.getBoundingClientRect();
      if (o.width === 0 || o.height === 0) continue;
      const mid = (view.top + view.bottom) / 2;
      if ((o.top + o.bottom) / 2 < mid) visTop = Math.max(visTop, o.bottom);
      else visBottom = Math.min(visBottom, o.top);
      if (o.left < right && o.right > left && o.top < bottom && o.bottom > top) {
        covered = true;
      }
    }
    if (
      !covered &&
      left >= view.left &&
      right <= view.right &&
      top >= view.top &&
      bottom <= view.bottom
    ) {
      return;
    }
    // Panels taller than the room between them leave nothing to centre in.
    if (visBottom - visTop < (bottom - top) / 2) {
      visTop = view.top;
      visBottom = view.bottom;
    }
    const cx = view.left + view.width / 2 - surface.left;
    const cy = (visTop + visBottom) / 2 - surface.top;
    setView({
      k: v.k,
      x: cx - (n.x + NODE_W / 2) * v.k,
      y: cy - (n.y + NODE_H / 2) * v.k,
    });
  }, [spotlightId, visibleRect]);

  const detail: 0 | 1 | 2 = view.k >= DETAIL_ZOOM ? 2 : view.k >= MINIMAL_ZOOM ? 1 : 0;
  const glance = glanceScale(view.k, coarsePointer);
  const showEdgeLabels = view.k >= 1;

  /**
   * Injected failures in force, keyed by node id.
   *
   * `activeFailures` is an ARRAY on the snapshot, so looking a node up in it
   * directly would be O(n) per node per render. Indexing it once per snapshot
   * keeps NodeView's prop a plain string that memo can compare by identity.
   */
  const faultById = useMemo(() => {
    const m = new Map<string, FailureKind>();
    if (!snapshot) return m;
    for (const f of snapshot.activeFailures) m.set(f.nodeId, f.kind);
    return m;
  }, [snapshot]);

  /**
   * Which edges are CONTROL relationships rather than request paths.
   *
   * The rule is read from the behaviour registry rather than restated here,
   * so the canvas and the engine cannot drift apart about what a control edge
   * is. The engine's definition is exactly this OR: an explicit
   * `SimEdge.control` flag, or a source whose kind only ever supervises. The
   * OR is why no preset needed a flag added — an autoscaler's edge is control
   * because of what an autoscaler IS.
   *
   * Depends only on the topology, not the snapshot, so it survives every
   * frame of a running simulation without recomputing.
   */
  const controlEdges = useMemo(() => {
    const set = new Set<string>();
    for (const e of topology.edges) {
      if (e.control) {
        set.add(e.id);
        continue;
      }
      const src = nodeById.get(e.from);
      if (src && behaviourFor(src.kind).controlsTarget) set.add(e.id);
    }
    return set;
  }, [topology.edges, nodeById]);

  /**
   * Health per node, so an edge can be colored by the state of the node it
   * feeds. Computed once per snapshot rather than per edge.
   *
   * A faulted node is forced to `danger` here as well as inside NodeView, so
   * that the WIRES feeding a crashed node also read as failing. Without this
   * a crashed node (which serves nothing, so reports 0% utilisation) would sit
   * at the end of a set of perfectly healthy-looking edges.
   */
  /**
   * Backlog feeding each pull-based consumer (worker, transcoder), whose own
   * queue cell is structurally always zero. See sourceBacklogs().
   */
  const backlogById = useMemo(
    () => (snapshot ? sourceBacklogs(topology, snapshot.nodes) : null),
    [snapshot, topology],
  );

  /** Client routes by client id, once per snapshot. */
  const routeById = useMemo(() => {
    const m = new Map<string, RouteStats>();
    for (const r of routes ?? []) m.set(r.clientId, r);
    return m;
  }, [routes]);

  const readoutHealthById = useMemo(() => {
    const m = new Map<string, Health>();
    if (!snapshot) return m;
    for (const n of topology.nodes) {
      const s = snapshot.nodes[n.id];
      if (s) {
        m.set(
          n.id,
          readoutFor(
            n.kind,
            s,
            n.config,
            backlogById?.get(n.id) ?? 0,
            routeById.get(n.id) ?? null,
          ).health,
        );
      }
    }
    return m;
  }, [snapshot, topology.nodes, backlogById, routeById]);

  /* Settled so a node on a threshold does not flicker (see settledHealth.ts).
     The fault overlay goes on after settling: a crash shows at once, and a
     repair hands straight back to the health that was tracked all along. */
  const settledHealthById = useSettledHealthMap(
    readoutHealthById,
    snapshot?.system.timeMs ?? null,
  );

  const healthById = useMemo(() => {
    if (faultById.size === 0) return settledHealthById;
    const m = new Map(settledHealthById);
    for (const id of faultById.keys()) m.set(id, 'danger');
    return m;
  }, [settledHealthById, faultById]);

  /**
   * Lane assignment for bidirectional pairs, keyed by edge id.
   *
   * When A -> B and B -> A both exist the router would give them the same
   * corridor and the two wires would fuse into one line with two invisible
   * arrowheads. Each member of such a pair gets a lane (-1 or +1, decided by
   * id order so it is stable across renders) and the router shifts the whole
   * wire LANE_OFFSET perpendicular to its axis. Lone edges stay in lane 0.
   */
  const laneById = useMemo(() => {
    const m = new Map<string, number>();
    const key = (f: string, t: string) => `${f}->${t}`;
    const present = new Set(topology.edges.map((e) => key(e.from, e.to)));
    for (const e of topology.edges) {
      if (present.has(key(e.to, e.from))) {
        m.set(e.id, e.from < e.to ? -1 : 1);
      }
    }
    return m;
  }, [topology.edges]);

  /**
   * De-conflicted vertical offsets for edge rate labels, keyed by edge id.
   *
   * Every label anchors at its edge's own midpoint, and two edges can share
   * one: a fan-out to two targets vertically symmetric around the source row
   * puts both midpoints at the identical pixel (measured: three coincident
   * pairs in one 34-node topology, rendering as "3k/3k/s" garble). Anchors
   * are bucketed to a 16px grid and the nth label landing in an occupied
   * bucket is pushed 10px further down. Only edges that will actually render
   * a label participate, so an idle edge never displaces a live one.
   */
  const labelDyById = useMemo(() => {
    const m = new Map<string, number>();
    if (!showEdgeLabels) return m;
    const buckets = new Map<string, number>();
    for (const ed of topology.edges) {
      const a = nodeById.get(ed.from);
      const b = nodeById.get(ed.to);
      if (!a || !b) continue;
      const control = controlEdges.has(ed.id);
      const flow = snapshot?.edgeFlow[ed.id] ?? 0;
      const state = snapshot?.edgeState[ed.id] ?? 'idle';
      const severed = state === 'cut' || state === 'blocked';
      // Mirror of EdgeView's own "does a label render" condition.
      const hasLabel = control || (!severed && flow > 0.05);
      if (!hasLabel) continue;
      // The same route EdgeView draws, so the bucketed anchor is the exact
      // point the label will render at.
      const { label } = routeEdge(nodeRect(a), nodeRect(b), laneById.get(ed.id) ?? 0);
      const key = `${Math.round(label.x / 16)}:${Math.round(label.y / 16)}`;
      const n = buckets.get(key) ?? 0;
      buckets.set(key, n + 1);
      if (n > 0) m.set(ed.id, n * 10);
    }
    return m;
  }, [showEdgeLabels, topology.edges, nodeById, controlEdges, snapshot, laneById]);

  /**
   * The link gesture currently in flight, from either mechanism. Drag and
   * click-to-link produce the same source id, so downstream rendering treats
   * them identically and the two modes cannot look different.
   */
  const linkFrom = link ? link.from : pendingLink;
  const previewFrom = linkFrom ? nodeById.get(linkFrom) : undefined;
  const previewPort = previewFrom ? outPort(previewFrom) : null;

  /**
   * Per-node role in the live link. Precomputed so NodeView receives a plain
   * string and stays memo-stable for every node not involved.
   */
  const linkRoles = useMemo(() => {
    const m = new Map<string, LinkRole>();
    if (!linkFrom) return m;
    for (const n of topology.nodes) {
      if (n.id === linkFrom) {
        m.set(n.id, 'source');
        continue;
      }
      const dup = topology.edges.some((e) => e.from === linkFrom && e.to === n.id);
      m.set(n.id, dup ? 'invalid' : 'valid');
    }
    return m;
  }, [linkFrom, topology.nodes, topology.edges]);

  /**
   * Ruled grid. 32px minor, 128px major — a ruled field reads as a workspace,
   * where the old 8px dot field read as an empty document (and painted tens of
   * thousands of dots of static across a wide canvas).
   */
  const minor = 32 * view.k;
  const major = 128 * view.k;
  const gridStyle: CSSProperties = {
    backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
    // Fade the grid out as the diagram shrinks past the point where rules help.
    // Keyed to the DETAIL threshold, not to the fit floor: the grid should
    // thin out at the same zoom the nodes stop showing their numbers.
    opacity: view.k < MINIMAL_ZOOM ? 0 : view.k < DETAIL_ZOOM ? 0.5 : 1,
  };

  const elapsed = snapshot ? snapshot.system.timeMs / 1000 : 0;

  /** The node being renamed in place, or null. Deleting it (or loading a
   *  preset over it) unmounts the editor without committing, by lookup. */
  const renameNode = renaming ? (nodeById.get(renaming) ?? null) : null;

  /** The annotation each in-place editor floats over, or null. Deleting it
   *  (or loading a preset over it) unmounts the editor without committing,
   *  by the same lookup rule the rename editor uses. */
  const editNoteRaw = noteEdit
    ? (annotations.find((a) => a.id === noteEdit.id) ?? null)
    : null;
  const editNote = editNoteRaw && isNote(editNoteRaw) ? editNoteRaw : null;
  const editSectionRaw = labelEdit
    ? (annotations.find((a) => a.id === labelEdit.id) ?? null)
    : null;
  const editSection =
    editSectionRaw && isSection(editSectionRaw) ? editSectionRaw : null;

  /** Snapped drop target of the live drag-link, if the drop would be legal. */
  const snapTarget =
    link && link.over && canLink(link.from, link.over) ? link.over : null;

  /**
   * Loose end of the preview wire.
   *
   * While DRAGGING it follows the pointer, and jumps to the target's input
   * port once a legal target is under it — the visual promise that releasing
   * now connects these two.
   *
   * While ARMED by a click there is no pointer to follow, so the wire is a
   * short stub leaving the source port. Without it, clicking a port produced
   * a text hint and no mark on the diagram at all, which left the source of
   * the pending connection completely unidentified.
   */
  const ARMED_STUB = 56;
  let previewD: string | null = null;
  if (previewFrom) {
    const snapNode = snapTarget ? nodeById.get(snapTarget) : undefined;
    if (link && snapNode) {
      // Snapped: show the wire exactly where the real edge will route,
      // extended to the arrow tip since the preview draws no head.
      const r = routeEdge(nodeRect(previewFrom), nodeRect(snapNode));
      previewD = `${r.d} L${r.tip.x},${r.tip.y}`;
    } else if (link) {
      previewD = previewPath(nodeRect(previewFrom), link.x, link.y);
    } else {
      // Armed by a click: a short stub out of the source port.
      previewD = previewPath(
        nodeRect(previewFrom),
        previewPort!.x + ARMED_STUB,
        previewPort!.y,
      );
    }
  }

  return (
    <div
      ref={hostRef}
      className={`cv-host${dropHint ? ' is-dropping' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/*
        The interaction surface. Everything the pointer router cares about
        lives inside it; every overlay control is a sibling BELOW it in this
        tree. That separation is what makes the zoom buttons clickable, and it
        is structural rather than a conditional inside a handler.
      */}
      <div
        ref={surfaceRef}
        className="cv-surface"
        data-cursor={tool ? 'crosshair' : cursor}
        onPointerDown={onSurfaceDown}
        onPointerMove={onSurfaceMove}
        onPointerUp={onSurfaceUp}
        onPointerCancel={onSurfaceCancel}
        onPointerLeave={() => {
          // Paste-at-pointer must not aim at a position the pointer left.
          lastClientRef.current = null;
        }}
        onDoubleClick={onSurfaceDoubleClick}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="cv-grid" style={gridStyle} aria-hidden="true" />

        <svg className="cv-svg">
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* Sections FIRST: a frame paints behind every wire and node it
                groups. Its interior is pointer-transparent (see the
                annotation layer comment), so nothing here can steal a click
                from the diagram above it. */}
            {annotations.length > 0 && (
              <g className="cv-sections">
                {annotations.filter(isSection).map((s) => (
                  <SectionView
                    key={s.id}
                    section={s}
                    selected={selectedIds.has(s.id)}
                    editingLabel={labelEdit?.id === s.id}
                    dropTarget={dropSection === s.id}
                    metricsEpoch={metricsEpoch}
                  />
                ))}
              </g>
            )}

            <g className="cv-edges">
              {topology.edges.map((ed) => {
                const a = nodeById.get(ed.from);
                const b = nodeById.get(ed.to);
                if (!a || !b) return null;
                return (
                  <EdgeView
                    key={ed.id}
                    edge={ed}
                    ax={a.x}
                    ay={a.y}
                    bx={b.x}
                    by={b.y}
                    lane={laneById.get(ed.id) ?? 0}
                    flow={snapshot?.edgeFlow[ed.id] ?? 0}
                    state={snapshot?.edgeState[ed.id] ?? 'idle'}
                    control={controlEdges.has(ed.id)}
                    selected={selectedIds.has(ed.id)}
                    targetHealth={healthById.get(ed.to) ?? 'ok'}
                    showLabel={showEdgeLabels}
                    labelDy={labelDyById.get(ed.id) ?? 0}
                    breakMark={breakMarks?.get(ed.id)}
                  />
                );
              })}
            </g>

            {previewD && (
              <path
                className={`cv-link-preview${snapTarget ? ' is-snapped' : ''}`}
                d={previewD}
              />
            )}

            <g className="cv-nodes">
              {topology.nodes.map((n) => (
                <NodeView
                  key={n.id}
                  node={n}
                  stats={snapshot?.nodes[n.id] ?? null}
                  spark={spark?.get(n.id)}
                  selected={selectedIds.has(n.id)}
                  detail={detail}
                  linkRole={linkRoles.get(n.id) ?? 'none'}
                  linking={linkFrom !== null}
                  linkTarget={snapTarget === n.id}
                  fault={faultById.get(n.id) ?? null}
                  backlog={backlogById?.get(n.id) ?? 0}
                  route={routeById.get(n.id) ?? null}
                  settledHealth={settledHealthById.get(n.id)}
                  glance={glance}
                  onActivate={onActivate}
                  onNudge={onNudge}
                  entering={enteredIdRef.current === n.id}
                  breakMark={breakMarks?.get(n.id)}
                />
              ))}
            </g>

            {spotNode && (
              <g className="cv-spotlight" aria-hidden="true">
                <rect
                  className="cv-spotlight-ring"
                  x={spotNode.x - SPOT_PAD}
                  y={spotNode.y - SPOT_PAD}
                  width={NODE_W + SPOT_PAD * 2}
                  height={NODE_H + SPOT_PAD * 2}
                  rx={NODE_R + SPOT_PAD}
                />
                <g
                  transform={`translate(${spotNode.x - SPOT_PAD} ${spotNode.y - SPOT_PAD - SPOT_TAG_H - 4})`}
                >
                  <rect
                    className="cv-spotlight-tag"
                    width={SPOT_TAG_W}
                    height={SPOT_TAG_H}
                    rx={NODE_R}
                  />
                  <text
                    className="cv-spotlight-label"
                    x={SPOT_TAG_W / 2}
                    y={SPOT_TAG_H / 2}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    Here
                  </text>
                </g>
              </g>
            )}

            {/* Notes LAST among content: commentary is never hidden by the
                diagram it comments on. */}
            {annotations.length > 0 && (
              <g className="cv-notes">
                {annotations.filter(isNote).map((n) => (
                  <NoteView
                    key={n.id}
                    note={n}
                    selected={selectedIds.has(n.id)}
                    editing={noteEdit?.id === n.id}
                    metricsEpoch={metricsEpoch}
                  />
                ))}
              </g>
            )}

            {/* Selection chrome for annotations, in its own TOP layer so a
                section's resize handles are never buried under a node that
                happens to sit on the border. */}
            {annotations.length > 0 && (
              <g className="cv-ann-chrome">
                {annotations
                  .filter((a) => selectedIds.has(a.id))
                  .map((a) =>
                    isSection(a) ? (
                      <SectionChrome
                        key={a.id}
                        section={a}
                        ui={1 / view.k}
                        // Flip when the row would land outside the UNCOVERED
                        // area. visibleRect already knows where the floating
                        // panels are, so a section near the bottom does not
                        // hide its own picker under the charts strip.
                        flipTones={toneRowWouldClip(a)}
                      />
                    ) : (
                      <NoteChrome
                        key={a.id}
                        note={a}
                        ui={1 / view.k}
                        metricsEpoch={metricsEpoch}
                      />
                    ),
                  )}
              </g>
            )}

            {/* Excalidraw's renderTextBox: the one piece of chrome a text
                being edited gets, a dashed hairline at a small screen-constant
                padding around the box the draft wraps in. Sized from the
                DRAFT, so it grows with the typing. */}
            {editNote && noteEdit && (
              <NoteTextBox note={editNote} draft={noteEdit.draft} />
            )}

            {/* Live section-draw preview. */}
            {draft && (
              <rect
                className="cv-section-draft"
                x={draft.x}
                y={draft.y}
                width={draft.w}
                height={draft.h}
                rx={8}
              />
            )}

            {marquee && (
              <rect
                className="cv-marquee"
                x={marquee.x}
                y={marquee.y}
                width={marquee.w}
                height={marquee.h}
              />
            )}
          </g>
        </svg>
      </div>

      {/*
        The in-place rename editor. A sibling of the surface, like all other
        chrome, so the pointer router cannot see it; positioned over the
        node's header row by the same world-to-screen transform the canvas
        applies, so it sits on the name it replaces at any pan or zoom. The
        font scales with the zoom for the same reason.
      */}
      {renameNode && (
        <input
          className="cv-rename"
          data-chrome="rename"
          style={{
            left: renameNode.x * view.k + view.x,
            top: renameNode.y * view.k + view.y,
            width: NODE_W * view.k,
            height: HEAD_H * view.k,
            fontSize: Math.max(11, 14 * view.k),
          }}
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            // The window-level shortcut handlers already ignore text fields;
            // stopping propagation is belt and braces on top of that.
            e.stopPropagation();
            // An IME candidate window takes Enter and Escape to choose a
            // character, so acting on them ends the rename mid-word.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelRename();
            }
          }}
          aria-label="Component name"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      )}

      {/*
        Where the note editor's textarea is appended (Excalidraw's
        .excalidraw-textEditorContainer). A sibling of the surface, so the
        pointer router never sees it; empty until an edit starts.
      */}
      <div
        ref={editorHostRef}
        className="cv-text-editor-container"
        data-chrome="note-edit"
      />

      {/* In-place section label editor: the rename editor's contract. */}
      {editSection && labelEdit && (
        <input
          className="cv-label-editor"
          data-chrome="label-edit"
          style={{
            left: editSection.x * view.k + view.x,
            top: editSection.y * view.k + view.y,
            width: Math.min(240, editSection.width) * view.k,
            height: SEC_LABEL_H * view.k,
            fontSize: Math.max(11, 12 * view.k),
          }}
          value={labelEdit.draft}
          onChange={(e) =>
            setLabelEdit((cur) =>
              cur ? { ...cur, draft: e.target.value.slice(0, 200) } : cur,
            )
          }
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitLabelEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            // An IME candidate window takes Enter and Escape to choose a
            // character. Acting on them here ends the edit mid-word.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commitLabelEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              // A label is one line typed in one go, so Escape reverts here
              // where it commits for a note: there is nothing to lose but
              // the word in progress, and abandoning a rename is the common
              // intent. Enter is the commit.
              cancelLabelEdit();
            }
          }}
          aria-label="Section label"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      )}

      {topology.nodes.length === 0 && <EmptyCanvas actions={emptyActions} />}

      {/* Status ledger. A corner carrying a true number stops reading as
          dead space. */}
      {topology.nodes.length > 0 && (
        /* Zoom is deliberately NOT here: the zoom control sits a few pixels
           away and already states it, and a fact printed twice on one
           surface reads as an oversight. */
        <div className="cv-ledger label" aria-hidden="true">
          <span>
            {topology.nodes.length}{' '}
            {topology.nodes.length === 1 ? 'component' : 'components'}
          </span>
          {/* The breakdown elaborates the total above it, so it sits next to
              it rather than at the end. Commas inside one span, not the flex
              gap: the gap separates FACTS, and split across spans "4 traffic
              7 compute" would read as two more of them. A comma inherits
              --text-faint from the text around it, so it carries none of the
              contrast problem the old "·" separator did. */}
          <span className="cv-ledger-groups">{nodeGroupSummary}</span>
          <span>
            {topology.edges.length}{' '}
            {topology.edges.length === 1 ? 'connection' : 'connections'}
          </span>
          {/* Kept out of the ledger's uppercase transform: "1.5s" must not
              render as "1.5S" — units always print lowercase. */}
          <span className="cv-ledger-time">{formatElapsed(elapsed)}</span>
        </div>
      )}

      {/* Live instruction while a click-to-link is armed. A student who
          clicked a port has no other way to learn what happens next. */}
      {pendingLink !== null && (
        <p className="cv-hint" role="status">
          {coarsePointer
            ? 'Tap a component to connect'
            : 'Click a component to connect · Esc to cancel'}
        </p>
      )}

      {/* The armed annotation tool teaches its one gesture, exactly the way
          the armed link does. */}
      {tool !== null && pendingLink === null && (
        <p className="cv-hint" role="status">
          {tool === 'note'
            ? coarsePointer
              ? 'Tap the canvas to place a note'
              : 'Click the canvas to place a note · Esc to cancel'
            : coarsePointer
              ? 'Drag to draw a section'
              : 'Drag to draw a section · Esc to cancel'}
        </p>
      )}

      {/* A one-line contextual hint, the cheapest thing Excalidraw does that
          this app lacked: at rest it teaches the camera, with a node selected
          it teaches the node verbs. Quiet, static, never animated, and it
          yields its slot to the armed-link instruction above. Separated by
          GAP rather than a "·" glyph, which measured 2.12:1 on the canvas
          (see .cv-ledger). aria-hidden: it repeats what titles and the
          shortcuts dialog already expose to assistive tech, and its churn on
          selection would be noise there. */}
      {pendingLink === null &&
        tool === null &&
        topology.nodes.length > 0 &&
        !renameNode && (
          <div className="cv-hint-idle label" aria-hidden="true">
            {topology.nodes.some((n) => selectedIds.has(n.id)) ? (
              <>
                <span>Drag to move</span>
                <span>Delete to remove</span>
                <span>Double-click to rename</span>
              </>
            ) : (
              <>
                <span>Scroll to pan</span>
                <span>Ctrl+scroll to zoom</span>
                <span>Shift+drag to select</span>
              </>
            )}
          </div>
        )}

      {/*
        The note format bar. Chrome pinned to the bottom of the canvas, not
        drawn beside the note it edits: a toolbar anchored to a note is wider
        than a default note, so it clipped against the right edge of the
        viewport, and it slid under the reader's hand on every pan. A fixed
        position can do neither, which is why every editor with a rich text
        object puts one here.

        Only for a single selected note. With two selected, a control that
        showed one note's state would be lying about the other.
      */}
      {formatNote && (
        <div className="cv-format" data-chrome="format">
          <div className="cv-format-group" role="group" aria-label="Text size">
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <button
                key={size}
                type="button"
                className={`btn btn-ghost cv-format-btn${
                  formatNote.size === size ? ' is-active' : ''
                }`}
                aria-pressed={formatNote.size === size}
                title={`Size ${size}`}
                onClick={() => onSetNoteSize?.(formatNote.id, size)}
              >
                {size === 'sm' ? 'S' : size === 'md' ? 'M' : 'L'}
              </button>
            ))}
            <button
              type="button"
              className={`btn btn-ghost cv-format-btn cv-format-bold${
                formatNote.bold ? ' is-active' : ''
              }`}
              aria-pressed={formatNote.bold === true}
              title="Bold"
              onClick={() => onSetNoteStyle?.(formatNote.id, { bold: 'toggle' })}
            >
              B
            </button>
            <button
              type="button"
              className={`btn btn-ghost cv-format-btn cv-format-italic${
                formatNote.italic ? ' is-active' : ''
              }`}
              aria-pressed={formatNote.italic === true}
              title="Italic"
              onClick={() => onSetNoteStyle?.(formatNote.id, { italic: 'toggle' })}
            >
              I
            </button>
            <button
              type="button"
              className={`btn btn-ghost cv-format-btn cv-format-underline${
                formatNote.underline ? ' is-active' : ''
              }`}
              aria-pressed={formatNote.underline === true}
              title="Underline"
              onClick={() => onSetNoteStyle?.(formatNote.id, { underline: 'toggle' })}
            >
              U
            </button>
          </div>

          <div className="cv-format-group" role="group" aria-label="Typeface">
            {ANNOTATION_FONTS.map((f) => (
              <button
                key={f}
                type="button"
                className={`btn btn-ghost cv-format-btn${
                  (formatNote.font ?? 'sans') === f ? ' is-active' : ''
                }`}
                data-font-name={f}
                aria-pressed={(formatNote.font ?? 'sans') === f}
                title={FONT_LABEL[f]}
                onClick={() => onSetNoteStyle?.(formatNote.id, { font: f })}
              >
                Aa
              </button>
            ))}
          </div>

          <div className="cv-format-group" role="group" aria-label="Text colour">
            {Array.from({ length: SECTION_TONE_COUNT }, (_, i) => (
              <button
                key={i}
                type="button"
                className={`cv-format-tone${formatNote.tone === i ? ' is-active' : ''}`}
                data-tone={i}
                aria-pressed={formatNote.tone === i}
                aria-label={`Colour ${i + 1}`}
                onClick={() => onSetNoteStyle?.(formatNote.id, { tone: i })}
              />
            ))}
            <button
              type="button"
              className={`cv-format-tone cv-format-tone-none${
                formatNote.tone === undefined ? ' is-active' : ''
              }`}
              aria-pressed={formatNote.tone === undefined}
              aria-label="Default colour"
              title="Follow the text colour"
              onClick={() => onSetNoteStyle?.(formatNote.id, { tone: null })}
            />
          </div>
        </div>
      )}

      {showMinimap && (
        <Minimap
          nodes={topology.nodes}
          view={view}
          surface={surfaceSize}
          onGoTo={(wx, wy) => {
            // Centre the VISIBLE area on the point, not the whole surface:
            // with a rail open, centring the surface parks the target under
            // the panel the reader is looking past.
            const rects = visibleRect();
            if (!rects) return;
            const { surface, view: vis } = rects;
            setView((v) => ({
              ...v,
              x: vis.left - surface.left + vis.width / 2 - wx * v.k,
              y: vis.top - surface.top + vis.height / 2 - wy * v.k,
            }));
          }}
        />
      )}

      <EdgeCues
        hostRef={hostRef}
        visibleRef={visibleRef}
        visibleRect={visibleRect}
        view={view}
        nodes={topology.nodes}
        nodeW={NODE_W}
        nodeH={NODE_H}
        setView={setView}
        onFit={fitToContent}
      />

      <div className="cv-zoom" data-chrome="zoom">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          aria-label="Zoom out"
          title="Zoom out (Ctrl+-)"
        >
          &minus;
        </button>
        <button
          type="button"
          className="btn btn-ghost cv-zoom-level"
          onClick={fitToContent}
          // Still fits, because someone who learned to click the number
          // should keep being right. The icon beside it is what makes the
          // action findable in the first place.
          aria-label={`Zoom ${Math.round(view.k * 100)} percent. Fit the diagram on screen`}
          title="Fit the diagram on screen (Shift+1)"
        >
          {Math.round(view.k * 100)}%
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => zoomBy(ZOOM_STEP)}
          aria-label="Zoom in"
          title="Zoom in (Ctrl+=)"
        >
          +
        </button>

        {/*
          Fit the whole diagram back on screen.

          The percentage beside it has always done this, but a number does
          not look like a button, so somebody who had panned into empty space
          had no visible way back and the honest answer was a keyboard
          shortcut they had not been told about. A labelled icon costs one
          slot and removes the only way to get properly lost.
        */}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={fitToContent}
          aria-label="Fit the diagram on screen"
          title="Fit the diagram on screen (Shift+1)"
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
            <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
