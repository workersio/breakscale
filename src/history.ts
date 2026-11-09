import { DEFAULT_SEED, sanitizeSeed } from './sim/seed';
import type { FaultEvent, Topology } from './sim/types';
import type { FaultChange, FaultDirection } from './components/faultUndo';

/* ------------------------------------------------------------------ *
 * Undo / redo for the shell.
 *
 * FULL SNAPSHOTS, NOT DELTAS. The topology is a few dozen plain-data nodes,
 * so a complete copy of `{ topology, selectedIds, rps, presetId, challengeId }`
 * per entry is a few kilobytes. Excalidraw's delta machinery exists for multiplayer
 * reconciliation, which this app does not have; snapshots are the version
 * that is obviously correct.
 *
 * The semantics worth copying from Excalidraw's rebuilt history:
 *
 *   1. ONE ENTRY PER GESTURE. A drag commits at pointerup, a streamed edit
 *      (slider frames, rename keystrokes, arrow nudges) commits once it
 *      settles, never once per frame.
 *   2. SELECTION TRAVELS WITH HISTORY, but a selection-only change never
 *      clears the redo stack. Selection changes simply do not touch this
 *      class; each committed entry captures the selection as of commit time,
 *      so undo restores it for free.
 *   3. NO-OP ENTRIES ARE SKIPPED. If applying an entry would change nothing
 *      visible, undo/redo keeps popping rather than burning a keypress.
 *   4. canUndo / canRedo ARE DERIVED from the stacks on every read, never
 *      cached as separate booleans that can go stale.
 * ------------------------------------------------------------------ */

/** Everything a single history entry restores. */
export interface HistorySnapshot {
  topology: Topology;
  selectedIds: ReadonlySet<string>;
  rps: number;
  presetId: string | null;
  /**
   * The challenge the canvas belonged to, or null for the reader's own
   * design. A brief is a different workspace, so undoing past the moment one
   * started is leaving it, and redoing is going back in.
   */
  challengeId: string | null;
}

/**
 * A snapshot plus the name of the edit that produced it, for the toast
 * ("Undid move"). The snapshot is the state BEFORE that edit.
 */
export interface HistoryEntry extends HistorySnapshot {
  label: string;
  /**
   * The edit put a whole design on the canvas (an example, a file, a run to
   * watch), so its fault schedule and seed are part of what undo restores.
   * Any other edit leaves them to the run: faults recorded while it plays
   * only ever append, and undoing a knob change must not roll them back.
   */
  replaces?: boolean;
  /**
   * Set on an entry made by a fault control. The snapshot then only carries
   * the selection back; the design did not change, and what undo does is
   * put the node or cable back, through `FaultApplier`.
   */
  fault?: FaultChange;
}

/**
 * Applies a fault entry to the engine and returns it as it goes on the other
 * stack, or null when it would change nothing, so the entry is skipped like
 * a design entry equal to the screen.
 */
export type FaultApplier = (
  entry: HistoryEntry & { fault: FaultChange },
  dir: FaultDirection,
) => FaultChange | null;

/**
 * Stack bound. 50 entries of a ~30-node topology is on the order of 500KB
 * worst case, which is nothing, and 50 deliberate edits is far more than a
 * student ever walks back one keypress at a time. The bound exists so an
 * hours-long session cannot grow memory without limit, not because entries
 * are expensive.
 */
export const HISTORY_LIMIT = 50;

/**
 * How long a streamed edit must go quiet before it commits, in ms. Slider
 * input events arrive every frame (16ms) and key-repeat nudges every ~35ms,
 * so anything above ~100ms coalesces a gesture; 500ms also absorbs the
 * natural jitter of a student wiggling a slider to a value, while staying
 * short enough that two deliberate consecutive edits become two entries.
 */
export const SETTLE_MS = 500;

/* ---------------- equality ---------------- */

/**
 * Structural equality, written out field by field rather than via
 * JSON.stringify so optional fields present-as-undefined and key order can
 * never produce a false difference.
 */
function configEqual(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of Object.keys(ra)) if (ra[k] !== rb[k]) return false;
  for (const k of Object.keys(rb)) if (!(k in ra)) return false;
  return true;
}

/**
 * Annotations are flat plain-data objects, so per-entry field comparison via
 * configEqual is exact. Absent and empty are the same diagram: a topology
 * that never had the optional field must not differ from one holding [].
 */
function annotationsEqual(
  a: Topology['annotations'],
  b: Topology['annotations'],
): boolean {
  const xs = a ?? [];
  const ys = b ?? [];
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) {
    if (!configEqual(xs[i]!, ys[i]!)) return false;
  }
  return true;
}

function topologyEqual(a: Topology, b: Topology): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  if (a.edges.length !== b.edges.length) return false;
  if (!annotationsEqual(a.annotations, b.annotations)) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const m = a.nodes[i]!;
    const n = b.nodes[i]!;
    if (
      m.id !== n.id ||
      m.kind !== n.kind ||
      m.label !== n.label ||
      m.x !== n.x ||
      m.y !== n.y ||
      !configEqual(m.config, n.config)
    ) {
      return false;
    }
  }
  return edgesEqual(a, b);
}

/**
 * Same schedule, event by event. Absent and empty are the same schedule,
 * the way they are the same run.
 */
function faultsEqual(
  a: FaultEvent[] | undefined,
  b: FaultEvent[] | undefined,
): boolean {
  const xs = a ?? [];
  const ys = b ?? [];
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) {
    const { opts: p, ...x } = xs[i] as FaultEvent & { opts?: object };
    const { opts: q, ...y } = ys[i] as FaultEvent & { opts?: object };
    if (!configEqual(x, y) || !configEqual(p ?? {}, q ?? {})) return false;
  }
  return true;
}

/** The run a design plays: its seed, the default when it has none, and its faults. */
function runEqual(a: Topology, b: Topology): boolean {
  return (
    (sanitizeSeed(a.seed) ?? DEFAULT_SEED) === (sanitizeSeed(b.seed) ?? DEFAULT_SEED) &&
    faultsEqual(a.faults, b.faults)
  );
}

function edgesEqual(a: Topology, b: Topology): boolean {
  if (a.edges.length !== b.edges.length) return false;
  for (let i = 0; i < a.edges.length; i++) {
    const d = a.edges[i]!;
    const e = b.edges[i]!;
    if (
      d.id !== e.id ||
      d.from !== e.from ||
      d.to !== e.to ||
      d.weight !== e.weight ||
      d.control !== e.control ||
      d.lossRate !== e.lossRate
    ) {
      return false;
    }
  }
  return true;
}

function selectionEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Whether applying `entry` would leave `current` as it is. The run only
 * counts for an entry that replaced the design, because only that kind
 * puts its own schedule and seed back (see HistoryEntry.replaces).
 */
function snapshotEqual(entry: HistoryEntry, current: HistorySnapshot): boolean {
  return (
    entry.rps === current.rps &&
    entry.presetId === current.presetId &&
    entry.challengeId === current.challengeId &&
    selectionEqual(entry.selectedIds, current.selectedIds) &&
    topologyEqual(entry.topology, current.topology) &&
    (!entry.replaces || runEqual(entry.topology, current.topology))
  );
}

/**
 * Deep copy on the way IN. Entries must be immune to later mutation of
 * whatever they were captured from; App state is updated immutably today,
 * but history must not depend on every future caller remembering that.
 */
function cloneSnapshot(s: HistorySnapshot): HistorySnapshot {
  return {
    topology: structuredClone(s.topology),
    selectedIds: new Set(s.selectedIds),
    rps: s.rps,
    presetId: s.presetId,
    challengeId: s.challengeId,
  };
}

/* ---------------- the stack ---------------- */

export class SessionHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];

  /** Baseline captured at drag promotion, committed at gesture end. */
  private gestureBase: HistoryEntry | null = null;

  /** Baseline of a streamed edit, committed once the stream settles. */
  private pending: HistoryEntry | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Notified after any stack change, so a UI can re-derive its buttons.
   * `edited` is false when nothing moved: an Undo or Redo pressed with
   * nothing left to apply. That press is not the reader changing anything,
   * and treating it as one let an empty Undo on a freshly opened share link
   * switch autosave back on and write the shared design over their own.
   * A fault entry is false too: crashing a box is not editing the design.
   */
  private readonly onChange: ((edited: boolean) => void) | undefined;
  private readonly limit: number;
  private readonly settleMs: number;

  constructor(opts?: {
    onChange?: (edited: boolean) => void;
    limit?: number;
    settleMs?: number;
  }) {
    this.onChange = opts?.onChange;
    this.limit = opts?.limit ?? HISTORY_LIMIT;
    this.settleMs = opts?.settleMs ?? SETTLE_MS;
  }

  /** Derived from the stack on every read; a pending edit is undoable too. */
  get canUndo(): boolean {
    return this.past.length > 0 || this.pending !== null;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** True between beginGesture and endGesture, so per-frame moves know to
   *  stay out of the debounced path. */
  get inGesture(): boolean {
    return this.gestureBase !== null;
  }

  /** Test/introspection accessors; the stacks themselves stay private. */
  get undoDepth(): number {
    return this.past.length;
  }

  get redoDepth(): number {
    return this.future.length;
  }

  /** Oldest surviving entry's label, for asserting the bound drops from the
   *  bottom. */
  get oldestLabel(): string | null {
    return this.past[0]?.label ?? null;
  }

  private pushPast(entry: HistoryEntry): void {
    this.past.push(entry);
    // Bounded from the bottom: the oldest edit falls off, never the newest.
    if (this.past.length > this.limit)
      this.past.splice(0, this.past.length - this.limit);
  }

  private notify(edited = true): void {
    this.onChange?.(edited);
  }

  /**
   * A discrete edit is about to happen (add, connect, delete, preset load).
   * `before` is the state as it stands RIGHT NOW, pre-edit. Clears redo:
   * a real edit forks the timeline.
   */
  commit(label: string, before: HistorySnapshot, replaces = false): void {
    // An unsettled streamed edit happened first chronologically; land it
    // before this entry so undo unwinds in the order things were done.
    this.flushSettling();
    this.pushPast({
      label,
      ...cloneSnapshot(before),
      ...(replaces ? { replaces } : {}),
    });
    this.future = [];
    this.notify();
  }

  /**
   * A fault control was pressed. Unlike `commit`, this is not an edit to the
   * design, so a design opened from a share link stays someone else's.
   */
  commitFault(label: string, current: HistorySnapshot, fault: FaultChange): void {
    this.flushSettling();
    this.pushPast({ label, fault, ...cloneSnapshot(current) });
    this.future = [];
    this.notify(false);
  }

  /**
   * One frame of a streamed edit (slider drag, rename keystroke, arrow
   * nudge). The FIRST frame captures the pre-edit baseline and clears redo,
   * because the state has genuinely diverged; every further frame only
   * pushes the settle timer back. The entry lands after `settleMs` of quiet.
   *
   * Commit-on-settle was chosen over commit-on-release because half the
   * streamed paths have no release event to hook: a number spinner held
   * down, key-repeat on an arrow nudge, or the top-bar slider being driven
   * by keyboard. The debounce covers all of them with one mechanism, at the
   * cost of a fixed 500ms before the entry exists, which undo itself hides
   * by flushing the pending entry first.
   */
  touch(label: string, before: HistorySnapshot): void {
    // A different KIND of streamed edit starts a new entry: a rename
    // followed within the settle window by a slider drag is two edits, and
    // coalescing them would make one Ctrl+Z revert both.
    if (this.pending && this.pending.label !== label) this.flushSettling();
    if (!this.pending) {
      this.pending = { label, ...cloneSnapshot(before) };
      this.future = [];
      this.notify();
    }
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.flushSettling(), this.settleMs);
  }

  /** Land the pending streamed edit now, if there is one. */
  flushSettling(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (!this.pending) return;
    const entry = this.pending;
    this.pending = null;
    this.pushPast(entry);
    this.notify();
  }

  /**
   * A pointer gesture that will stream moves is starting. Captures the
   * baseline once; the per-frame moves then bypass history entirely.
   */
  beginGesture(label: string, before: HistorySnapshot): void {
    this.flushSettling();
    this.gestureBase = { label, ...cloneSnapshot(before) };
  }

  /**
   * The gesture ended (pointerup, pointercancel, or Escape). Commits the
   * baseline as ONE entry, unless the gesture went nowhere: a drag that
   * returned to its origin, or a press promoted past the threshold and
   * released in place, must not cost the student an undo step. The
   * comparison deliberately ignores selection: promotion selects the
   * grabbed node, and a selection-only change is not an entry.
   */
  endGesture(after: HistorySnapshot): void {
    const base = this.gestureBase;
    this.gestureBase = null;
    if (!base) return;
    if (
      topologyEqual(base.topology, after.topology) &&
      base.rps === after.rps &&
      base.presetId === after.presetId &&
      base.challengeId === after.challengeId
    ) {
      return;
    }
    this.pushPast(base);
    this.future = [];
    this.notify();
  }

  /**
   * Pop back one entry. `current` is the live state, which becomes the redo
   * entry. Entries indistinguishable from the current state are skipped, so
   * a press of Ctrl+Z always changes something visible or does nothing at
   * all (returning null).
   *
   * A fault entry is applied here, by `applyFault`, because only applying it
   * can tell whether it changes anything: the node may have healed on its
   * own since. Without an applier, fault entries are skipped.
   */
  undo(current: HistorySnapshot, applyFault?: FaultApplier): HistoryEntry | null {
    return this.step(
      this.past,
      (e) => this.future.push(e),
      current,
      'undo',
      applyFault,
    );
  }

  /** Pop forward one entry. Mirror of undo; does NOT clear the future. */
  redo(current: HistorySnapshot, applyFault?: FaultApplier): HistoryEntry | null {
    return this.step(this.future, (e) => this.pushPast(e), current, 'redo', applyFault);
  }

  private step(
    from: HistoryEntry[],
    onto: (entry: HistoryEntry) => void,
    current: HistorySnapshot,
    dir: FaultDirection,
    applyFault: FaultApplier | undefined,
  ): HistoryEntry | null {
    this.flushSettling();
    while (from.length > 0) {
      // The loop guard says the stack is not empty.
      const entry = from.pop()!;
      if (entry.fault) {
        const fault = applyFault?.({ ...entry, fault: entry.fault }, dir) ?? null;
        if (!fault) continue;
        onto({ label: entry.label, fault, ...cloneSnapshot(current) });
        this.notify(false);
        return entry;
      }
      if (snapshotEqual(entry, current)) continue;
      onto({
        label: entry.label,
        ...cloneSnapshot(current),
        ...(entry.replaces ? { replaces: true } : {}),
      });
      this.notify();
      return entry;
    }
    this.notify(false);
    return null;
  }
}

/* ---------------- engine synchronisation ---------------- */

/** The two mutation paths the engine offers, and nothing else. */
export interface EngineLike {
  setTopology(t: Topology): void;
  updateNodeConfig(id: string, patch: object): void;
}

/**
 * True when two topologies have the same graph structure: the same nodes
 * (id and kind, in order) and the same edges. Labels, positions and configs
 * may differ; none of those are structure.
 */
function sameStructure(a: Topology, b: Topology): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (a.nodes[i]!.id !== b.nodes[i]!.id) return false;
    if (a.nodes[i]!.kind !== b.nodes[i]!.kind) return false;
  }
  return edgesEqual(a, b);
}

/**
 * Bring the engine from `from` to `to` the same way a forward edit would.
 *
 * A config-only difference goes through updateNodeConfig, the live in-place
 * path, so undoing a knob change never rebuilds node state or disturbs the
 * metrics a student was watching. Anything structural goes through
 * setTopology, which itself preserves per-node state for surviving ids and
 * never resets the clock. NOTHING in here calls engine.reset(): an undo
 * that threw away the running simulation would be worse than no undo.
 */
export function syncEngine(engine: EngineLike, from: Topology, to: Topology): void {
  if (sameStructure(from, to)) {
    for (let i = 0; i < to.nodes.length; i++) {
      const prev = from.nodes[i]!;
      const next = to.nodes[i]!;
      if (!configEqual(prev.config, next.config)) {
        engine.updateNodeConfig(next.id, { ...next.config });
      }
    }
    return;
  }
  engine.setTopology(to);
}
