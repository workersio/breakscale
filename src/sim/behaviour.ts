/**
 * Component behaviour registry.
 *
 * Every kind-specific decision the event loop needs to make lives here, in one
 * object per NodeKind. The engine itself is kind-agnostic: it resolves a node's
 * behaviour once, at buildNodes() time, into a direct object reference on the
 * node's runtime state, and from then on the hot path only ever calls methods
 * through that reference -- never a map lookup, never a `kind === ...` test.
 *
 * Adding a new component kind is therefore: add the name to NodeKind, add a
 * defaultConfig entry, and add one behaviour object to BEHAVIOURS below. No
 * edit to the event loop.
 *
 * The `ctx` argument is the engine, narrowed to the small surface a behaviour
 * is allowed to touch (BehaviourCtx). Keeping it an interface rather than the
 * Engine class both documents that surface and stops a behaviour reaching into
 * scheduling internals it has no business knowing about.
 */
import type { EdgeState, FailureReason, NodeKind, NodeStats, SimEdge } from './types';
import type { BehaviourCtx, ReqLike, NodeStateLike } from './engine-types';
import { DATA_BEHAVIOURS } from './behaviour-data';
import { EDGE_BEHAVIOURS } from './behaviour-edge';
import { CONTROL_BEHAVIOURS } from './behaviour-control';
import { STORE_BEHAVIOURS } from './behaviour-store';
import { MESSAGING_BEHAVIOURS } from './behaviour-messaging';
import { RESILIENCE_BEHAVIOURS } from './behaviour-resilience';

/**
 * What a node does with a request offered to it.
 *
 * - 'shed'    the node refused it; the engine books a shed and fails the call.
 * - 'serve'   put it through the normal slot/queue discipline.
 * - 'passthru' zero-capacity hand-off: draw a service time but never queue.
 * - 'handled'  the behaviour fully handled admission itself (queue does this,
 *              because it acks the caller and buffers a detached copy).
 */
export type AdmitAction = 'shed' | 'serve' | 'passthru' | 'handled';

/**
 * How a node fans its work out to its downstream neighbours.
 *
 * - 'all'   call every outgoing edge and join the results (service, db, ...).
 * - 'one'   pick a single edge (load balancer).
 * - 'none'  do not call downstream at all; resolve here.
 */
export type RouteMode = 'all' | 'one' | 'none';

/**
 * What happens once a node has finished its own service time.
 *
 * - 'downstream' proceed to routing (the default).
 * - 'complete'   answer right here without calling downstream (a cache hit).
 */
export type CompleteAction = 'downstream' | 'complete';

/** How a node's waiting work is drained when a slot frees up. */
export type PumpMode =
  /** Serve from this node's own FIFO. */
  | 'own'
  /** Pull messages out of the queue nodes that feed this node. */
  | 'sources'
  /** Nothing to pump: the node holds no work of its own. */
  | 'none';

export interface ComponentBehaviour {
  kind: NodeKind;

  /* ---- static traits, read directly on the hot path ---- */

  /**
   * Does this node occupy server slots and report a meaningful utilisation?
   * A queue is a buffer, not a server: its slots mean nothing, so it reports 0.
   */
  servesRequests: boolean;
  /** Does this node generate root requests (a traffic source)? */
  generatesLoad: boolean;
  /**
   * Is every edge leaving this kind a CONTROL edge rather than a request path?
   *
   * True for the autoscaler, whose outgoing edge names the node it resizes and
   * has never carried traffic. Declaring it here means the engine can keep
   * control edges out of routing structurally -- they are not in `state.out`
   * at all -- instead of relying on each such kind to refuse traffic at
   * admission, which only worked because the autoscaler happened to be a leaf
   * and would have quietly failed for a controller wired mid-graph.
   *
   * An edge may also be marked `control` individually on the topology; the two
   * are ORed. This trait covers the kinds where it is true by construction, so
   * no existing preset has to be edited to get the right behaviour.
   */
  controlsTarget?: boolean;
  /** Does this node pull work from buffering nodes rather than being pushed to? */
  pullsFromQueues: boolean;
  /**
   * Does this node hold messages for pull-based consumers to drain? This is
   * what makes an edge between it and a consumer a pull source rather than an
   * ordinary downstream call.
   */
  buffersForConsumers: boolean;
  /** How waiting work is drained when capacity frees up. */
  pump: PumpMode;
  /**
   * When a fan-out join completes at this node, does it book its own
   * completion/latency? A client does not: resolve() already credits the root
   * request end-to-end, and counting it twice would double every request.
   */
  creditsJoinCompletion: boolean;
  /**
   * Should the engine report downstream call outcomes back to this node via
   * onDownstreamResult? False for every kind that does not care, which keeps
   * the join path free of an optional-hook check for the common case.
   */
  observesOutcome?: boolean;

  /* ---- per-request hooks ---- */

  /** Decide what admission means for this kind. Defaults to 'serve'. */
  onAdmit?(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction;
  /** Fan-out policy. Defaults to 'all'. */
  route?(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): RouteMode;
  /** Choose the single edge when route() returned 'one'. */
  pickEdge?(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    req: ReqLike,
    out: SimEdge[],
  ): SimEdge | null;
  /**
   * FailureReason to use when this kind's pickEdge() declines to choose an
   * edge. Declining is normally a wiring mistake ('no-route', the default),
   * but for some kinds it is a deliberate state worth naming: a region node
   * with no healthy region reports 'region-down'. A plain field rather than a
   * hook, because it is a fixed property of the kind, and reading it costs one
   * field load on a path that has already failed.
   */
  noRouteReason?: FailureReason;

  /**
   * How full this node is, as (in service + waiting) / slots, for a kind that
   * runs its own slot pool in `ext`. The least-loaded edge picker reads
   * `state.busy` and the engine's waiting list, which such a kind leaves at
   * zero, so without this every one of them looks idle and a load balancer
   * sends all traffic to the first. Absent for kinds the engine already
   * measures. Must be a pure read: no RNG, no state change.
   */
  load?(ctx: BehaviourCtx, state: NodeStateLike): number;

  /**
   * Which NodeConfig knob a controller moves to make this kind BIGGER, and
   * which the engine reads back to say how big it currently is.
   *
   * This is the fleet count, not the slot count. For a kind with an instance
   * model the answer is `instances`: an autoscaler adds machines and leaves
   * `capacity` (the size of one machine) alone, which is both what a real one
   * does and the only reading under which the drawn stack and the
   * controller's steps describe the same thing.
   *
   * A kind that scales along a different axis must say so, and the reason is
   * concrete: a sharded store serves from `shardCapacity` slots *per shard*
   * and ignores `instances` entirely, so a controller writing `instances` at
   * it would ramp to maxCapacity while changing nothing at all -- which looks
   * to a student like a controller that simply does not work.
   *
   * Declared as a trait rather than tested for by kind, so the engine's
   * setScale() stays kind-agnostic.
   *
   * Absent means this kind cannot be scaled by a controller at all (a queue,
   * a breaker, a client): scaleOf() reports null and setScale() is a no-op,
   * rather than silently inventing a fleet for a thing that has none.
   */
  scaleField?: 'instances' | 'shardCapacity';
  /**
   * Called after the node's own service time elapsed and its independent error
   * roll passed. Returning 'complete' answers the call here.
   */
  onServiceComplete?(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    req: ReqLike,
  ): CompleteAction;
  /**
   * Autonomous per-tick work for kinds that act without a request arriving
   * (a future autoscaler or circuit breaker). Nothing uses it yet; the engine
   * only walks the tick list if at least one node declares it, so the cost of
   * having the seam is exactly zero until something fills it.
   */
  onTick?(ctx: BehaviourCtx, state: NodeStateLike, dtMs: number): void;

  /**
   * Build this kind's private scratch state, stored on `state.ext`. Called
   * once per node before anything can run, and again for a node created
   * after a reset(); never on the hot path. A kind with no state of its own
   * omits it and `ext` stays null.
   *
   * Config is deliberately not snapshotted here: a student can move a slider
   * mid-run, so a behaviour reads `state.config` fresh each time it needs it.
   */
  initState?(state: NodeStateLike): unknown;

  /**
   * Called when a downstream call issued by this node resolves, before the
   * result is joined. This is the feedback path a circuit breaker needs: it
   * is the only place a node learns whether its dependency is healthy.
   *
   * Purely observational -- the return value is ignored and the outcome is
   * joined exactly as it would have been. Only called for nodes whose
   * behaviour sets `observesOutcome`, so nothing pays for it by default.
   */
  onDownstreamResult?(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    req: ReqLike,
    ok: boolean,
    reason: FailureReason,
  ): void;
  /** A behaviour-owned timer for a request it held during admission. */
  onWake?(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void;

  /**
   * Publish this kind's own readouts onto its NodeStats entry at snapshot
   * time. Keeps kind-specific reporting out of the engine's snapshot loop the
   * same way the other hooks keep it out of the event loop. Only called for
   * behaviours that declare it.
   */
  decorateStats?(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void;

  /* ---- instance model ---- */

  /**
   * Is this kind really N things rather than one, and if so what is a unit?
   *
   *  - 'slots'  one unit per capacity slot. The engine derives the count and
   *             the per-unit waterline itself; the behaviour writes nothing.
   *  - 'custom' the kind knows its own structure and publishes it from
   *             reportInstances() -- a shard's partitions, a replica set's
   *             primary-plus-replicas.
   *  - absent   not an instance model. NodeStats.instances stays undefined.
   *
   * A trait rather than a hook because it is a fixed property of the kind and
   * the snapshot loop reads it once per node per frame.
   *
   * The full per-kind interpretation is documented on NodeStats in types.ts;
   * that comment is the contract, this field only selects which mechanism
   * produces it.
   */
  instanceModel?: 'slots' | 'custom';

  /**
   * Publish the instance vector for an `instanceModel: 'custom'` kind. Called
   * from the snapshot loop, before decorateStats. The behaviour hands its own
   * scratch array to ctx.reportInstances(); the engine copies it, so reusing
   * one buffer per node across frames is both safe and expected.
   */
  reportInstances?(ctx: BehaviourCtx, state: NodeStateLike): void;

  /* ---- edge state ---- */

  /**
   * Classify one of this node's outgoing edges for the snapshot's edgeState
   * map -- is the node refusing to use it ('blocked'), holding it in reserve
   * ('standby'), or neither (return null and let the engine decide from flow)?
   *
   * Only kinds that can withhold traffic for a reason of their own declare it:
   * a breaker that is OPEN, a region node with one active edge and the rest on
   * standby. The engine never asks anything else, so an ordinary service pays
   * nothing for the seam.
   *
   * Must be a pure read. It runs inside snapshot(), which is observation only:
   * a behaviour that advanced its own state machine here would make the
   * simulation depend on how often the UI polled it.
   */
  edgeStateFor?(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    edge: SimEdge,
    index: number,
  ): EdgeState | null;
}

/* ------------------------------------------------------------------ *
 * Behaviour definitions
 * ------------------------------------------------------------------ */

/**
 * A traffic source. Generates root requests at `rps` and hands each one
 * straight downstream; it never queues and never occupies a slot.
 */
const client: ComponentBehaviour = {
  kind: 'client',
  servesRequests: true,
  generatesLoad: true,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,
  onAdmit: () => 'passthru',
};

/**
 * A dispatcher. Picks exactly one downstream per request: weighted-random when
 * the edge weights differ, least-loaded when they are all equal.
 *
 * Its pool is real. There is no onAdmit, so the engine's default `serve` puts
 * `capacity`, `instances` and `queueLimit` through ordinary slot and queue
 * discipline. `passthru` skipped that, which made all three knobs inert and
 * left an autoscaler writing `instances` with nothing to turn (#52).
 */
const lb: ComponentBehaviour = {
  kind: 'lb',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
  route: () => 'one',
  pickEdge: (ctx, _state, _req, out) => ctx.pickWeightedOrLeastLoaded(out),
};

/** A plain server: finite slots, a bounded FIFO, then fan-out to everything. */
const service: ComponentBehaviour = {
  kind: 'service',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
};

/**
 * A read-through cache. On a hit it answers immediately; on a miss it falls
 * through to whatever backs it, or answers anyway if nothing is wired up.
 */
const cache: ComponentBehaviour = {
  kind: 'cache',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
  onServiceComplete: (ctx, state, _req) => {
    if (ctx.roll() < clamp01(state.config.hitRate)) {
      ctx.countHit(state);
      return 'complete';
    }
    ctx.countMiss(state);
    // No backing store wired up: a miss is still answered, just slowly.
    return state.out.length === 0 ? 'complete' : 'downstream';
  },
};

/* `db` lives in behaviour-store.ts with the other stores: it runs the
 * shared costed pool there, with write lock contention as its own
 * mechanism, and is registered via STORE_BEHAVIOURS below. */

/**
 * A buffer, not a server. It acknowledges the caller immediately (so the
 * caller's chain resolves as a success right there) and parks a detached copy
 * of the message for the workers to drain. Its "busy" count is meaningless, so
 * it reports zero utilisation.
 */
const queue: ComponentBehaviour = {
  kind: 'queue',
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: true,
  pump: 'none',
  creditsJoinCompletion: true,
  onAdmit: (ctx, state, req) => {
    if (ctx.queueDepth(state) >= ctx.effectiveQueueLimit(state)) return 'shed';
    ctx.ackAndBuffer(state, req);
    return 'handled';
  },
};

/**
 * A consumer. It is never pushed to: it pulls the oldest available message
 * across every queue node feeding it, which keeps the draw order deterministic
 * regardless of which queue was written to last.
 */
const worker: ComponentBehaviour = {
  kind: 'worker',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: true,
  buffersForConsumers: false,
  pump: 'sources',
  creditsJoinCompletion: true,
};

const ALL: ComponentBehaviour[] = [
  client,
  lb,
  service,
  cache,
  queue,
  worker,
  ...EDGE_BEHAVIOURS,
  ...CONTROL_BEHAVIOURS,
];
// Data-tier kinds (replica, shard) live in their own module: both carry real
// internal machinery, and keeping it there leaves this file declarative.
ALL.push(...DATA_BEHAVIOURS);
// Stores (db, object storage, search, time-series, graph, cold storage,
// vector) likewise: each carries a mechanism of its own, and five of the
// seven run the shared self-managed costed pool.
ALL.push(...STORE_BEHAVIOURS);
// Messaging and coordination kinds (streambroker, pubsub, websocket,
// apigateway, sidecar, lambda, cron): the glue between services. Same deal;
// real machinery lives in its own module, the registry stays declarative.
ALL.push(...MESSAGING_BEHAVIOURS);
// Resilience and delivery kinds (bulkhead, retryqueue, transcoder,
// edgecompute, writebehind, loadshedder): the failure-handling tier.
ALL.push(...RESILIENCE_BEHAVIOURS);

const BY_KIND = new Map<NodeKind, ComponentBehaviour>();
for (const b of ALL) BY_KIND.set(b.kind, b);

/**
 * Resolve a kind's behaviour. Called once per node at buildNodes() time and
 * cached on the node state; never called from the event loop.
 */
export function behaviourFor(kind: NodeKind): ComponentBehaviour {
  const b = BY_KIND.get(kind);
  if (b) return b;
  // An unknown kind degrades to plain-server semantics rather than throwing,
  // so a topology saved by a newer build still loads.
  return service;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
