import type { FailureKind, NodeConfig, SimSnapshot, Topology } from '../sim/types';
import {
  formatCount,
  formatMs,
  formatPct,
  formatRateBare,
  healthOfErr,
  healthOfLatency,
  healthOfLoad,
  type Health,
} from '../components/format';
import { MIN_RATE, readParts, type Reading } from './bottleneck';
import { offeredLoad } from './pathProgress';
import { totalSlots } from './tourSteps';

/* ------------------------------------------------------------------ *
 * An example's task: a goal and a few steps, each ticked off from what the
 * engine measures, never from a timer.
 *
 * Steps go in order. Only the current one is checked, and once ticked a
 * step stays ticked, so a reading that wobbles after the student has seen
 * it does not take the tick back. A step that names a state the system has
 * to be in ("Database is full") holds it for a few seconds of simulated
 * time first, because a part near its limit fills for a moment and clears
 * now and then at loads where nothing is wrong.
 * ------------------------------------------------------------------ */

/** Config fields a step may read, all plain numbers. */
export type NumericField = {
  [K in keyof NodeConfig]-?: NonNullable<NodeConfig[K]> extends number ? K : never;
}[keyof NodeConfig];

/** One live number a step reads, from the topology or the latest snapshot. */
export type Probe =
  /** Total load the clients offer, requests a second. */
  | { readonly of: 'load' }
  /** System share of requests lost, 0..1. */
  | { readonly of: 'failing' }
  /** System p99, ms. */
  | { readonly of: 'p99' }
  /** Share of the part's slots (or connections) in use, 0..1. */
  | { readonly of: 'busy'; readonly node: string }
  /** Requests waiting in the part's line. */
  | { readonly of: 'waiting'; readonly node: string }
  /** Work the part turned away that it did not choose to refuse, a second. */
  | { readonly of: 'turnedAway'; readonly node: string }
  /** Work a gate refused on purpose, a second. */
  | { readonly of: 'refused'; readonly node: string }
  /** Messages a stream's readers are behind, summed over groups. */
  | { readonly of: 'behind'; readonly node: string }
  /** Messages a stream removed by retention, a second. */
  | { readonly of: 'expired'; readonly node: string }
  /** Total slots, `capacity * instances`, as set. */
  | { readonly of: 'slots'; readonly node: string }
  /** Instances running now, which an autoscaler changes. */
  | { readonly of: 'running'; readonly node: string }
  /** Connections open now. */
  | { readonly of: 'connections'; readonly node: string }
  /** Requests the part finished, a second. */
  | { readonly of: 'served'; readonly node: string }
  /** A sharded store's average shard, 0..1, beside its busiest. */
  | { readonly of: 'shardAverage'; readonly node: string }
  /** 1 while a breaker is open, else 0. */
  | { readonly of: 'breakerOpen'; readonly node: string }
  /** 1 while the part has this fault, else 0. */
  | { readonly of: 'fault'; readonly node: string; readonly kind: FailureKind }
  /** A setting, as the inspector edits it. */
  | { readonly of: 'setting'; readonly node: string; readonly field: NumericField };

/** A probe's value compared to a bound. Both bounds may be given. */
export interface Cond {
  readonly probe: Probe;
  readonly atLeast?: number;
  /** Strictly below. */
  readonly below?: number;
}

/** What a step's button does. */
export type TaskAction =
  | { readonly kind: 'load'; readonly rps: number }
  | { readonly kind: 'select'; readonly node: string };

/** A number the card shows live beside a step, labelled in words. */
export interface Fig {
  readonly probe: Probe;
  readonly label: string;
}

export interface TaskStep {
  /** What to do or watch, in one sentence. */
  readonly text: string;
  /** All must hold for the step to tick. */
  readonly when: readonly Cond[];
  /** Simulated time they must hold for, in ms. Zero ticks at once. */
  readonly holdMs?: number;
  readonly action?: TaskAction;
  /** The part to ring on the canvas while this is the current step. */
  readonly ring?: string;
  /**
   * The inspector field the step asks to change, by its label, ringed once
   * the part is selected so the student need not hunt for it.
   */
  readonly field?: string;
  /** The live numbers shown while this is the current step. */
  readonly figs?: readonly Fig[];
  /**
   * A detour the student may skip: when the step after it ticks first, this
   * one is passed over and shown as skipped, never as done. For "try the
   * wrong fix first", which a student who goes straight to the right one
   * could otherwise never tick.
   */
  readonly optional?: boolean;
}

export interface ExampleTask {
  readonly presetId: string;
  /** The goal, in one line. */
  readonly goal: string;
  readonly steps: readonly TaskStep[];
  /** One line for "What you learned", shown once every step is ticked. */
  readonly learned: string;
}

/** Where a student is in a task. `step === steps.length` means done. */
export interface TaskProgress {
  readonly step: number;
  /**
   * Simulated time the current step's conditions have held, counted from
   * the first snapshot they held in, so one snapshot alone is zero.
   */
  readonly heldMs: number;
  /** They held in the last snapshot read. */
  readonly holding: boolean;
  /** Sim time of the last snapshot read, or null before the first. */
  readonly lastMs: number | null;
  /** Optional steps passed over, by index. */
  readonly skipped: readonly number[];
}

export const TASK_START: TaskProgress = {
  step: 0,
  heldMs: 0,
  holding: false,
  lastMs: null,
  skipped: [],
};

/**
 * The most one snapshot can add to a hold. Snapshots arrive ten a second,
 * so a bigger gap is a tab back from the background or a fast-forward, and
 * a second of it is all that counts, as in `PathProgress`.
 */
const MAX_STEP_MS = 1000;

/** The readings of one snapshot, worked out once and only if a probe asks. */
class Readings {
  private byId: Map<string, Reading> | null = null;
  private readonly topology: Topology;
  private readonly snapshot: SimSnapshot;
  constructor(topology: Topology, snapshot: SimSnapshot) {
    this.topology = topology;
    this.snapshot = snapshot;
  }
  of(id: string): Reading | undefined {
    if (!this.byId) {
      this.byId = new Map();
      for (const r of readParts(this.topology, this.snapshot))
        this.byId.set(r.node.id, r);
    }
    return this.byId.get(id);
  }
}

function sum(list: readonly number[] | undefined): number {
  let s = 0;
  for (const v of list ?? []) s += v;
  return s;
}

/** A probe's value now, or null when the part is gone or has not reported. */
export function probeValue(
  probe: Probe,
  topology: Topology,
  snapshot: SimSnapshot,
  readings: Readings = new Readings(topology, snapshot),
): number | null {
  switch (probe.of) {
    case 'load':
      return offeredLoad(topology);
    case 'failing':
      return snapshot.system.errorRate;
    case 'p99':
      return snapshot.system.p99;
    case 'slots':
      return topology.nodes.some((n) => n.id === probe.node)
        ? totalSlots(topology, probe.node)
        : null;
    case 'setting': {
      const v = topology.nodes.find((n) => n.id === probe.node)?.config[probe.field];
      return typeof v === 'number' ? v : null;
    }
    case 'fault':
      return snapshot.activeFailures.some(
        (f) => f.nodeId === probe.node && f.kind === probe.kind,
      )
        ? 1
        : 0;
    default:
      break;
  }
  const s = snapshot.nodes[probe.node];
  if (!s) return null;
  switch (probe.of) {
    case 'busy':
      return readings.of(probe.node)?.fill ?? null;
    case 'waiting':
      return readings.of(probe.node)?.line ?? null;
    case 'turnedAway':
      return readings.of(probe.node)?.refused ?? null;
    case 'refused':
      return (
        s.shedRate +
        (s.rejectedRate ?? 0) +
        (s.throttledRate ?? 0) +
        (s.bulkheadRejectedRate ?? 0)
      );
    case 'behind':
      return s.consumerLagByGroup ? sum(s.consumerLagByGroup) : (s.consumerLag ?? null);
    case 'expired':
      return s.retentionDropRate ?? 0;
    case 'running':
      return s.instances ?? null;
    case 'connections':
      return s.connectionsOpen ?? null;
    case 'served':
      return s.throughput;
    case 'shardAverage': {
      const list = s.shardUtilization;
      return list.length > 0 ? sum(list) / list.length : null;
    }
    case 'breakerOpen':
      return s.breakerState === 'open' ? 1 : 0;
  }
}

function holds(cond: Cond, v: number | null): boolean {
  if (v === null) return false;
  if (cond.atLeast !== undefined && v < cond.atLeast) return false;
  if (cond.below !== undefined && v >= cond.below) return false;
  return true;
}

/** Do all of a step's conditions hold in this snapshot? */
export function stepHolds(
  step: TaskStep,
  topology: Topology,
  snapshot: SimSnapshot,
): boolean {
  const readings = new Readings(topology, snapshot);
  return step.when.every((c) =>
    holds(c, probeValue(c.probe, topology, snapshot, readings)),
  );
}

/**
 * Move a task on by one snapshot. Returns the same object when nothing
 * changed, so a caller can skip the update and a render-time caller comes
 * to rest after one pass.
 */
export function advanceTask(
  task: ExampleTask,
  progress: TaskProgress,
  topology: Topology,
  snapshot: SimSnapshot,
): TaskProgress {
  let { step, heldMs, holding, skipped } = progress;
  if (step >= task.steps.length) return progress;
  const now = snapshot.system.timeMs;
  // A reset engine starts its clock again; a smaller time is a new run.
  const fresh = progress.lastMs === null || now < progress.lastMs;
  if (fresh) {
    heldMs = 0;
    holding = false;
  }
  let dt = fresh ? 0 : Math.min(now - (progress.lastMs ?? now), MAX_STEP_MS);
  // Steps that hold at once tick together; a held step waits for its time.
  while (step < task.steps.length) {
    const current = task.steps[step];
    if (!current) break;
    let target = step;
    if (!stepHolds(current, topology, snapshot)) {
      const after = task.steps[step + 1];
      if (current.optional && after && stepHolds(after, topology, snapshot)) {
        target = step + 1;
      } else {
        heldMs = 0;
        holding = false;
        break;
      }
    }
    // The time since the last snapshot counts only if it held there too.
    if (holding) heldMs += dt;
    holding = true;
    dt = 0;
    if (heldMs < (task.steps[target]?.holdMs ?? 0)) break;
    if (target > step) skipped = [...skipped, step];
    step = target + 1;
    heldMs = 0;
    holding = false;
  }
  if (
    step === progress.step &&
    heldMs === progress.heldMs &&
    holding === progress.holding &&
    now === progress.lastMs
  ) {
    return progress;
  }
  return { step, heldMs, holding, lastMs: now, skipped };
}

/* ---------------- what the card shows ---------------- */

/**
 * Settings the inspector shows as a percentage, 0..1 underneath. A figure
 * reads the same way as the slider beside it: "30%", never "0.3".
 */
const SHARE_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>([
  'hitRate',
  'readFraction',
  'hotKeyFraction',
  'errorRate',
  'targetUtil',
  'errorThreshold',
]);

/** One live figure, formatted: "12/12", "15%", "394ms". */
export interface FigView {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly health: Health;
}

/** "399ms" to "399" and "ms", so the unit can ride smaller than the number. */
function split(text: string): { value: string; unit: string } {
  const m = /^([<\d.,]+)(.*)$/.exec(text);
  return m ? { value: m[1] ?? text, unit: m[2] ?? '' } : { value: text, unit: '' };
}

/**
 * A step's figures, read from one snapshot. A figure with nothing behind it
 * (a part that is gone, a p99 before any request finished) is left out,
 * never shown as a guess.
 */
export function figViews(
  figs: readonly Fig[],
  topology: Topology,
  snapshot: SimSnapshot,
): FigView[] {
  const readings = new Readings(topology, snapshot);
  const out: FigView[] = [];
  for (const f of figs) {
    const v = probeValue(f.probe, topology, snapshot, readings);
    if (v === null) continue;
    const p = f.probe;
    switch (p.of) {
      case 'load':
        // As the slider's own readout spells it: "1.7k", not "1742".
        out.push({
          label: f.label,
          value: formatRateBare(v),
          unit: '/s',
          health: 'ok',
        });
        break;
      case 'failing':
        out.push({ label: f.label, ...split(formatPct(v)), health: healthOfErr(v) });
        break;
      case 'p99':
        if (v === 0 && snapshot.system.goodputRps === 0) break;
        out.push({ label: f.label, ...split(formatMs(v)), health: healthOfLatency(v) });
        break;
      case 'busy':
      case 'shardAverage':
        out.push({ label: f.label, ...split(formatPct(v)), health: healthOfLoad(v) });
        break;
      case 'turnedAway':
      case 'expired':
        out.push({
          label: f.label,
          value: formatRateBare(v),
          unit: '/s',
          health: v >= MIN_RATE ? 'danger' : 'ok',
        });
        break;
      case 'refused':
      case 'served':
        out.push({
          label: f.label,
          value: formatRateBare(v),
          unit: '/s',
          health: 'ok',
        });
        break;
      case 'breakerOpen':
        out.push({
          label: f.label,
          value: v === 1 ? 'Open' : 'Closed',
          unit: '',
          health: v === 1 ? 'warn' : 'ok',
        });
        break;
      case 'fault':
        out.push({
          label: f.label,
          value: v === 1 ? 'Down' : 'Up',
          unit: '',
          health: v === 1 ? 'danger' : 'ok',
        });
        break;
      case 'setting':
        out.push(
          SHARE_FIELDS.has(p.field)
            ? { label: f.label, ...split(formatPct(v)), health: 'ok' }
            : { label: f.label, value: `${v}`, unit: '', health: 'ok' },
        );
        break;
      default:
        out.push({
          label: f.label,
          value: formatCount(Math.round(v)),
          unit: '',
          health: 'ok',
        });
        break;
    }
  }
  return out;
}
