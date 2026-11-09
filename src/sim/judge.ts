// behaviour before behaviour-control: the second imports the first, which
// builds its table from the second, so entering the cycle from the control
// side reads that table before it exists.
import { behaviourFor } from './behaviour';
import { fleetBounds } from './behaviour-control';
import { isRouteGoal, locksFor, splitLoad } from './challenge';
import type { Challenge, Goal } from './challenge';
import { Engine } from './engine';
import { sanitizeFaults } from './faults';
import { PRESETS, defaultConfig } from './presets';
import type {
  FailureReason,
  NodeConfig,
  NodeKind,
  RouteTally,
  RunTally,
  SimNode,
  Topology,
} from './types';

/* ------------------------------------------------------------------ *
 * The check.
 *
 * The live view shows how a design is doing right now, on whatever seed,
 * load and faults the reader has, and it moves. A verdict cannot: the same
 * design has to get the same answer every time it is checked, on anyone's
 * machine, however the frames fall. So the check builds its own run from the
 * design. It puts the brief's load, faults and fixed fields back, plays it on
 * three seeds, warms each one up, and counts only a window after that, from
 * an exact tally of every request, never from the rolling numbers the
 * snapshot shows.
 *
 * It runs as a generator so the interface can play it in slices between
 * frames and drop it the moment the design changes. `judge` runs one to the
 * end, for tests and scripts.
 * ------------------------------------------------------------------ */

/** The seeds every design is checked on, in the order they run. */
export const CHECK_SEEDS: readonly number[] = [1, 2, 3];
/** Simulated ms per step: one frame at 60fps, as the live view runs. */
export const CHECK_FRAME_MS = 1000 / 60;
/** Steps between two yields of `checkDesign`: half a simulated second. */
export const CHECK_SLICE_FRAMES = 30;
export const DEFAULT_WARMUP_S = 15;
export const DEFAULT_WINDOW_S = 45;
/**
 * The share of requests sent inside the window that must also settle inside
 * it. Below this the design is building a backlog it will never clear, and
 * the requests still stuck in line have no latency yet to fail a goal on.
 */
export const KEPT_UP_FLOOR = 0.98;
/**
 * Ms the check keeps playing after the window when a brief counts lost
 * writes or lost jobs, so work acknowledged in the window's last moments has
 * had time to land, or to fail, before it is counted. Nothing else is
 * measured in it.
 */
export const SETTLE_MS = 2000;

/** Why a design could not be put through the brief at all. */
export type Unjudgeable =
  /** No client is left, so there is no load to judge it under. */
  | { reason: 'no-traffic' }
  /**
   * A fault the brief schedules names a node or edge the design no longer
   * has, or a node that can no longer take that fault. Judging it without
   * the fault would grade a different brief.
   */
  | { reason: 'fault-target-missing'; target: string; why: string }
  /** More traffic sources than the brief has, splitting its load with them. */
  | { reason: 'traffic-added' }
  /**
   * Fewer components of this kind that requests can reach than the brief
   * starts with: one was deleted, retyped or cut off.
   */
  | { reason: 'component-missing'; kind: NodeKind }
  /** Requests no longer get from `from` to `to`, as they did in the brief. */
  | { reason: 'connection-cut'; from: string; to: string }
  /** `from` now calls `to` directly, which the brief's design never did. */
  | { reason: 'connection-added'; from: string; to: string }
  /**
   * A new component of a kind that answers before the work is done, a cache
   * or a queue, in a brief whose lesson it would skip. `allowed` is how many
   * more of the kind the brief lets in: 0, or 1 for a kind it allows.
   */
  | { reason: 'shortcut-added'; kind: NodeKind; allowed: number }
  /**
   * A component requests reach that answers without passing them on, of a
   * kind that is never the end of the line in the brief's design.
   */
  | { reason: 'dead-end-added'; nodeId: string; kind: NodeKind };

/** How a goal came out on one run. */
export interface GoalOutcome {
  goal: Goal;
  /** The measured value, in the goal's unit. Null when nothing completed. */
  actual: number | null;
  met: boolean;
}

/** One seed's run, measured over the window only. */
export interface RunResult {
  seed: number;
  /** Client requests sent inside the window. */
  arrived: number;
  completed: number;
  failed: number;
  /** `failed`, split by why. A reason that never happened is absent. */
  failuresByReason: Partial<Record<FailureReason, number>>;
  /** Failed over settled, 0..1. Null when nothing settled. */
  loss: number | null;
  /** Settled over arrived. Null when nothing arrived. */
  keptUp: number | null;
  /** Nearest-rank percentiles of the window's successes, in ms. */
  p95: number | null;
  p99: number | null;
  /**
   * Writes a write-behind cache acknowledged inside the window that had not
   * reached the store `SETTLE_MS` after it. Null when the brief has no goal
   * on it, since the check then stops at the window's end.
   */
  lostWrites: number | null;
  /**
   * Jobs a queue accepted inside the window that failed once a worker took
   * them, counted up to `SETTLE_MS` after it. Null when the brief has no goal
   * on it.
   */
  lostJobs: number | null;
  /**
   * The longest line of messages in any queue at the end of the window, or
   * null when the design has no queue.
   */
  queueDepth: number | null;
  goals: GoalOutcome[];
  outcome: 'passed' | 'goal-missed' | 'nothing-completed' | 'falling-behind';
  /**
   * The run as the engine played it, seed included. Loading it and tallying
   * the same window gives the same counts, whatever the step sizes.
   */
  replay: Topology;
}

/** Slots added over the start design, against what the brief allows. */
export interface BudgetUse {
  used: number;
  allowed: number;
}

interface Judged {
  designKey: string;
  budget: BudgetUse | null;
}

/**
 * What the check concluded.
 *
 * `deciding` is the run the verdict rests on: the first seed that failed,
 * or, for a pass, the one that came closest to failing.
 */
export type Verdict =
  | (Judged & { status: 'passed'; runs: RunResult[]; deciding: RunResult })
  | (Judged & {
      status: 'goal-missed' | 'nothing-completed' | 'falling-behind';
      runs: RunResult[];
      deciding: RunResult;
    })
  | (Judged & { status: 'over-budget'; budget: BudgetUse })
  | (Judged & { status: 'unjudgeable'; why: Unjudgeable });

/** Where a check is, for a progress bar. */
export interface CheckProgress {
  /** Index into CHECK_SEEDS of the run being played. */
  run: number;
  /** 0..1 of the whole check, counting every seed as if it will run. */
  done: number;
}

/* ---------------- the judged design ---------------- */

const STARTS = new WeakMap<Challenge, Topology>();

/**
 * The design a brief starts from: its preset, with the brief's own changes
 * to it applied. Throws for a brief naming a preset or a node that does not
 * exist, a bug. The same object every time for the same brief; treat it as
 * read-only.
 */
export function startDesign(challenge: Challenge): Topology {
  const known = STARTS.get(challenge);
  if (known) return known;
  const preset = PRESETS.find((p) => p.id === challenge.presetId);
  if (!preset)
    throw new Error(`challenge ${challenge.id}: no preset ${challenge.presetId}`);
  let start = preset.topology;
  const changes = challenge.startOverrides;
  if (changes) {
    for (const id of Object.keys(changes)) {
      if (!start.nodes.some((n) => n.id === id))
        throw new Error(`challenge ${challenge.id}: no node ${id} in ${preset.id}`);
    }
    start = {
      ...start,
      nodes: start.nodes.map((n) =>
        changes[n.id] ? { ...n, config: { ...n.config, ...changes[n.id] } } : n,
      ),
    };
  }
  STARTS.set(challenge, start);
  return start;
}

/**
 * The topology with its clients carrying `loadRps` between them, in their
 * current mix, all of it steady. The input is not changed.
 */
export function withLoad(topology: Topology, loadRps: number): Topology {
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  const shares = splitLoad(
    loadRps,
    clients.map((c) => c.config.rps),
  );
  let k = 0;
  return {
    ...topology,
    nodes: topology.nodes.map((n) => {
      if (n.kind !== 'client') return n;
      const rps = shares[k++];
      return { ...n, config: { ...n.config, rps, traffic: 'steady' } };
    }),
  };
}

/**
 * The node a locked field is put back from: the start design's node with the
 * same id and kind, or else its first node of that kind. A database deleted
 * and added back under a new id is still the brief's database, and its work
 * still takes as long. A kind the brief never had runs at its defaults.
 */
function lockSource(node: SimNode, start: Topology): NodeConfig {
  const same = start.nodes.find((n) => n.id === node.id && n.kind === node.kind);
  const first = same ?? start.nodes.find((n) => n.kind === node.kind);
  return first?.config ?? defaultConfig(node.kind);
}

function restoreLocks(
  topology: Topology,
  challenge: Challenge,
  start: Topology,
): Topology {
  const locks = locksFor(challenge);
  return {
    ...topology,
    nodes: topology.nodes.map((node) => {
      const config: Record<string, unknown> = { ...node.config };
      let source: NodeConfig | null = null;
      for (const lock of locks) {
        if (lock.kind !== '*' && lock.kind !== node.kind) continue;
        source ??= lockSource(node, start);
        const value = source[lock.field];
        if (value === undefined) delete config[lock.field];
        else config[lock.field] = value;
      }
      return { ...node, config: config as unknown as NodeConfig };
    }),
  };
}

/**
 * The design the check runs: the reader's, with their faults and seed taken
 * out, the fields the brief holds still put back, the brief's load on its
 * clients, and the brief's faults scheduled. Notes and sections carry no
 * traffic and are dropped. The input is not changed.
 */
export function judgedTopology(
  challenge: Challenge,
  design: Topology,
  start: Topology = startDesign(challenge),
): { topology: Topology; unjudgeable: Unjudgeable | null } {
  const bare: Topology = {
    nodes: design.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: design.edges.map((e) => ({ ...e })),
  };
  const loaded = withLoad(restoreLocks(bare, challenge, start), challenge.loadRps);

  const wanted = challenge.faults ?? [];
  const dropped: Unjudgeable[] = [];
  const faults = sanitizeFaults(wanted, loaded, (index, why) => {
    const f = wanted[index];
    const target = f.action === 'cut' || f.action === 'restore' ? f.edgeId : f.nodeId;
    dropped.push({ reason: 'fault-target-missing', target, why });
  });
  const topology = faults.length > 0 ? { ...loaded, faults } : loaded;
  const unjudgeable: Unjudgeable | null = !loaded.nodes.some((n) => n.kind === 'client')
    ? { reason: 'no-traffic' }
    : (dropped[0] ?? structureProblem(challenge, loaded, start));
  return { topology, unjudgeable };
}

/* ---------------- what the design still has to be ---------------- *
 *
 * The locks keep the work honest; these rules keep the system honest. A
 * brief is a system with a problem in it, and a design that passes by no
 * longer being that system has not solved anything: the database deleted so
 * nothing waits on it, a queue in front that says yes to everything, a
 * second client soaking up half the load. Each of these was measured
 * passing a brief before the rule against it existed.
 *
 * So the judged design has to keep every component the brief starts with,
 * reachable, and every route between them; it may not add a traffic source,
 * a direct call between two of the brief's components, a component that
 * answers on the system's behalf unless the brief allows one, or a new end of
 * the line of a kind the brief never ends on. Everything else is the
 * reader's to change, including putting new components in between.
 * ------------------------------------------------------------------ */

/**
 * Kinds that answer a request before the work behind them is done: a cache
 * or CDN on a hit, edge compute on its own, and the queues and buffers on
 * the ack. One added in front of the part a brief is about makes the problem
 * disappear without fixing it, so a brief has to allow them by name.
 */
export const SHORTCUT_KINDS: readonly NodeKind[] = [
  'cache',
  'cdn',
  'edgecompute',
  'queue',
  'pubsub',
  'streambroker',
  'retryqueue',
  'writebehind',
];

/** Request edges out of each node, by id. Control edges carry no requests. */
function requestEdges(topology: Topology): Map<string, string[]> {
  const kinds = new Map(topology.nodes.map((n) => [n.id, n.kind]));
  const out = new Map<string, string[]>();
  for (const e of topology.edges) {
    const from = kinds.get(e.from);
    if (from === undefined || !kinds.has(e.to)) continue;
    if (e.control === true || behaviourFor(from).controlsTarget === true) continue;
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }
  return out;
}

/** Every node id reachable from `from` along request edges, `from` included. */
function reachable(out: Map<string, string[]>, from: readonly string[]): Set<string> {
  const seen = new Set(from);
  const stack = [...from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const to of out.get(id) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen;
}

interface Shape {
  out: Map<string, string[]>;
  /** Reachable from a traffic source. */
  live: Set<string>;
  kinds: Map<string, NodeKind>;
  sources: number;
}

function shapeOf(topology: Topology): Shape {
  const out = requestEdges(topology);
  const sources = topology.nodes.filter((n) => behaviourFor(n.kind).generatesLoad);
  return {
    out,
    live: reachable(
      out,
      sources.map((n) => n.id),
    ),
    kinds: new Map(topology.nodes.map((n) => [n.id, n.kind])),
    sources: sources.length,
  };
}

function countKind(shape: Shape, kind: NodeKind, liveOnly: boolean): number {
  let n = 0;
  for (const [id, k] of shape.kinds) {
    if (k === kind && (!liveOnly || shape.live.has(id))) n++;
  }
  return n;
}

/** The first rule the judged design breaks, or null. See above. */
export function structureProblem(
  challenge: Challenge,
  judged: Topology,
  start: Topology,
): Unjudgeable | null {
  const a = shapeOf(start);
  const b = shapeOf(judged);

  if (b.sources > a.sources) return { reason: 'traffic-added' };

  for (const kind of new Set(a.kinds.values())) {
    if (behaviourFor(kind).generatesLoad) continue;
    if (countKind(b, kind, true) < countKind(a, kind, true)) {
      return { reason: 'component-missing', kind };
    }
  }

  for (const [from, tos] of a.out) {
    if (!b.kinds.has(from)) continue;
    for (const to of tos) {
      if (!b.kinds.has(to)) continue;
      if (!reachable(b.out, [from]).has(to))
        return { reason: 'connection-cut', from, to };
    }
  }

  for (const [from, tos] of b.out) {
    if (!a.kinds.has(from)) continue;
    for (const to of tos) {
      if (a.kinds.has(to) && !(a.out.get(from) ?? []).includes(to)) {
        return { reason: 'connection-added', from, to };
      }
    }
  }

  // A kind the brief allows can be added once. Each cache in a row rolls its
  // own hit rate, so three of them in front of a part pass on about 99 in
  // 100 reads between them, and that hides the part instead of fixing it.
  const allowedKinds = challenge.allowedNewKinds ?? [];
  for (const kind of SHORTCUT_KINDS) {
    const allowed = allowedKinds.includes(kind) ? 1 : 0;
    if (countKind(b, kind, false) > countKind(a, kind, false) + allowed) {
      return { reason: 'shortcut-added', kind, allowed };
    }
  }

  const ends = new Set<NodeKind>();
  for (const id of a.live) {
    const kind = a.kinds.get(id);
    if (kind !== undefined && (a.out.get(id) ?? []).length === 0) ends.add(kind);
  }
  for (const node of judged.nodes) {
    if (!b.live.has(node.id) || (b.out.get(node.id) ?? []).length > 0) continue;
    if (!ends.has(node.kind)) {
      return { reason: 'dead-end-added', nodeId: node.id, kind: node.kind };
    }
  }
  return null;
}

/* ---------------- design key ---------------- */

/**
 * JSON with object keys sorted and undefined left out, so two designs that
 * run the same serialise the same whatever order their fields were set in.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonical(obj[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** cyrb53: a 53-bit string hash, in base 36. Not cryptographic, not meant to be. */
export function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What a verdict is about: the brief, its version, and the judged design.
 * Two designs with the same key get the same verdict, so a check is current
 * exactly while the key is. Where a node sits, what it is called and the
 * seed the reader picked change nothing the check measures and are left out,
 * so dragging a box does not throw a pass away.
 */
export function designKey(challenge: Challenge, judged: Topology): string {
  const run = {
    nodes: judged.nodes.map((n) => ({ id: n.id, kind: n.kind, config: n.config })),
    edges: judged.edges,
    faults: judged.faults ?? [],
  };
  return `${challenge.id}@${challenge.version}:${hash53(canonical(run))}`;
}

/* ---------------- slots ---------------- */

/** A count field as the engine reads it: whole, at least 1. */
function whole(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 1;
}

/**
 * How many requests a node can work on at once, at the most it can grow to.
 *
 * Capacity times the fleet: instances for a kind that scales by them, the
 * partitions for a shard (each with its own `shardCapacity`), and the primary
 * plus its replicas for a replica set. A node an autoscaler drives counts at
 * the most the autoscaler will run it at (its floor, when that is set above
 * its ceiling), because that is how far it will grow it without asking. A
 * source of load, such as a client, and a kind that holds no slots
 * of its own, such as a gate or a controller, has none.
 */
export function slotsOf(node: SimNode, peakFleet = 0): number {
  const b = behaviourFor(node.kind);
  if (!b.servesRequests || b.generatesLoad) return 0;
  const c = node.config;
  switch (node.kind) {
    case 'shard':
      return whole(c.shardCount) * Math.max(whole(c.shardCapacity), peakFleet);
    case 'replica':
      return whole(c.capacity) * (whole(c.replicaCount) + 1);
    default:
      return whole(c.capacity) * Math.max(whole(c.instances), peakFleet);
  }
}

/** The ceiling each autoscaled node can be grown to, by node id. */
function peakFleets(topology: Topology): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of topology.nodes) {
    if (n.kind !== 'autoscaler') continue;
    const { max } = fleetBounds(n.config);
    for (const e of topology.edges) {
      if (e.from !== n.id) continue;
      const target = topology.nodes.find((t) => t.id === e.to);
      if (!target || behaviourFor(target.kind).scaleField === undefined) continue;
      out.set(e.to, Math.max(out.get(e.to) ?? 0, max));
    }
  }
  return out;
}

/**
 * Slots the design adds over the start design, summed node by node and
 * matched by id. Taking slots away from one node does not pay for them on
 * another: without that, a brief with no room to spare is passed by moving
 * room from where it is idle to where it is short, which is the move it was
 * written to rule out.
 */
export function extraSlots(design: Topology, start: Topology): number {
  const before = new Map<string, number>();
  const startPeaks = peakFleets(start);
  for (const n of start.nodes) before.set(n.id, slotsOf(n, startPeaks.get(n.id)));
  const peaks = peakFleets(design);
  let extra = 0;
  for (const n of design.nodes) {
    extra += Math.max(0, slotsOf(n, peaks.get(n.id)) - (before.get(n.id) ?? 0));
  }
  return extra;
}

/** The brief's slot budget and how much of it the design spends, or null. */
export function slotBudget(
  challenge: Challenge,
  design: Topology,
  start: Topology = startDesign(challenge),
): BudgetUse | null {
  if (challenge.budget === undefined) return null;
  return { used: extraSlots(design, start), allowed: challenge.budget };
}

/* ---------------- measuring ---------------- */

/** Nearest-rank percentile of an ascending list, or null when it is empty. */
export function nearestRank(sorted: Float64Array, p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
  return sorted[rank - 1];
}

function measure(
  goal: Goal,
  run: Pick<
    RunResult,
    'p95' | 'p99' | 'loss' | 'lostWrites' | 'lostJobs' | 'queueDepth'
  >,
): number | null {
  switch (goal.metric) {
    case 'p99':
      return run.p99;
    case 'p95':
      return run.p95;
    case 'errorRate':
      return run.loss === null ? null : run.loss * 100;
    case 'lostWrites':
      return run.lostWrites;
    case 'lostJobs':
      return run.lostJobs;
    case 'queueDepth':
      return run.queueDepth;
  }
}

/**
 * One client's window, in the shape `measure` reads, for a goal on that
 * route. A client with nothing settled in the window has no reading, which
 * misses the goal rather than passing it.
 */
function routeFigures(
  route: RouteTally | undefined,
): Pick<RunResult, 'p95' | 'p99' | 'loss' | 'lostWrites' | 'lostJobs' | 'queueDepth'> {
  const sorted = route ? route.latencies.slice().sort() : new Float64Array(0);
  const settled = route ? route.completed + route.failed : 0;
  return {
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    loss: route && settled > 0 ? route.failed / settled : null,
    lostWrites: null,
    lostJobs: null,
    queueDepth: null,
  };
}

/**
 * The requests a run's gates count: the whole system's, or, when every goal
 * names a client, those clients' own.
 */
function gateOf(
  goals: readonly Goal[],
  tally: RunTally,
): { arrived: number; completed: number; failed: number } {
  if (goals.length === 0 || !goals.every(isRouteGoal)) return tally;
  const out = { arrived: 0, completed: 0, failed: 0 };
  for (const route of new Set(goals.map((g) => g.route))) {
    const r = tally.byRoute[route];
    if (!r) continue;
    out.arrived += r.arrived;
    out.completed += r.completed;
    out.failed += r.failed;
  }
  return out;
}

/** The longest line in any queue the engine is running, or null for none. */
function deepestQueue(engine: Engine, topology: Topology): number | null {
  const nodes = engine.snapshot().nodes;
  let deepest: number | null = null;
  for (const n of topology.nodes) {
    if (!behaviourFor(n.kind).buffersForConsumers) continue;
    const queued = nodes[n.id]?.queued ?? 0;
    deepest = Math.max(deepest ?? 0, queued);
  }
  return deepest;
}

/** How far inside its goals a run landed, as the smallest share of headroom. */
function margin(run: RunResult): number {
  let m = Infinity;
  for (const g of run.goals) {
    if (g.actual === null) return -Infinity;
    const room =
      g.goal.max > 0 ? (g.goal.max - g.actual) / g.goal.max : g.goal.max - g.actual;
    m = Math.min(m, room);
  }
  return m;
}

/** What `measureWindow` reads off a window's tally. */
export interface WindowFigures {
  loss: number | null;
  keptUp: number | null;
  p95: number | null;
  p99: number | null;
  lostWrites: number | null;
  lostJobs: number | null;
  queueDepth: number | null;
  goals: GoalOutcome[];
  outcome: RunResult['outcome'];
}

/**
 * Measure goals over a stopped tally, as the check does. `writes` and `jobs`
 * say whether the run played `SETTLE_MS` past the window so lost writes or
 * lost jobs can be counted; `queueDepth` is read by the caller at the
 * window's end, since a tally does not hold it.
 */
export function measureWindow(
  goals: readonly Goal[],
  tally: RunTally,
  extras: { writes: boolean; jobs: boolean; queueDepth: number | null },
): WindowFigures {
  const lostWrites = extras.writes ? tally.writesAcked - tally.writesLanded : null;
  const lostJobs = extras.jobs ? tally.jobsFailed : null;
  const queueDepth = extras.queueDepth;

  const sorted = tally.latencies.slice().sort();
  const settled = tally.completed + tally.failed;
  const p95 = nearestRank(sorted, 0.95);
  const p99 = nearestRank(sorted, 0.99);
  const loss = settled > 0 ? tally.failed / settled : null;
  const outcomes = goals.map((goal) => {
    const actual = isRouteGoal(goal)
      ? measure(goal, routeFigures(tally.byRoute[goal.route]))
      : measure(goal, { p95, p99, loss, lostWrites, lostJobs, queueDepth });
    return { goal, actual, met: actual !== null && actual <= goal.max };
  });
  // The gates read what the goals read: when every goal names a client, a
  // backlog from some other client is not this run's failure.
  const gate = gateOf(goals, tally);
  const keptUp =
    gate.arrived > 0 ? (gate.completed + gate.failed) / gate.arrived : null;
  const outcome: RunResult['outcome'] =
    gate.completed === 0
      ? 'nothing-completed'
      : keptUp !== null && keptUp < KEPT_UP_FLOOR
        ? 'falling-behind'
        : outcomes.every((g) => g.met)
          ? 'passed'
          : 'goal-missed';
  return {
    loss,
    keptUp,
    p95,
    p99,
    lostWrites,
    lostJobs,
    queueDepth,
    goals: outcomes,
    outcome,
  };
}

/**
 * Advance to exactly `untilMs`, in frames, with the last one cut short to
 * land on it. A tally started or stopped there then covers the same span
 * of simulated time whatever the frame size, which is what lets a replay at
 * any step size count the same requests.
 */
export function* playTo(
  engine: Engine,
  untilMs: number,
  frameMs: number,
  endMs: number,
): Generator<number, void, void> {
  let frames = 0;
  while (untilMs - engine.now > 1e-9) {
    engine.advance(Math.min(frameMs, untilMs - engine.now));
    if (++frames % CHECK_SLICE_FRAMES === 0) yield engine.now / endMs;
  }
}

/**
 * Play one seed of the judged design and measure its window. Yields between
 * slices; returns the result.
 */
export function* playRun(
  challenge: Challenge,
  judged: Topology,
  seed: number,
  frameMs: number = CHECK_FRAME_MS,
): Generator<number, RunResult, void> {
  const warmupMs = (challenge.warmupS ?? DEFAULT_WARMUP_S) * 1000;
  const windowMs = (challenge.windowS ?? DEFAULT_WINDOW_S) * 1000;
  const endMs = warmupMs + windowMs;
  const writes = challenge.goals.some((g) => g.metric === 'lostWrites');
  const jobs = challenge.goals.some((g) => g.metric === 'lostJobs');
  const settle = writes || jobs;
  const lastMs = endMs + (settle ? SETTLE_MS : 0);
  const engine = new Engine(judged, seed);
  yield* playTo(engine, warmupMs, frameMs, lastMs);
  engine.startTally();
  yield* playTo(engine, endMs, frameMs, lastMs);
  engine.stopTally();
  const queueDepth = deepestQueue(engine, judged);
  if (settle) yield* playTo(engine, lastMs, frameMs, lastMs);
  const tally = engine.readTally();
  // Started just above, and only reset() clears one.
  if (tally === null) throw new Error('tally missing after a run');
  const m = measureWindow(challenge.goals, tally, { writes, jobs, queueDepth });
  return {
    seed,
    arrived: tally.arrived,
    completed: tally.completed,
    failed: tally.failed,
    failuresByReason: tally.failuresByReason,
    ...m,
    replay: { ...judged, seed },
  };
}

/* ---------------- the check ---------------- */

/**
 * Check a design against a brief, in slices. Each `next()` plays about half
 * a simulated second and yields how far along the check is; the return value
 * is the verdict. Over budget and unjudgeable designs return before any run.
 * The first seed that fails decides, and the seeds after it are not played.
 */
export function* checkDesign(
  challenge: Challenge,
  design: Topology,
  opts: { start?: Topology; frameMs?: number } = {},
): Generator<CheckProgress, Verdict, void> {
  const start = opts.start ?? startDesign(challenge);
  const { topology: judged, unjudgeable } = judgedTopology(challenge, design, start);
  const key = designKey(challenge, judged);
  const budget = slotBudget(challenge, judged, start);
  if (unjudgeable !== null) {
    return { status: 'unjudgeable', designKey: key, budget, why: unjudgeable };
  }
  if (budget !== null && budget.used > budget.allowed) {
    return { status: 'over-budget', designKey: key, budget };
  }

  const runs: RunResult[] = [];
  const seeds = CHECK_SEEDS.length;
  for (let i = 0; i < seeds; i++) {
    const play = playRun(challenge, judged, CHECK_SEEDS[i], opts.frameMs);
    let step = play.next();
    while (!step.done) {
      yield { run: i, done: (i + step.value) / seeds };
      step = play.next();
    }
    const run = step.value;
    runs.push(run);
    if (run.outcome !== 'passed') {
      return { status: run.outcome, designKey: key, budget, runs, deciding: run };
    }
  }
  let deciding = runs[0];
  for (const r of runs) if (margin(r) < margin(deciding)) deciding = r;
  return { status: 'passed', designKey: key, budget, runs, deciding };
}

/** Run a whole check at once. For tests and scripts; the interface slices it. */
export function judge(
  challenge: Challenge,
  design: Topology,
  opts: { start?: Topology; frameMs?: number } = {},
): Verdict {
  const it = checkDesign(challenge, design, opts);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}
