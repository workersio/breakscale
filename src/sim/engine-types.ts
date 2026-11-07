/**
 * Structural types shared between the engine and the behaviour registry.
 *
 * They live in their own module so behaviour.ts can describe what it is handed
 * without importing the Engine class (which imports behaviour.ts back). The
 * engine's real NodeState and Req satisfy these interfaces structurally, so no
 * casting or adapter layer is needed at the call sites.
 */
import type { FailureReason, NodeConfig, NodeKind, SimEdge } from './types';

/** The engine's per-node runtime state, as far as a behaviour may see it. */
export interface NodeStateLike {
  readonly id: string;
  readonly kind: NodeKind;
  readonly config: NodeConfig;
  /** Requests occupying a server slot right now. */
  readonly busy: number;
  /**
   * Requests whose own work is done but which still hold their slot, because
   * this kind blocks on its downstream calls and those have not all answered.
   * A kind that keeps its slots in `ext` counts them there as well; this is
   * how much of that count is waiting rather than working. Always 0 for a
   * kind whose `blocksOnDownstream` is false.
   */
  readonly parked: number;
  /** Outgoing edges, resolved from the topology. */
  readonly out: readonly SimEdge[];
  /** Queue nodes feeding this node, for pull-based kinds. */
  readonly sources: readonly string[];
  /**
   * Behaviour-private scratch state, created once by the behaviour's
   * initState() hook and owned entirely by that behaviour. The engine never
   * reads or interprets it -- it only allocates it at buildNodes() time and
   * drops it on reset(), which is exactly the lifecycle a token bucket or a
   * breaker state machine needs. Typed `unknown` so a behaviour must narrow
   * it to its own shape, and no behaviour can read another's.
   */
  ext: unknown;
}

/** An in-flight request, as far as a behaviour may see it. */
export interface ReqLike {
  readonly nodeId: string;
  /** Hop depth from the client root. */
  readonly hop: number;
  /** Which retry attempt this call represents at the parent. */
  readonly attempt: number;
  /** Own service time already spent at this node. */
  readonly ownMs: number;
  /** True when this is a detached queue message being drained by a worker. */
  readonly detached: boolean;
  /**
   * Partition/cache key this request concerns. Drawn by the client from a
   * small keyspace and inherited unchanged by every downstream call the
   * request makes, so a replica set or a shard several hops away sees the
   * key the client actually asked for. Kinds that do not partition by key
   * ignore it entirely.
   */
  readonly key: number;
  /**
   * True when this request is a write rather than a read. Set by the kind
   * that first classifies it (a replica set, from readFraction) and
   * inherited downstream, so a later node sees the same classification.
   */
  readonly isWrite: boolean;
}

/**
 * The slice of the engine a behaviour is allowed to drive.
 *
 * Deliberately small: a behaviour decides policy and asks the engine to carry
 * it out. Nothing here exposes the heap, the request pool, or the clock's
 * mutability, so a behaviour cannot desynchronise the simulation.
 */
export interface BehaviourCtx {
  /** Current simulated time in ms. */
  readonly now: number;

  /**
   * One draw from the deterministic RNG. Behaviours must take draws in a fixed
   * order for a given event, or replay stops matching.
   */
  roll(): number;

  /** Queued (not yet in service) request count for a node. */
  queueDepth(state: NodeStateLike): number;
  /** queueLimit floored to a non-negative integer. */
  effectiveQueueLimit(state: NodeStateLike): number;
  /**
   * How many requests this node can serve at once: `instances * capacity`,
   * floored to at least one slot. `capacity` is the slot count of one
   * instance; this is the whole node's parallelism.
   */
  effectiveCapacity(state: NodeStateLike): number;
  /** How many instances this node runs, >= 1. Absent config means one. */
  effectiveInstances(state: NodeStateLike): number;

  /** Book a cache hit / miss against a node's rolling counters. */
  countHit(state: NodeStateLike): void;
  countMiss(state: NodeStateLike): void;

  /** Queue-node admission: ack the caller and buffer a detached copy. */
  ackAndBuffer(state: NodeStateLike, req: ReqLike): void;

  /**
   * Relay-node admission: ack the caller and deliver a detached copy
   * DOWNSTREAM through this node's own slots, service time, routing and
   * retry machinery. The sibling of ackAndBuffer() for kinds that push
   * rather than being pulled from (a retry queue, a write-behind cache).
   * `extraDeliveryMs` is added to the relayed copy's service time only,
   * modelling time the message deliberately sits before delivery (a
   * write-behind flush interval). The behaviour must check its own depth
   * limit against queueDepth() before calling.
   */
  ackAndRelay(state: NodeStateLike, req: ReqLike, extraDeliveryMs?: number): void;

  /** The shared edge-selection policy: weighted-random, or least-loaded on ties. */
  pickWeightedOrLeastLoaded(out: readonly SimEdge[]): SimEdge | null;

  /** Fail a request with a reason, contributing `latencyMs` to its parent. */
  fail(req: ReqLike, reason: FailureReason, latencyMs: number): void;

  /**
   * Refuse a request at `state` with an arbitrary reason, booking it against
   * that node's error counters. This is the general form of the engine's own
   * shed path: the two differ only in which counter is credited. A behaviour
   * uses it to refuse with a reason the engine has no opinion about --
   * 'throttled' for a spent token bucket, 'rejected' for an open circuit.
   */
  reject(state: NodeStateLike, req: ReqLike, reason: FailureReason): void;

  /**
   * Resume a request a behaviour deliberately held at admission. This routes
   * it through a zero-service dispatcher without counting a second arrival.
   */
  resumeAdmission(state: NodeStateLike, req: ReqLike): void;

  /** Schedule a behaviour-owned wakeup for a held request. */
  wakeAfter(state: NodeStateLike, req: ReqLike, delayMs: number): void;

  /**
   * Book a behaviour-defined counter against a node, in events per second
   * over the engine's standard rate window. Counter names are namespaced per
   * node, so two behaviours can never collide. Read back with counterRate().
   * This exists so a behaviour can publish a readout of its own without the
   * engine growing a fixed field for every kind that wants one.
   */
  countCustom(state: NodeStateLike, name: string, n: number): void;
  /** Read back a counter booked with countCustom(), as events per second. */
  counterRate(state: NodeStateLike, name: string): number;

  /* ---- controller surface ------------------------------------------ *
   * For kinds that act ON other nodes rather than serving requests: an
   * autoscaler writes a watched node's capacity, a region node needs to
   * know whether its chosen downstream is actually alive.
   * ------------------------------------------------------------------ */

  /**
   * A node's smoothed utilisation, 0..1, or null if it does not exist.
   * This is the same figure the UI shows, so a student watching the meter
   * is watching exactly what the controller reacts to. For a kind the engine
   * slots itself it counts work only: a slot held while waiting on a
   * downstream call is not in it, which is how a CPU-target autoscaler sees a
   * server that is blocked on its database.
   */
  utilizationOf(nodeId: string): number | null;
  /**
   * How big a node's fleet is, in the unit that kind scales along: instances
   * for an ordinary server, slots-per-shard for a sharded store. Null when
   * the node does not exist, or is a kind with no fleet to move.
   */
  scaleOf(nodeId: string): number | null;
  /**
   * Resize a node's fleet, in the same unit scaleOf() reports. Applied to
   * both runtime state and the stored topology so the Inspector shows what
   * the controller did, and any work waiting on the newly freed slots starts
   * immediately. A no-op for a kind that cannot be scaled.
   */
  setScale(nodeId: string, units: number): void;
  /**
   * The node this controller drives, from its CONTROL edge, or '' when it is
   * not wired to one -- or when that edge is cut. Control edges are held
   * apart from the routing set, so this is the only way to reach a target.
   */
  controlTargetOf(state: NodeStateLike): string;
  /**
   * Is this node currently taken out by an injected 'crash'? A controller
   * must not treat a crashed node as merely idle, and a region node uses it
   * to decide the active region has failed.
   */
  isCrashed(nodeId: string): boolean;
  /** Is this edge cut by an injected 'partition'? */
  isEdgeCut(edgeId: string): boolean;

  /* ---- self-managed service ---------------------------------------- *
   *
   * For a kind whose internal structure the engine has no concept of: a
   * sharded store is N independent queue-and-server units, which cannot be
   * expressed in the single busy/waiting pair on NodeState. These let such a
   * behaviour keep its own slot bookkeeping in `ext` while still driving the
   * engine's real service timing, error roll, timeout and completion path,
   * instead of reimplementing them and drifting from the other kinds.
   * ------------------------------------------------------------------ */

  /**
   * Draw a service time and schedule `req`'s completion at this node, WITHOUT
   * touching the node's own busy counter -- the behaviour owns that. Once the
   * service time elapses, `onDrained` fires (so the behaviour can release its
   * slot and start whatever it had waiting) and the request then continues
   * down the normal completion path: error roll, onServiceComplete, routing.
   */
  serveWithin(
    state: NodeStateLike,
    req: ReqLike,
    onDrained: (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void,
  ): void;

  /**
   * Add `extraMs` of this node's own work to a request the behaviour is about
   * to serve -- a write's indexing cost, for instance. Applied by
   * serveWithin() on top of the drawn service time, and stretched with it by
   * a 'slow' fault.
   */
  addServiceDelay(req: ReqLike, extraMs: number): void;

  /**
   * Add `extraMs` of waiting that is not this node's own work, such as a
   * write queued behind other writers' locks. Applied by serveWithin() like
   * addServiceDelay(), but a 'slow' fault leaves it as it is.
   */
  addWaitDelay(req: ReqLike, extraMs: number): void;

  /**
   * Publish a per-shard utilisation vector for the snapshot. The engine
   * copies it into NodeStats and computes max/min; it has no opinion about
   * what a "shard" is.
   */
  reportShardUtilization(state: NodeStateLike, perShard: readonly number[]): void;

  /**
   * Publish this node's instance vector: how many units it is made of right
   * now, and each unit's utilisation. Called from reportInstances() by a kind
   * whose structure the engine cannot derive -- a shard's partitions, a
   * replica set's primary plus read replicas.
   *
   * `perUnit` is COPIED, so a behaviour may hand over the same scratch buffer
   * every frame. The engine only publishes a new array to the snapshot when
   * the contents actually changed, which is what lets a memoised React
   * consumer compare by reference and still never miss an update.
   *
   * The meaning of an index is fixed per kind and documented on NodeStats.
   * `pending` is units decided but not yet serving; pass 0 when the kind has
   * no such notion.
   */
  reportInstances(
    state: NodeStateLike,
    perUnit: readonly number[],
    pending: number,
  ): void;

  /**
   * Report true occupancy for a kind that runs its own slot discipline.
   *
   * The engine integrates utilisation from `state.busy`, which serveWithin()
   * deliberately never touches -- so a kind holding its slots in `ext` (a
   * replica set's two pools, a sharded store's partitions) would otherwise
   * report utilisation 0.0 no matter how saturated it actually is. That is not
   * merely a dead meter: `utilizationOf()` is the signal an autoscaler acts
   * on, so a permanently-zero reading makes a controller scale a melting node
   * DOWN. `busySlots` and `capacity` are this kind's own notion of both, and
   * the engine smooths the ratio exactly as it does for an ordinary server, so
   * the number means the same thing on the meter and to a controller.
   */
  reportOccupancy(state: NodeStateLike, busySlots: number, capacity: number): void;

  /** Mark a request as a write, so downstream kinds see the classification. */
  markWrite(req: ReqLike, isWrite: boolean): void;

  /**
   * Create a detached request at `state` and dispatch it down one specific
   * outgoing edge. For kinds that ORIGINATE traffic on their own schedule:
   * a stream broker delivering to a consumer group, a pub/sub topic fanning
   * a publish out, a cron job dumping its batch. The message is a detached
   * root (nothing upstream waits on it), its outcome is reported back via
   * onDownstreamResult when the behaviour declares `observesOutcome`, and
   * it books arrivals/completions at the nodes it visits like any request.
   *
   * Returns false without emitting when the edge is cut, the target node
   * does not exist, or the engine's live-request ceiling is hit; the caller
   * decides what an undeliverable message means. Consumes no randomness.
   */
  emitDetached(state: NodeStateLike, edge: SimEdge, key: number): boolean;
}
