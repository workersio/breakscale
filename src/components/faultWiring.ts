import type { Engine } from '../sim/engine';
import { DEFAULT_SEED } from '../sim/seed';
import type {
  ActiveFailure,
  FailureOpts,
  FaultEvent,
  SimNode,
  SimSnapshot,
  Topology,
} from '../sim/types';
import { formatElapsed, formatPct } from './format';

/* ------------------------------------------------------------------ *
 * Fault controls: the choices, the words, and the wiring to the engine.
 * The components that draw them are in FaultControls.tsx.
 * ------------------------------------------------------------------ */

/** Service-time multipliers offered for Slow. */
export const SLOW_FACTORS: readonly number[] = [2, 3, 5, 10, 20];
/**
 * 5x, because at 5x the bulkhead example fills its 12-call pool within the
 * first second and turns away 64 to 70 percent of calls. At 2x it only
 * turns away 17 to 21 percent, which is easy to miss.
 */
export const DEFAULT_SLOW_FACTOR = 5;

/** Failure fractions offered for Glitch. */
export const GLITCH_RATES: readonly number[] = [0.1, 0.25, 0.5, 0.75, 1];
/**
 * Half, because both breaker examples trip at half their calls failing.
 * At 50 percent the payments breaker in front of the card networks opened
 * within five seconds; at 25 percent it stayed closed for ten.
 */
export const DEFAULT_GLITCH_RATE = 0.5;

/** Loss fractions offered for a single connection. 0 is a perfect link. */
export const LOSS_RATES: readonly number[] = [0, 0.01, 0.05, 0.1, 0.25, 0.5];
/**
 * 10%, because it shows what retries hide. In the retry storm example,
 * where the API retries the database twice, 10% loss on that connection
 * failed 0 to 0.2 percent of requests. The same loss in the single server
 * example, with no retries, failed 8.8 to 10.6 percent.
 */
export const DEFAULT_LOSS_RATE = 0.1;

/**
 * An edge's lossRate as the controls read it: the engine treats anything
 * that is not a positive number as no loss, and anything from 1 up as all.
 */
export function lossOf(rate: number | undefined): number {
  if (rate === undefined || !(rate > 0)) return 0;
  return Math.min(rate, 1);
}

/**
 * The topology with one edge's lossRate set, or null when that changes
 * nothing. Setting it to 0 removes the field rather than storing a zero, so
 * the design is left as it was before any loss was set.
 */
export function withEdgeLoss(
  topology: Topology,
  edgeId: string,
  lossRate: number,
): Topology | null {
  const edge = topology.edges.find((e) => e.id === edgeId);
  if (!edge || lossOf(edge.lossRate) === lossRate) return null;
  return {
    ...topology,
    edges: topology.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const { lossRate: _previous, ...rest } = e;
      return lossRate > 0 ? { ...rest, lossRate } : rest;
    }),
  };
}

/**
 * A design that replaces the one on screen, spelled out for the engine.
 *
 * setTopology keeps the current schedule and seed when a topology leaves them
 * out, which is right for an edit and wrong for a new design. Without this,
 * reset() would replay faults recorded against the previous design, and an
 * example opened after a seeded replay would run on the replay's seed instead
 * of the one it always ran on.
 */
export function asReplacement(t: Topology): Topology {
  return { ...t, faults: t.faults ?? [], seed: t.seed ?? DEFAULT_SEED };
}

/**
 * The topology carrying the engine's schedule after an edit.
 *
 * Removing a cut cable or a faulted node adds the entry that heals it to the
 * engine's schedule. The shell has to hold that list too, because the next
 * edit hands its own back and a different list replaces the engine's.
 */
export function withSchedule(t: Topology, schedule: FaultEvent[]): Topology {
  const held = t.faults ?? [];
  if (JSON.stringify(held) === JSON.stringify(schedule)) return t;
  return { ...t, faults: schedule };
}

/** What a single cable is doing, from the fault controls' point of view. */
export type CableState =
  /** Carrying traffic, or free to. */
  | 'connected'
  /** Cut with Cut cable. Restore reconnects it. */
  | 'cut'
  /**
   * Cut because a node at one end is cut off from all its cables. Restore
   * cannot reach it; fixing that node does.
   */
  | 'partitioned';

export interface CableInfo {
  /** Edge id. */
  id: string;
  /** How the cable is named on its row, e.g. "To Payments API". */
  label: string;
  state: CableState;
}

/** The sentence under the section title. Plain words, and the time it began. */
export function faultStatus(fault: ActiveFailure | null): string {
  if (!fault) return 'Working normally.';
  const since = formatElapsed(fault.sinceMs / 1000);
  switch (fault.kind) {
    case 'crash':
      return `Crashed at ${since}. Every request sent to it fails until you fix it.`;
    case 'slow':
      return `Running ${formatFactor(fault.factor ?? 1)} slower since ${since}. Requests wait longer for it, and the line behind it grows.`;
    case 'errors':
      return `Failing ${formatPct(fault.rate ?? 1)} of requests since ${since}. It stays up, so callers keep sending it work.`;
    case 'partition':
      return `Cut off from the network since ${since}. Anything sent over its cut cables fails until you fix it, and the cables below show which ones.`;
    case 'crash-instance':
      return `One instance crashed at ${since}. The work it held was lost, and the others carry its share with fewer slots until you fix it. If it was the only one, nothing is serving.`;
  }
}

/** A service-time multiplier as the controls print it: `5x`. */
export function formatFactor(f: number): string {
  return `${Number.isInteger(f) ? f : f.toFixed(1)}x`;
}

/** What the fault controls show for the current selection. */
export interface FaultView {
  /** The fault in force on the selected node, or null. */
  fault: ActiveFailure | null;
  /** Every cable into or out of the selected node. */
  cables: readonly CableInfo[];
  /**
   * The one selected connection, when the selection is exactly one edge.
   * `cutBy` names the node whose own fault is cutting it, if one is, and
   * `lossRate` is the share of crossings it drops, read from the design.
   */
  edge: (CableInfo & { cutBy?: string; lossRate: number }) | null;
  /** How many entries the fault schedule holds, recorded or loaded. */
  recorded: number;
}

/** What the fault controls do. Every action is recorded. */
export interface FaultActions {
  onInject: (
    nodeId: string,
    kind: 'crash' | 'crash-instance' | 'slow' | 'errors',
    opts?: FailureOpts,
  ) => void;
  onFix: (nodeId: string) => void;
  onCut: (edgeId: string) => void;
  onRestore: (edgeId: string) => void;
  /**
   * Empty the fault schedule, so Reset starts a clean run and the share
   * dialog stops offering a replay. Faults in force now stay in force.
   */
  onForget: () => void;
}

/** Everything the inspector needs to show and drive the fault controls. */
export type InspectorFaults = FaultView & FaultActions;

/** The part of the engine the fault controls touch. */
export type FaultEngine = Pick<
  Engine,
  | 'activeCuts'
  | 'faultSchedule'
  | 'clearFaultSchedule'
  | 'recordFailure'
  | 'recordClearFailure'
  | 'recordCutEdge'
  | 'recordRestoreEdge'
>;

export interface FaultSelection {
  /** The single selected node, or null. */
  node: SimNode | null;
  /** How many nodes are selected. */
  nodeCount: number;
  /** How many edges are selected. */
  edgeCount: number;
  /** The whole selection, node and edge ids together. */
  ids: ReadonlySet<string>;
}

/**
 * What the fault controls show, from the engine and the latest snapshot.
 *
 * Cuts made with Cut cable are read from the engine, because the snapshot
 * reports every severed edge as 'cut' without saying whether Restore can
 * reach it. A cut the snapshot reports that the engine did not make is a
 * node's partition, and only fixing that node heals it.
 */
export function faultViewFor(
  engine: FaultEngine,
  topology: Topology,
  snapshot: SimSnapshot | null,
  sel: FaultSelection,
): FaultView {
  const byId = new Map(topology.nodes.map((n) => [n.id, n] as const));
  const severed = new Set(engine.activeCuts());
  const edgeState = snapshot?.edgeState ?? {};
  const stateOf = (id: string): CableState =>
    severed.has(id) ? 'cut' : edgeState[id] === 'cut' ? 'partitioned' : 'connected';
  const nameOf = (id: string): string => byId.get(id)?.label ?? id;

  const cables: CableInfo[] = [];
  if (sel.node) {
    for (const e of topology.edges) {
      if (e.from === sel.node.id) {
        cables.push({ id: e.id, label: `To ${nameOf(e.to)}`, state: stateOf(e.id) });
      } else if (e.to === sel.node.id) {
        cables.push({
          id: e.id,
          label: `From ${nameOf(e.from)}`,
          state: stateOf(e.id),
        });
      }
    }
  }

  let edge: FaultView['edge'] = null;
  if (sel.nodeCount === 0 && sel.edgeCount === 1) {
    const e = topology.edges.find((x) => sel.ids.has(x.id));
    if (e) {
      const state = stateOf(e.id);
      const by =
        state === 'partitioned'
          ? snapshot?.activeFailures.find(
              (f) => f.kind === 'partition' && (f.edgeIds ?? []).includes(e.id),
            )
          : undefined;
      edge = {
        id: e.id,
        label: `${nameOf(e.from)} to ${nameOf(e.to)}`,
        state,
        ...(by ? { cutBy: nameOf(by.nodeId) } : {}),
        lossRate: lossOf(e.lossRate),
      };
    }
  }

  const nodeId = sel.node?.id;
  return {
    fault:
      nodeId !== undefined
        ? (snapshot?.activeFailures.find((f) => f.nodeId === nodeId) ?? null)
        : null,
    cables,
    edge,
    recorded: engine.faultSchedule().length,
  };
}

/**
 * The four actions, each recorded into the engine's fault schedule, and
 * Forget, which empties it.
 * `onRecorded` runs after any action the engine accepted, so the shell can
 * refresh its snapshot and mirror the schedule.
 */
export function faultActionsFor(
  engine: FaultEngine,
  onRecorded: () => void,
): FaultActions {
  return {
    onInject: (id, kind, opts) => {
      engine.recordFailure(id, kind, opts);
      onRecorded();
    },
    onFix: (id) => {
      engine.recordClearFailure(id);
      onRecorded();
    },
    onCut: (id) => {
      if (engine.recordCutEdge(id)) onRecorded();
    },
    onRestore: (id) => {
      if (engine.recordRestoreEdge(id)) onRecorded();
    },
    onForget: () => {
      if (engine.faultSchedule().length === 0) return;
      engine.clearFaultSchedule();
      onRecorded();
    },
  };
}
