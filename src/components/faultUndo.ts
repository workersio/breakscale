import type { ActiveFailure, FailureKind, FailureOpts, FaultEvent } from '../sim/types';
import type { HistorySnapshot, SessionHistory } from '../history';
import type { FaultActions, FaultEngine } from './faultWiring';

/* ------------------------------------------------------------------ *
 * Fault controls as undo and redo entries.
 *
 * Simulated time only moves forward, so undoing a fault never rewrites the
 * past. It puts the node or cable back the way it was, now, through the same
 * record* calls a button press uses. The schedule then holds both entries,
 * the crash at 1.5s and the fix at the moment of the undo, which is exactly
 * what the charts showed, so a replay link made afterwards plays the same
 * run the student watched.
 *
 * The one exception is an entry that has not played yet: after Reset, a
 * crash recorded at 1.5s is still waiting at 0.8s. Undoing that takes the
 * entry out of the schedule, because it never happened and now never will.
 * ------------------------------------------------------------------ */

/** A node's fault as the controls set it, without the time it began. */
export interface NodeFault {
  kind: FailureKind;
  opts: FailureOpts;
}

/** What one fault control changed, and how to change it back. */
export type FaultChange =
  | {
      target: 'node';
      id: string;
      before: NodeFault | null;
      after: NodeFault | null;
      /** The schedule entry this change last wrote, or null once taken out. */
      made: FaultEvent | null;
    }
  | {
      target: 'edge';
      id: string;
      /** Cut with Cut cable. A node's partition is that node's fault. */
      before: boolean;
      after: boolean;
      made: FaultEvent | null;
    };

/** The engine calls undo and redo need, beyond the controls' own. */
export type FaultUndoEngine = FaultEngine & {
  activeFailures(): ActiveFailure[];
};

/** Which way an entry is being applied. */
export type FaultDirection = 'undo' | 'redo';

/** Toast words, read after "Undid" or "Redid". */
const INJECT_LABEL: Record<'crash' | 'crash-instance' | 'slow' | 'errors', string> = {
  crash: 'crash',
  'crash-instance': 'crash one instance',
  slow: 'slow down',
  errors: 'glitch',
};

function nodeFaultOf(f: ActiveFailure | undefined): NodeFault | null {
  if (!f) return null;
  const opts: FailureOpts = {};
  if (f.factor !== undefined) opts.factor = f.factor;
  if (f.rate !== undefined) opts.rate = f.rate;
  if (f.edgeIds !== undefined) opts.edgeIds = f.edgeIds.slice();
  return { kind: f.kind, opts };
}

function liveNode(engine: FaultUndoEngine, id: string): NodeFault | null {
  return nodeFaultOf(engine.activeFailures().find((f) => f.nodeId === id));
}

function liveEdge(engine: FaultUndoEngine, id: string): boolean {
  return engine.activeCuts().includes(id);
}

function sameNodeFault(a: NodeFault | null, b: NodeFault | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.opts.factor !== b.opts.factor || a.opts.rate !== b.opts.rate) return false;
  const xs = a.opts.edgeIds ?? [];
  const ys = b.opts.edgeIds ?? [];
  return xs.length === ys.length && xs.every((x, i) => x === ys[i]);
}

function sameEvent(a: FaultEvent, b: FaultEvent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The entry a record* call just wrote. It lands in the middle of the list,
 * after the entries already played, so it is found by comparing the two
 * lists rather than by taking the last one.
 */
function writtenEntry(before: FaultEvent[], after: FaultEvent[]): FaultEvent | null {
  if (after.length !== before.length + 1) return null;
  // Every index below is in bounds: i < before.length < after.length, and
  // after holds at least the one entry the length check just counted.
  for (let i = 0; i < before.length; i++) {
    if (!sameEvent(before[i]!, after[i]!)) return after[i]!;
  }
  return after[after.length - 1]!;
}

/** Where `made` sits in the schedule, searching from the end. */
function indexOfEvent(schedule: FaultEvent[], made: FaultEvent): number {
  for (let i = schedule.length - 1; i >= 0; i--) {
    // In bounds by the loop guard.
    if (sameEvent(schedule[i]!, made)) return i;
  }
  return -1;
}

/**
 * Bring a node or cable to `to` now, recorded. Returns the entry written, or
 * null when the engine took nothing: the node or edge is gone, or it is
 * already there.
 */
function recordState(
  engine: FaultUndoEngine,
  change: FaultChange,
  to: NodeFault | null | boolean,
): FaultEvent | null {
  const before = engine.faultSchedule();
  if (change.target === 'node') {
    const want = to as NodeFault | null;
    if (want === null) engine.recordClearFailure(change.id);
    else engine.recordFailure(change.id, want.kind, want.opts);
  } else if (to === true) {
    engine.recordCutEdge(change.id);
  } else {
    engine.recordRestoreEdge(change.id);
  }
  return writtenEntry(before, engine.faultSchedule());
}

/**
 * Apply one fault entry in one direction. Returns the entry as it should go
 * on the other stack, or null when applying it would change nothing, so the
 * history skips it the way it skips a design entry equal to the screen.
 *
 * `nowMs` is the engine's simulated time. `setSchedule` replaces the
 * engine's schedule without touching anything in force; the shell does that
 * through setTopology so its own copy of the list stays in step.
 */
export function applyFaultChange(
  engine: FaultUndoEngine,
  change: FaultChange,
  dir: FaultDirection,
  nowMs: number,
  setSchedule: (faults: FaultEvent[]) => void,
): FaultChange | null {
  const from = dir === 'undo' ? change.after : change.before;
  const to = dir === 'undo' ? change.before : change.after;
  const live =
    change.target === 'node'
      ? liveNode(engine, change.id)
      : liveEdge(engine, change.id);
  const atFrom =
    change.target === 'node'
      ? sameNodeFault(live as NodeFault | null, from as NodeFault | null)
      : live === from;
  const atTo =
    change.target === 'node'
      ? sameNodeFault(live as NodeFault | null, to as NodeFault | null)
      : live === to;

  // Not played yet: it is in the list, and either its time is still to come
  // or it is due this very millisecond and has not landed. Taking it out is
  // the whole undo; nothing on screen ever showed it.
  if (change.made) {
    const schedule = engine.faultSchedule();
    const at = indexOfEvent(schedule, change.made);
    const pending =
      at >= 0 &&
      (change.made.atMs > nowMs || (change.made.atMs === nowMs && !atFrom && atTo));
    if (pending) {
      schedule.splice(at, 1);
      setSchedule(schedule);
      return { ...change, made: null } as FaultChange;
    }
  }

  if (atTo) return null;
  const made = recordState(engine, change, to);
  if (!made) return null;
  return { ...change, made } as FaultChange;
}

/** Where a press lands as an undo entry. */
export interface FaultHistory {
  history: Pick<SessionHistory, 'commitFault'>;
  /** The state on screen, which the entry brings the selection back to. */
  before: HistorySnapshot;
}

/**
 * The fault controls, each press also committed as an undo entry. Forget is
 * passed through as it is: it empties the list that makes a run replayable,
 * which is a decision about sharing, not a fault.
 */
export function undoableFaultActions(
  engine: FaultUndoEngine,
  actions: FaultActions,
  to: FaultHistory,
): FaultActions {
  const onEntry = (label: string, change: FaultChange) =>
    to.history.commitFault(label, to.before, change);
  const node = (label: string, id: string, act: () => void) => {
    const before = liveNode(engine, id);
    const schedule = engine.faultSchedule();
    act();
    const made = writtenEntry(schedule, engine.faultSchedule());
    if (!made) return;
    onEntry(label, { target: 'node', id, before, after: liveNode(engine, id), made });
  };
  const edge = (label: string, id: string, act: () => void) => {
    const before = liveEdge(engine, id);
    const schedule = engine.faultSchedule();
    act();
    const made = writtenEntry(schedule, engine.faultSchedule());
    if (!made) return;
    onEntry(label, { target: 'edge', id, before, after: liveEdge(engine, id), made });
  };
  return {
    onInject: (id, kind, opts) =>
      node(INJECT_LABEL[kind], id, () => actions.onInject(id, kind, opts)),
    onFix: (id) => node('fix', id, () => actions.onFix(id)),
    onCut: (id) => edge('cable cut', id, () => actions.onCut(id)),
    onRestore: (id) => edge('cable restore', id, () => actions.onRestore(id)),
    onForget: actions.onForget,
  };
}
