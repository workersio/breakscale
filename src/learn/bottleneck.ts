import { behaviourFor } from '../sim/behaviour';
import type {
  ActiveFailure,
  NodeKind,
  NodeStats,
  SimNode,
  SimSnapshot,
  Topology,
} from '../sim/types';
import { heldShare, sourceBacklogs } from '../components/Canvas';
import { formatCount, formatMs, formatPct, formatRateBare } from '../components/format';
import { formatFactor } from '../components/faultWiring';

/**
 * "Find the problem": which one part is holding the system back right now,
 * and why, in a sentence a student can act on.
 *
 * Read from one snapshot and nothing else. Every number in the sentence is a
 * field of that snapshot, so the answer can be checked against the canvas.
 * The rules follow what the readouts already teach:
 *
 *  - A part is struggling when every slot is taken and work is waiting for
 *    one, or when it is turning work away that it did not choose to refuse.
 *  - A caller whose slots are mostly waiting on its calls is not the cause
 *    when something it calls is struggling too. It is the queue behind it.
 *  - A caller giving up (timeouts) is a symptom; the part it gave up on is
 *    the answer.
 *  - A limiter or shedder refusing work is doing its job, so it is never
 *    called the problem.
 *  - A fault the student injected is named first, because it is the cause
 *    they set up.
 */

export type Verdict =
  /** Something is holding the system back. Drawn on the canvas. */
  | { kind: 'problem'; nodeId: string; text: string }
  /** Nothing is struggling, but a gate is refusing work as designed. */
  | { kind: 'on-purpose'; nodeId: string; text: string }
  /** Nothing is struggling. `nodeId` is the busiest part, when there is one. */
  | { kind: 'healthy'; nodeId: string | null; text: string }
  /** No traffic, so there is nothing to judge. */
  | { kind: 'idle'; text: string };

/** Share of slots taken at which a part counts as full. */
export const FULL = 0.95;
/** Below this many per second a refusal or timeout rate is noise. */
export const MIN_RATE = 0.5;
/** System error rate past which "nothing is full" needs a second sentence. */
const ERRORS_WORTH_NAMING = 0.01;

/** Kinds whose refusals are their purpose, never a sign of trouble. */
const GATES: ReadonlySet<NodeKind> = new Set([
  'ratelimiter',
  'apigateway',
  'loadshedder',
  'breaker',
  'sidecar',
  'bulkhead',
]);

/** Kinds that serve nothing, so cannot fill up. */
const NEVER_FULL: ReadonlySet<NodeKind> = new Set([
  'client',
  'autoscaler',
  'region',
  'cron',
  'pubsub',
  ...GATES,
]);

/** Kinds that hold work for someone else to read, so their depth is not their own load. */
const BUFFERS: ReadonlySet<NodeKind> = new Set(['queue', 'streambroker', 'retryqueue']);

/** Kinds whose slots are `capacity * instances` and can be counted in words. */
const COUNTED_SLOTS: ReadonlySet<NodeKind> = new Set([
  'service',
  'worker',
  'db',
  'cache',
  'lb',
  'cdn',
]);

export interface Reading {
  node: SimNode;
  s: NodeStats;
  /** 0..1 share of the part's capacity in use, held slots included. */
  fill: number;
  /** Requests waiting for a slot, or in the buffers it pulls from. */
  line: number;
  /** Work refused per second that the part did not choose to refuse. */
  refused: number;
  /** Requests this part gave up on per second (caller timeouts). */
  gaveUp: number;
  struggling: boolean;
}

function fillOf(node: SimNode, s: NodeStats): number {
  const util = clamp01(s.utilization);
  switch (node.kind) {
    case 'shard':
      return clamp01(s.maxShardUtilization);
    case 'replica':
      return Math.max(util, ...(s.perInstance ?? []));
    case 'lambda':
      return ratio(s.runningNow ?? 0, node.config.maxConcurrency ?? 0);
    case 'websocket':
      return ratio(s.connectionsOpen ?? 0, s.maxConnections ?? 0);
    default:
      return NEVER_FULL.has(node.kind) || BUFFERS.has(node.kind)
        ? 0
        : heldShare(s, node.config, util);
  }
}

/** `capacity * instances` for the kinds that count slots, else null. */
export function slotsOf(node: SimNode, s: NodeStats): number | null {
  if (!COUNTED_SLOTS.has(node.kind)) return null;
  return (
    node.config.capacity *
    Math.max(1, Math.floor(s.instances ?? node.config.instances ?? 1))
  );
}

function refusedOf(node: SimNode, s: NodeStats): number {
  // A client "sheds" what the part it calls would not take; that part is the answer.
  if (GATES.has(node.kind) || node.kind === 'client') return 0;
  return (
    s.shedRate +
    (s.slowdownRate ?? 0) +
    (node.kind === 'lambda' || node.kind === 'coldstorage'
      ? (s.throttledRate ?? 0)
      : 0) +
    (s.connectionRejectRate ?? 0) +
    (s.retentionDropRate ?? 0) +
    (s.flushFailRate ?? 0)
  );
}

export function readParts(topology: Topology, snapshot: SimSnapshot): Reading[] {
  const backlogs = sourceBacklogs(topology, snapshot.nodes);
  const out: Reading[] = [];
  for (const node of topology.nodes) {
    const s = snapshot.nodes[node.id];
    if (!s) continue;
    const fill = fillOf(node, s);
    const pulls = behaviourFor(node.kind).pullsFromQueues;
    const line = pulls ? (backlogs.get(node.id) ?? 0) : s.queued;
    const refused = refusedOf(node, s);
    // A buffer that sheds or lags is full because its readers are behind;
    // they are the answer, so the buffer itself is never a candidate.
    const isBuffer =
      BUFFERS.has(node.kind) || behaviourFor(node.kind).buffersForConsumers;
    // A part near its limit has a short line now and then that clears within
    // one round of work; measured at the starting load of two examples (2 of
    // 9, 3 of 8). The line counts once it holds half a round, or a whole one
    // for a puller, which always has jobs queued behind its slots.
    const slots =
      node.config.capacity *
      Math.max(1, Math.floor(s.instances ?? node.config.instances ?? 1));
    const lineFloor = Math.max(1, pulls ? slots : slots / 2);
    out.push({
      node,
      s,
      fill,
      line,
      refused,
      gaveUp: s.timeoutRate,
      struggling:
        !isBuffer && (refused >= MIN_RATE || (fill >= FULL && line >= lineFloor)),
    });
  }
  return out;
}

/** Request edges only: control edges carry no work. */
function callees(topology: Topology, id: string): string[] {
  const kindOf = new Map(topology.nodes.map((n) => [n.id, n.kind]));
  const out: string[] = [];
  for (const e of topology.edges) {
    if (e.control || e.from !== id) continue;
    const from = kindOf.get(e.from);
    if (from && behaviourFor(from).controlsTarget) continue;
    out.push(e.to);
  }
  return out;
}

function callers(topology: Topology, id: string): string[] {
  return topology.edges.filter((e) => !e.control && e.to === id).map((e) => e.from);
}

/** Every part reachable through request edges from `id`, nearest first. */
function downstream(topology: Topology, id: string): string[] {
  const seen = new Set([id]);
  const order: string[] = [];
  let frontier = [id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const c of callees(topology, f)) {
        if (seen.has(c)) continue;
        seen.add(c);
        order.push(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return order;
}

/** Waiting on its calls more than working, so its fill is borrowed. */
export function mostlyWaiting(r: Reading): boolean {
  return (r.s.waitingOnDownstream ?? 0) > r.s.inFlight;
}

export function findBottleneck(topology: Topology, snapshot: SimSnapshot): Verdict {
  const readings = readParts(topology, snapshot);
  const byId = new Map(readings.map((r) => [r.node.id, r]));

  if (!(snapshot.system.offeredRps > 0)) {
    return {
      kind: 'idle',
      text: 'No traffic is flowing, so nothing can struggle yet.',
    };
  }

  // 1. A fault the student injected is the cause they set up.
  const fault = pickFault(snapshot.activeFailures, byId);
  if (fault) {
    const r = byId.get(fault.nodeId);
    if (r)
      return {
        kind: 'problem',
        nodeId: r.node.id,
        text: faultText(fault, r, topology, byId),
      };
  }

  // 2. Struggling parts, minus callers that only wait on a struggling callee.
  const struggling = readings.filter((r) => r.struggling);
  const roots = struggling.filter((r) => {
    if (!mostlyWaiting(r)) return true;
    return !downstream(topology, r.node.id).some((id) => byId.get(id)?.struggling);
  });
  roots.sort((a, b) => b.refused - a.refused || b.fill - a.fill || b.line - a.line);
  const root = roots[0];
  if (root) {
    return {
      kind: 'problem',
      nodeId: root.node.id,
      text: struggleText(root, topology, byId),
    };
  }

  // A log losing messages: some reader is slower than the writers. The log
  // cannot say which group, so it is the part named.
  const log = readings
    .filter(
      (r) => r.node.kind === 'streambroker' && (r.s.retentionDropRate ?? 0) >= MIN_RATE,
    )
    .sort((a, b) => (b.s.retentionDropRate ?? 0) - (a.s.retentionDropRate ?? 0))[0];
  if (log) {
    return {
      kind: 'problem',
      nodeId: log.node.id,
      text: `${log.node.label}: its slowest reader is ${formatCount(log.s.consumerLag ?? log.s.queued)} messages behind, and ${rate(log.s.retentionDropRate ?? 0)} a second expire before they are read.`,
    };
  }

  // 3. A caller giving up, or stuck waiting, on something that is merely slow.
  const stuck = readings
    .filter((r) => r.gaveUp >= MIN_RATE || (r.struggling && mostlyWaiting(r)))
    .sort((a, b) => b.gaveUp - a.gaveUp);
  for (const caller of stuck) {
    const slowest = callees(topology, caller.node.id)
      .map((id) => byId.get(id))
      .filter((r): r is Reading => r !== undefined && r.s.p99 > 0)
      .sort((a, b) => b.s.p99 - a.s.p99)[0];
    if (!slowest) continue;
    const blame =
      caller.gaveUp >= MIN_RATE
        ? `${caller.node.label} is giving up on it, ${rate(caller.gaveUp)} timeouts a second.`
        : `${caller.node.label} has every slot waiting on it.`;
    return {
      kind: 'problem',
      nodeId: slowest.node.id,
      text: `${slowest.node.label} is slow to answer, p99 ${formatMs(slowest.s.p99)}. ${blame}`,
    };
  }

  // 4. Nothing is struggling. A gate refusing work is doing its job.
  const gate = readings
    .map((r) => ({ r, n: gateRefusals(r) }))
    .filter((g) => g.n >= MIN_RATE)
    .sort((a, b) => b.n - a.n)[0];
  if (gate) {
    return {
      kind: 'on-purpose',
      nodeId: gate.r.node.id,
      text: `Nothing is full. ${gate.r.node.label} is turning away ${rate(gate.n)} a second on purpose, which is its job.`,
    };
  }

  const busiest = readings.filter((r) => r.fill > 0).sort((a, b) => b.fill - a.fill)[0];
  const base = busiest
    ? `Nothing is struggling right now. The busiest part is ${busiest.node.label} at ${formatPct(busiest.fill)}.`
    : 'Nothing is struggling right now.';

  // Errors with nothing full: name where they come from rather than hide them.
  if (snapshot.system.errorRate >= ERRORS_WORTH_NAMING) {
    const failing = readings
      .filter((r) => r.node.kind !== 'client' && r.s.errorRate > 0)
      .sort((a, b) => b.s.errorRate - a.s.errorRate)[0];
    if (failing) {
      return {
        kind: 'problem',
        nodeId: failing.node.id,
        text: `Nothing is full, but ${failing.node.label} is failing ${formatPct(failing.s.errorRate)} of its requests.`,
      };
    }
  }

  return { kind: 'healthy', nodeId: busiest?.node.id ?? null, text: base };
}

/* ---------------- the sentences ---------------- */

/** "all 6 slots busy, 34 waiting in line", or the closest honest phrase for the kind. */
export function stateClause(
  r: Reading,
  byId: ReadonlyMap<string, Reading>,
  topology: Topology,
): string {
  const parts: string[] = [];
  if (r.fill >= FULL) {
    const slots = slotsOf(r.node, r.s);
    const held = r.s.waitingOnDownstream ?? 0;
    if (slots !== null && held >= 1 && clamp01(r.s.utilization) < FULL) {
      // Full only because calls hold slots: the box reads busy as the working
      // share alone, so a bare "all busy" would contradict it.
      parts.push(
        `all ${formatCount(slots)} slots taken, ${formatCount(r.s.inFlight)} working and ${formatCount(held)} waiting on its calls`,
      );
    } else if (slots !== null) {
      parts.push(`all ${formatCount(slots)} slots busy`);
    } else if (r.node.kind === 'shard') {
      parts.push(`its busiest partition is at ${formatPct(r.fill)}`);
    } else if (r.node.kind === 'lambda') {
      parts.push(
        `all ${formatCount(r.node.config.maxConcurrency ?? 0)} copies running`,
      );
    } else if (r.node.kind === 'websocket') {
      parts.push(`all ${formatCount(r.s.maxConnections ?? 0)} connections in use`);
    } else {
      parts.push(`${formatPct(r.fill)} busy`);
    }
  }
  if (r.line >= 1) {
    if (behaviourFor(r.node.kind).pullsFromQueues) {
      const feed = feedingBuffer(r, byId, topology);
      parts.push(
        `${formatCount(r.line)} waiting in ${feed ? feed.node.label : 'line'}`,
      );
    } else {
      parts.push(`${formatCount(r.line)} waiting in line`);
    }
  }
  if (r.refused >= MIN_RATE) parts.push(`turning away ${rate(r.refused)} a second`);
  return parts.join(', ');
}

function struggleText(
  r: Reading,
  topology: Topology,
  byId: ReadonlyMap<string, Reading>,
): string {
  return `${r.node.label}: ${stateClause(r, byId, topology)}.${feedText(r, topology, byId)}${upstreamText(r, topology, byId)}`;
}

/** For a part that pulls from a buffer: is that buffer overflowing, or still filling? */
function feedText(
  r: Reading,
  topology: Topology,
  byId: ReadonlyMap<string, Reading>,
): string {
  if (!behaviourFor(r.node.kind).pullsFromQueues) return '';
  const feed = feedingBuffer(r, byId, topology);
  if (!feed) return '';
  if (feed.s.shedRate >= MIN_RATE) {
    return ` ${feed.node.label} is full and turning away ${rate(feed.s.shedRate)} a second.`;
  }
  // A queue's own "out" counts what it accepted, so the drain rate is the
  // reader's. Only stated when this part is the buffer's one reader.
  const readers = neighbours(topology, feed.node.id).filter(
    (id) =>
      byId.get(id) && behaviourFor(byId.get(id)?.node.kind ?? 'client').pullsFromQueues,
  );
  if (readers.length === 1 && feed.s.arrivalRate > r.s.throughput + MIN_RATE) {
    return ` ${feed.node.label} takes in ${rate(feed.s.arrivalRate)} a second but only ${rate(r.s.throughput)} a second get done, so the line keeps growing.`;
  }
  return '';
}

/** Who is stuck behind this part, when someone measurably is. */
function upstreamText(
  r: Reading,
  topology: Topology,
  byId: ReadonlyMap<string, Reading>,
): string {
  const behind = callers(topology, r.node.id)
    .map((id) => byId.get(id))
    .filter((c): c is Reading => c !== undefined);
  const givingUp = behind
    .filter((c) => c.gaveUp >= MIN_RATE)
    .sort((a, b) => b.gaveUp - a.gaveUp)[0];
  if (givingUp) {
    return ` ${givingUp.node.label} is giving up on it, ${rate(givingUp.gaveUp)} timeouts a second.`;
  }
  const waiting = behind
    .filter((c) => (c.s.waitingOnDownstream ?? 0) >= 1)
    .sort((a, b) => (b.s.waitingOnDownstream ?? 0) - (a.s.waitingOnDownstream ?? 0))[0];
  if (waiting) {
    return ` ${waiting.node.label} is stuck behind it, with ${formatCount(waiting.s.waitingOnDownstream)} requests waiting on its calls.`;
  }
  return '';
}

function feedingBuffer(
  r: Reading,
  byId: ReadonlyMap<string, Reading>,
  topology: Topology,
): Reading | undefined {
  let best: Reading | undefined;
  for (const id of neighbours(topology, r.node.id)) {
    const b = byId.get(id);
    if (!b || !behaviourFor(b.node.kind).buffersForConsumers) continue;
    if (!best || b.s.queued > best.s.queued) best = b;
  }
  return best;
}

/** Parts wired to `id` in either direction, as a puller and its buffer may be drawn. */
function neighbours(topology: Topology, id: string): string[] {
  const near = new Set<string>();
  for (const e of topology.edges) {
    if (e.control) continue;
    if (e.to === id) near.add(e.from);
    if (e.from === id) near.add(e.to);
  }
  return [...near];
}

/** The fault worth naming: one on a struggling part first, else the oldest. */
function pickFault(
  failures: readonly ActiveFailure[],
  byId: ReadonlyMap<string, Reading>,
): ActiveFailure | undefined {
  return (
    failures.find((f) => byId.get(f.nodeId)?.struggling) ??
    [...failures].sort((a, b) => a.sinceMs - b.sinceMs)[0]
  );
}

function faultText(
  f: ActiveFailure,
  r: Reading,
  topology: Topology,
  byId: ReadonlyMap<string, Reading>,
): string {
  const name = r.node.label;
  switch (f.kind) {
    case 'crash':
      return `${name}: you crashed it, so everything sent to it fails.`;
    case 'errors':
      return `${name}: you made it fail ${formatPct(f.rate ?? 0)} of requests.`;
    case 'partition': {
      const cut = f.edgeIds?.length ?? 0;
      return `${name}: you cut ${cut === 1 ? 'one of its links' : `${cut} of its links`}, so requests across them fail.`;
    }
    case 'crash-instance':
    case 'slow': {
      const did =
        f.kind === 'slow'
          ? `you slowed it ${formatFactor(f.factor ?? 1)}`
          : 'you crashed one of its machines';
      if (!r.struggling) {
        return `${name}: ${did}, and it is keeping up for now.`;
      }
      return `${name}: ${did}. Now ${stateClause(r, byId, topology)}.${feedText(r, topology, byId)}${upstreamText(r, topology, byId)}`;
    }
  }
}

/* ---------------- small helpers ---------------- */

function gateRefusals(r: Reading): number {
  if (!GATES.has(r.node.kind)) return 0;
  const s = r.s;
  return (
    (s.throttledRate ?? 0) +
    (s.authRejectRate ?? 0) +
    (s.lowSheddedRate ?? 0) +
    (s.highSheddedRate ?? 0) +
    (s.rejectedRate ?? 0) +
    (s.bulkheadRejectedRate ?? 0)
  );
}

function rate(n: number): string {
  return formatRateBare(n);
}

function clamp01(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function ratio(n: number, d: number): number {
  return d > 0 ? clamp01(n / d) : 0;
}
