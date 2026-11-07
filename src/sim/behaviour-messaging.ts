/**
 * Messaging and coordination component behaviours: streambroker, pubsub,
 * websocket, apigateway, sidecar, lambda, cron.
 *
 * These are the kinds real systems are glued together with: the partitioned
 * log between services, the fan-out topic, the long-lived connection
 * gateway, the front door, the per-service proxy, the function that scales
 * itself, and the batch job that arrives on a clock. Grouped in one module
 * because they share a theme a student can name; "how do services talk to
 * each other when it is not one request calling one server".
 *
 * Every one of them is a plain ComponentBehaviour: the event loop has no
 * idea they exist and none of them added a conditional to engine.ts. Three
 * of them (streambroker, pubsub, cron) ORIGINATE traffic of their own, which
 * they do through ctx.emitDetached(): a detached message that books its
 * arrivals and completions at the nodes it visits and is never waited on
 * upstream, exactly like a queue message drained by a worker.
 *
 * Determinism notes, which constrain everything here:
 *  - No behaviour in this module draws from the RNG except the apigateway's
 *    auth roll, which is taken in a fixed position at admission and only
 *    when authFailRate > 0 (the same conditional-on-config pattern the
 *    engine's own errorRate roll uses).
 *  - Anything asking "has enough time passed?" compares simulated
 *    timestamps, never accumulated per-tick deltas.
 *  - The cron fires from onTick, which quantises its firing instant to the
 *    advance() boundary; that is the same latitude the autoscaler already
 *    takes for its decisions, and the fire time is derived from simulated
 *    time, so a given advance() pattern replays exactly.
 *  - Connection and warm-pool expiries are processed LAZILY at admission by
 *    comparing stored absolute expiry times against ctx.now, so an
 *    admission decision never depends on whether a tick happened to run.
 */
import type { NodeStats, SimEdge } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/**
 * Partitions the broker will keep, capped at the inspector's own maximum.
 *
 * The cap is here rather than at the slider because one ring buffer is
 * allocated per partition, and `partitions` is not one of the nine config
 * numbers `isTopology` checks: a shared link, a `.breakscale` file and a
 * restored session all carry whatever it says into that loop.
 */
const MAX_PARTITIONS = 64;

/**
 * A count from config, floored and held between `min` and `max`.
 *
 * `Infinity` was as much a hole as `NaN`: it is a number and it is not NaN,
 * so it passed the guard, survived `Math.floor`, and reached the loops that
 * build one structure per unit. Those do not fail on it, they simply never
 * finish.
 */
function clampInt(
  v: number | undefined,
  min: number,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return n < min ? min : n > max ? max : n;
}

/* ================================================================== *
 * streambroker -- a partitioned, replayable log (Kafka-shaped)
 * ================================================================== */

/**
 * WHY THIS IS NOT THE QUEUE. The simple `queue` is one FIFO with one set of
 * competing consumers: a message is taken once and gone. A log is different
 * in every way that matters:
 *
 *  - PARTITIONED: a message lands in `key % partitions`, and order is
 *    preserved per partition, so one consumer group can process at most
 *    `partitions` messages in parallel. Partition count, not consumer
 *    count, is the parallelism ceiling; that is the single most
 *    misunderstood fact about Kafka and it falls straight out of this
 *    model.
 *  - MULTI-READER: every outgoing edge is an independent CONSUMER GROUP
 *    with its own cursor over the same messages. A slow analytics group
 *    falls behind without costing the billing group anything.
 *  - LAG, NOT BACKPRESSURE: producers are acked immediately no matter how
 *    far behind the consumers are. The cost of a slow consumer is invisible
 *    to the producer and shows up only as CONSUMER LAG, the headline
 *    metric here.
 *  - BOUNDED BY RETENTION: `queueLimit` is the log's retention in
 *    messages. A group that falls further behind than that skips forward
 *    and the skipped messages are simply lost to it; nonzero
 *    `retentionDropRate` means "you are not just slow, you are losing
 *    data".
 */

/** Per-partition retention floor, so a many-partition log still holds something. */
const MIN_RETENTION_PER_PARTITION = 16;
/** Hard cap on total retained messages, whatever the slider says. */
const MAX_TOTAL_RETENTION = 65536;

interface BrokerGroup {
  /** Outgoing edge this group consumes through. */
  edgeId: string;
  /** Target node id, used to correlate delivery results back to the group. */
  targetId: string;
  /** Next sequence number to deliver, per partition. */
  next: Float64Array;
  /** 1 while a delivery for this partition is in flight (order preserved). */
  inflight: Uint8Array;
  /** Deliveries resolved (ok or not) since sim start. */
  done: number;
  /** Messages skipped because they aged out of retention. */
  skipped: number;
  /**
   * True while pumpGroup() is draining this group. An instant-ack consumer
   * (a queue, a retry queue, a write-behind cache) resolves a delivery
   * SYNCHRONOUSLY inside emitDetached(), which re-enters pumpGroup through
   * onDownstreamResult; the flag turns that recursion into one iterative
   * drain loop instead of a stack that grows with the backlog.
   */
  pumping: boolean;
}

interface BrokerExt {
  /** Partition count the arrays were sized for; a change rebuilds them. */
  partitions: number;
  /** Ring buffer of message keys per partition. */
  rings: Int32Array[];
  /** Messages ever appended per partition (the head sequence). */
  head: Float64Array;
  /** Retention per partition, in messages (the ring size). */
  retention: number;
  /** One group per non-control outgoing edge, in edge order. */
  groups: BrokerGroup[];
  /** Joined edge ids, to detect rewiring without comparing arrays. */
  groupSig: string;
  /** Scratch for reportInstances. */
  report: number[];
}

function brokerPartitions(state: NodeStateLike): number {
  return clampInt(state.config.partitions, 1, 4, MAX_PARTITIONS);
}

function brokerRetention(state: NodeStateLike, partitions: number): number {
  const total = Math.min(
    Math.max(1, Math.floor(state.config.queueLimit)),
    MAX_TOTAL_RETENTION,
  );
  return Math.max(MIN_RETENTION_PER_PARTITION, Math.ceil(total / partitions));
}

function makeBrokerGroup(
  edge: SimEdge,
  partitions: number,
  startAt: Float64Array,
): BrokerGroup {
  const next = new Float64Array(partitions);
  next.set(startAt);
  return {
    edgeId: edge.id,
    targetId: edge.to,
    next,
    inflight: new Uint8Array(partitions),
    done: 0,
    skipped: 0,
    pumping: false,
  };
}

function brokerExt(state: NodeStateLike): BrokerExt {
  return state.ext as BrokerExt;
}

/**
 * Keep the broker's structure in step with its config and wiring.
 *
 * A partition-count change rebuilds the log and resets every cursor to the
 * head; changing the shape of a log discards in-flight position in reality
 * too (a Kafka repartition is a migration, not a slider), and starting the
 * groups caught-up is the least surprising of the honest options. A
 * rewired edge set rebuilds only the groups; a NEW group starts at the
 * current head, which is exactly a new Kafka group starting at 'latest'.
 */
function ensureBroker(state: NodeStateLike, ext: BrokerExt): BrokerExt {
  const partitions = brokerPartitions(state);
  if (partitions !== ext.partitions) {
    const retention = brokerRetention(state, partitions);
    ext.partitions = partitions;
    ext.retention = retention;
    ext.rings = [];
    for (let p = 0; p < partitions; p++) ext.rings.push(new Int32Array(retention));
    ext.head = new Float64Array(partitions);
    ext.groups = [];
    ext.groupSig = ' stale'; // force group rebuild below
  }
  const retention = brokerRetention(state, partitions);
  if (retention !== ext.retention) {
    // Retention slider moved: resize the rings. Contents restart empty and
    // cursors snap to head, for the same repartition honesty as above.
    ext.retention = retention;
    for (let p = 0; p < partitions; p++) ext.rings[p] = new Int32Array(retention);
    for (const g of ext.groups) {
      g.next.set(ext.head);
      g.inflight.fill(0);
    }
  }

  let sig = '';
  for (let i = 0; i < state.out.length; i++) sig += state.out[i].id + ' ';
  if (sig !== ext.groupSig) {
    const prev = new Map<string, BrokerGroup>();
    for (const g of ext.groups) prev.set(g.edgeId, g);
    const groups: BrokerGroup[] = [];
    for (let i = 0; i < state.out.length; i++) {
      const edge = state.out[i];
      const kept = prev.get(edge.id);
      if (kept && kept.next.length === partitions) {
        kept.targetId = edge.to;
        groups.push(kept);
      } else {
        groups.push(makeBrokerGroup(edge, partitions, ext.head));
      }
    }
    ext.groups = groups;
    ext.groupSig = sig;
  }
  return ext;
}

/** Total messages this group still has ahead of it, deliveries in flight included. */
function groupLag(ext: BrokerExt, g: BrokerGroup): number {
  let lag = 0;
  for (let p = 0; p < ext.partitions; p++) {
    lag += ext.head[p] - g.next[p];
    lag += g.inflight[p];
  }
  return lag;
}

/**
 * Deliver as much as this group is allowed to have in flight: at most one
 * message per partition, in partition order. Called whenever new messages
 * land and whenever one of the group's deliveries resolves, so delivery is
 * entirely event-driven and never depends on the frame clock.
 */
function pumpGroup(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  ext: BrokerExt,
  g: BrokerGroup,
  edge: SimEdge,
): void {
  // Re-entered from onDownstreamResult while already draining: the active
  // drain loop below will pick the freed partition up on its next pass.
  if (g.pumping) return;
  g.pumping = true;
  let progress = true;
  while (progress) {
    progress = false;
    for (let p = 0; p < ext.partitions; p++) {
      if (g.inflight[p] !== 0) continue;
      // Skip past anything that already aged out of retention. Those messages
      // are gone for this group; that loss is the retentionDropRate readout.
      const oldest = ext.head[p] - ext.retention;
      if (g.next[p] < oldest) {
        const skipped = oldest - g.next[p];
        g.skipped += skipped;
        ctx.countCustom(state, 'retentionDrop', skipped);
        g.next[p] = oldest;
      }
      if (g.next[p] >= ext.head[p]) continue;
      const key = ext.rings[p][g.next[p] % ext.retention];
      // Mark the partition in flight BEFORE emitting: an instant-ack
      // consumer resolves the delivery synchronously inside emitDetached,
      // and onDownstreamResult must find the flag set to correlate it
      // (it clears the flag, and this loop's next pass re-fills the slot).
      g.inflight[p] = 1;
      g.next[p] += 1;
      // A cut edge or missing target refuses the emit: the message stays
      // where it is and the group's lag keeps growing, which is exactly what
      // a partitioned broker link looks like from the outside.
      if (!ctx.emitDetached(state, edge, key)) {
        g.inflight[p] = 0;
        g.next[p] -= 1;
        g.pumping = false;
        return;
      }
      if (g.inflight[p] === 0) progress = true;
    }
  }
  g.pumping = false;
}

function pumpAllGroups(ctx: BehaviourCtx, state: NodeStateLike, ext: BrokerExt): void {
  for (let i = 0; i < ext.groups.length; i++) {
    const edge = state.out[i];
    if (!edge || edge.id !== ext.groups[i].edgeId) continue;
    pumpGroup(ctx, state, ext, ext.groups[i], edge);
  }
}

const streambroker: ComponentBehaviour = {
  kind: 'streambroker',
  // It acks the producer; deliveries are detached and paced per partition.
  blocksOnDownstream: false,
  // A broker is a buffer with cursors, not a server: its ack slots mean
  // nothing, and its meaningful backlog is lag, published via decorateStats.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  // Deliveries join back through this node; crediting them would double-count
  // the broker's throughput, whose honest meaning is the PUBLISH rate booked
  // by the ack path.
  creditsJoinCompletion: false,
  // The whole pacing mechanism: a delivery resolving is what frees its
  // partition and triggers the next one.
  observesOutcome: true,
  // One unit per partition, like a shard: the per-partition backlog is where
  // a hot partition becomes visible.
  instanceModel: 'custom',

  initState(state: NodeStateLike): BrokerExt {
    const partitions = brokerPartitions(state);
    const retention = brokerRetention(state, partitions);
    const rings: Int32Array[] = [];
    for (let p = 0; p < partitions; p++) rings.push(new Int32Array(retention));
    return {
      partitions,
      rings,
      head: new Float64Array(partitions),
      retention,
      groups: [],
      groupSig: '',
      report: [],
    };
  },

  // A publish is acked after the broker's own (tiny) serviceMs, no matter
  // what the consumers are doing. That decoupling IS the product.
  onAdmit: () => 'passthru',

  onServiceComplete(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) {
    const ext = ensureBroker(state, brokerExt(state));
    const p = ((req.key % ext.partitions) + ext.partitions) % ext.partitions;
    ext.rings[p][ext.head[p] % ext.retention] = req.key;
    ext.head[p] += 1;
    ctx.countCustom(state, 'published', 1);
    pumpAllGroups(ctx, state, ext);
    // The producer's call ends here; deliveries are detached and downstream
    // never sees the publish request itself.
    return 'complete';
  },

  onDownstreamResult(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    req: ReqLike,
    ok: boolean,
  ) {
    const ext = ensureBroker(state, brokerExt(state));
    // Correlate the finished delivery back to its group (by the consumer it
    // landed on) and partition (by the key it carried). At most one delivery
    // per (group, partition) is ever in flight, so the pair identifies it.
    const p = ((req.key % ext.partitions) + ext.partitions) % ext.partitions;
    for (let i = 0; i < ext.groups.length; i++) {
      const g = ext.groups[i];
      if (g.targetId !== req.nodeId || g.inflight[p] === 0) continue;
      g.inflight[p] = 0;
      g.done += 1;
      ctx.countCustom(state, 'delivered', 1);
      if (!ok) ctx.countCustom(state, 'deliveryFailed', 1);
      const edge = state.out[i];
      if (edge && edge.id === g.edgeId) pumpGroup(ctx, state, ext, g, edge);
      return;
    }
  },

  /**
   * Unit p is partition p, filled with the WORST group's backlog in that
   * partition against retention; the partition strip therefore shows where
   * in the keyspace the slow consumer is drowning.
   */
  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = ensureBroker(state, brokerExt(state));
    const out = ext.report;
    out.length = ext.partitions;
    for (let p = 0; p < ext.partitions; p++) {
      let worst = 0;
      for (const g of ext.groups) {
        const behind = ext.head[p] - g.next[p] + g.inflight[p];
        if (behind > worst) worst = behind;
      }
      out[p] = clamp01(worst / ext.retention);
    }
    ctx.reportInstances(state, out, 0);
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = ensureBroker(state, brokerExt(state));
    let maxLag = 0;
    let inflight = 0;
    const byGroup: number[] = [];
    for (const g of ext.groups) {
      const lag = groupLag(ext, g);
      byGroup.push(lag);
      if (lag > maxLag) maxLag = lag;
      for (let p = 0; p < ext.partitions; p++) inflight += g.inflight[p];
    }
    stats.consumerLag = maxLag;
    stats.consumerLagByGroup = byGroup;
    stats.deliveryRate = ctx.counterRate(state, 'delivered');
    stats.retentionDropRate = ctx.counterRate(state, 'retentionDrop');
    // The generic meters, told the truth for this kind: the backlog is the
    // worst group's lag (drawn against queueLimit, which is retention), and
    // what is "in flight" is deliveries out at consumers.
    stats.queued = maxLag;
    stats.inFlight = inflight;
  },
};

/* ================================================================== *
 * pubsub -- fan-out of one publish to every subscriber
 * ================================================================== */

/**
 * The lesson is AMPLIFICATION. One publish becomes one delivery per
 * subscriber edge, all detached and all independent: a slow subscriber
 * queues and sheds at its own node without delaying the others or the
 * publisher, but the total work in the system is N times what the
 * publisher thinks it sent. Wiring five subscribers onto a 100 rps
 * publisher quietly makes 500 rps of load, and the deliveryRate readout is
 * that multiplication printed as a number.
 *
 * Unlike the streambroker there is no cursor, no retention and no pacing:
 * delivery is immediate and at-most-once. If a subscriber cannot keep up
 * the excess is shed at the subscriber, not remembered here, which is the
 * honest difference between a topic and a log.
 */
const pubsub: ComponentBehaviour = {
  kind: 'pubsub',
  // It acks the publisher; each delivery is detached.
  blocksOnDownstream: false,
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  onAdmit: () => 'passthru',

  onServiceComplete(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) {
    for (let i = 0; i < state.out.length; i++) {
      if (ctx.emitDetached(state, state.out[i], req.key)) {
        ctx.countCustom(state, 'delivered', 1);
      }
    }
    return 'complete';
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    stats.fanout = state.out.length;
    const delivered = ctx.counterRate(state, 'delivered');
    stats.deliveryRate = delivered;
    stats.publishAmplification = delivered;
  },
};

/* ================================================================== *
 * websocket -- capacity measured in CONNECTIONS HELD, not requests served
 * ================================================================== */

/**
 * A long-lived-connection gateway. Every accepted connection occupies one
 * of `instances * capacity` slots for `connectionMs` of simulated time,
 * regardless of how quickly its handshake was served. By Little's law the
 * gateway settles at `rps * connectionMs / 1000` concurrent connections,
 * so a chat gateway taking a mere 40 conn/s with 30-second sessions is
 * holding 1200 connections, and THAT number, not the request rate, is what
 * it saturates on. This is why chat systems shard by connection count and
 * why Discord's gateway tier looks nothing like its API tier.
 *
 * A connection that finds every slot held is refused as 'conn-refused'
 * immediately; there is no queue to wait in, because a socket you cannot
 * accept is a socket the client retries against some other gateway.
 *
 * Expiry is lazy and exact: expiries are absolute simulated times in FIFO
 * order (the hold time is a constant read from config at accept time), so
 * releasing them at the next admission reproduces identically whatever the
 * frame cadence was.
 */
interface WsExt {
  /** Absolute expiry time of each open connection, oldest first. */
  expiry: number[];
  /** Read cursor into `expiry`, so release is O(1). */
  head: number;
}

function wsExt(state: NodeStateLike): WsExt {
  return state.ext as WsExt;
}

function wsOpen(ext: WsExt): number {
  return ext.expiry.length - ext.head;
}

/** Drop every connection whose lifetime has ended, as of `now`. */
function wsExpire(ext: WsExt, now: number): void {
  const q = ext.expiry;
  while (ext.head < q.length && q[ext.head] <= now) ext.head++;
  if (ext.head > 64 && ext.head * 2 >= q.length) {
    q.splice(0, ext.head);
    ext.head = 0;
  }
}

/** Open connections as of `now`, WITHOUT mutating: for pure snapshot reads. */
function wsOpenProjected(ext: WsExt, now: number): number {
  const q = ext.expiry;
  let head = ext.head;
  while (head < q.length && q[head] <= now) head++;
  return q.length - head;
}

const websocket: ComponentBehaviour = {
  kind: 'websocket',
  // Its resource is connection lifetime, not a thread per call.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  // Slot bookkeeping is connection-based and lives in `ext`; the engine's
  // busy/waiting pair never sees it, so there is nothing for it to pump.
  pump: 'none',
  creditsJoinCompletion: true,
  // One unit per instance; the waterline is connection occupancy, fed to the
  // engine through reportOccupancy below.
  instanceModel: 'slots',
  scaleField: 'instances',
  // A connection slot is released by its expiry timer, not by any request
  // finishing, so the engine cannot say which machine holds it.
  slotsOutliveService: true,

  initState(): WsExt {
    return { expiry: [], head: 0 };
  },

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = wsExt(state);
    wsExpire(ext, ctx.now);

    const cap = ctx.effectiveCapacity(state);
    if (wsOpen(ext) >= cap) {
      ctx.countCustom(state, 'connRefused', 1);
      ctx.reject(state, req, 'conn-refused');
      return 'handled';
    }

    const holdMs = Math.max(0, state.config.connectionMs ?? 30000);
    ext.expiry.push(ctx.now + holdMs);
    ctx.countCustom(state, 'connected', 1);

    // The HANDSHAKE is served now (serviceMs), and the request continues
    // downstream (session setup, auth) like any other call; the connection
    // slot stays held long after the handshake resolved, which is the whole
    // resource model. Nothing to do on drain: release is time-based.
    ctx.serveWithin(state, req, wsNoopDrain);
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = wsExt(state);
    wsExpire(ext, ctx.now);
    ctx.reportOccupancy(state, wsOpen(ext), ctx.effectiveCapacity(state));
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = wsExt(state);
    const open = wsOpenProjected(ext, ctx.now);
    stats.connectionsOpen = open;
    stats.maxConnections = ctx.effectiveCapacity(state);
    stats.connectRate = ctx.counterRate(state, 'connected');
    stats.connectionRejectRate = ctx.counterRate(state, 'connRefused');
    // The generic in-flight meter means "connections held" here; the
    // handshake count is a detail nobody sizes a gateway by.
    stats.inFlight = open;
  },
};

function wsNoopDrain(): void {
  // Connection slots are released by time, in wsExpire; the handshake
  // finishing frees nothing.
}

/* ================================================================== *
 * apigateway -- routing, auth and rate limiting in one front door
 * ================================================================== */

/**
 * The front door of a real API: one component that authenticates, rate
 * limits, and routes to whichever backend owns the path. Mechanically it is
 * a token bucket (reusing rateLimitRps/burst), an auth check (authFailRate,
 * refused as 'unauthorized'), and a weighted single-edge router (edge
 * weights are the route table), in front of real slots whose serviceMs is
 * the gateway's own processing cost.
 *
 * Order at the door is bucket first, then auth: a burst of bad credentials
 * still consumes rate-limit tokens, as it does in life, and the ordering is
 * fixed so the RNG stream never depends on which check happens to fail.
 */
interface GatewayBucket {
  tokens: number;
  lastRefillMs: number;
  lastBurst: number;
}

function gwRate(state: NodeStateLike): number {
  const r = state.config.rateLimitRps;
  return r !== undefined && r > 0 ? r : 0;
}

function gwBurst(state: NodeStateLike): number {
  const b = state.config.burst;
  if (b !== undefined && b > 0) return b;
  const r = gwRate(state);
  return r > 0 ? r : 1;
}

/** Continuous refill against elapsed simulated time; same math as ratelimiter. */
function gwRefill(ctx: BehaviourCtx, state: NodeStateLike, b: GatewayBucket): void {
  const burst = gwBurst(state);
  if (burst !== b.lastBurst) {
    if (b.tokens > burst) b.tokens = burst;
    b.lastBurst = burst;
  }
  const elapsed = ctx.now - b.lastRefillMs;
  if (elapsed <= 0) return;
  b.lastRefillMs = ctx.now;
  const rate = gwRate(state);
  if (rate <= 0) return;
  b.tokens += (elapsed / 1000) * rate;
  if (b.tokens > burst) b.tokens = burst;
}

/** Bucket level as of now, without mutating: snapshot() must stay pure. */
function gwProjectedTokens(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  b: GatewayBucket,
): number {
  const burst = gwBurst(state);
  let tokens = b.tokens > burst ? burst : b.tokens;
  const rate = gwRate(state);
  const elapsed = ctx.now - b.lastRefillMs;
  if (rate > 0 && elapsed > 0) {
    tokens += (elapsed / 1000) * rate;
    if (tokens > burst) tokens = burst;
  }
  return tokens;
}

const apigateway: ComponentBehaviour = {
  kind: 'apigateway',
  // An event-loop proxy: its slot is routing work, not a thread per call.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
  instanceModel: 'slots',
  scaleField: 'instances',

  initState: (state): GatewayBucket => ({
    tokens: gwBurst(state),
    lastRefillMs: 0,
    lastBurst: gwBurst(state),
  }),

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const b = state.ext as GatewayBucket;
    gwRefill(ctx, state, b);

    if (gwRate(state) > 0) {
      if (b.tokens < 1) {
        ctx.countCustom(state, 'throttled', 1);
        ctx.reject(state, req, 'throttled');
        return 'handled';
      }
      b.tokens -= 1;
    }

    const authFail = clamp01(state.config.authFailRate ?? 0);
    if (authFail > 0 && ctx.roll() < authFail) {
      ctx.countCustom(state, 'authRejected', 1);
      ctx.reject(state, req, 'unauthorized');
      return 'handled';
    }

    ctx.countCustom(state, 'admitted', 1);
    // Real slots and a real queue: auth and routing cost serviceMs each.
    return 'serve';
  },

  // The route table: exactly one backend per request, chosen by edge weight.
  route: () => 'one',
  pickEdge: (ctx, _state, _req, out) => ctx.pickWeightedOrLeastLoaded(out),

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const b = state.ext as GatewayBucket | null;
    stats.admittedRate = ctx.counterRate(state, 'admitted');
    stats.throttledRate = ctx.counterRate(state, 'throttled');
    stats.authRejectRate = ctx.counterRate(state, 'authRejected');
    stats.tokens = b ? gwProjectedTokens(ctx, state, b) : 0;
  },
};

/* ================================================================== *
 * sidecar -- the per-service proxy, and what it costs
 * ================================================================== */

/**
 * WHY 'sidecar' AND NOT 'serviceMesh'. A mesh is a property of the whole
 * graph -- every hop proxied -- and this simulator's unit of composition is
 * the NODE. A sidecar maps one-to-one onto that: the student places one
 * proxy in front of one service, and builds a mesh the way a mesh is
 * actually built, by putting a sidecar at every hop and watching the
 * latency taxes stack. A single 'serviceMesh' node would have to act on
 * edges it does not own, which is exactly the shape the behaviour registry
 * exists to avoid.
 *
 * What it teaches: infrastructure is never free. The proxy charges its
 * serviceMs on every single request in exchange for retries
 * (config.retries, run by the engine's own retry machinery), outlier
 * ejection (a consecutive-failure circuit, simpler than the breaker's
 * windowed rate on purpose; Envoy ships exactly this policy), and
 * observability (its readouts are the upstream's health, seen from the
 * caller's side). Put a sidecar at every hop of a five-hop chain and the
 * p50 grows by five taxes; remove them and lose the retries that were
 * hiding the flaky dependency. Both runs are one checkbox apart, and the
 * comparison is the lesson.
 */
interface SidecarExt {
  phase: 'closed' | 'open' | 'half-open';
  /** Simulated time the proxy last ejected its upstream. */
  openedAtMs: number;
  /** Consecutive downstream failures observed while closed. */
  consecutive: number;
  /** True while the single half-open probe is out. */
  probing: boolean;
  /** Ejections since sim start. */
  trips: number;
}

function sidecarExt(state: NodeStateLike): SidecarExt {
  return state.ext as SidecarExt;
}

function sidecarOutlierAfter(state: NodeStateLike): number {
  return clampInt(state.config.outlierAfter, 1, 5);
}

function sidecarOpenMs(state: NodeStateLike): number {
  const v = state.config.openMs;
  return v !== undefined && v > 0 ? v : 3000;
}

const sidecar: ComponentBehaviour = {
  kind: 'sidecar',
  // An event-loop proxy: its slot is routing work, not a thread per call.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
  observesOutcome: true,
  instanceModel: 'slots',
  scaleField: 'instances',

  initState: (): SidecarExt => ({
    phase: 'closed',
    openedAtMs: 0,
    consecutive: 0,
    probing: false,
    trips: 0,
  }),

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const st = sidecarExt(state);

    // Lazy transition on simulated time, exactly like the breaker: the
    // ejection has served its openMs, so the next request may probe.
    if (st.phase === 'open' && ctx.now - st.openedAtMs >= sidecarOpenMs(state)) {
      st.phase = 'half-open';
      st.probing = false;
    }

    if (st.phase === 'open' || (st.phase === 'half-open' && st.probing)) {
      ctx.countCustom(state, 'rejected', 1);
      ctx.reject(state, req, 'rejected');
      return 'handled';
    }

    if (st.phase === 'half-open') st.probing = true;
    // The latency tax: real slots, real serviceMs, on every request.
    return 'serve';
  },

  onDownstreamResult(
    ctx: BehaviourCtx,
    state: NodeStateLike,
    _req: ReqLike,
    ok: boolean,
  ) {
    const st = sidecarExt(state);
    if (!ok) ctx.countCustom(state, 'upstreamFail', 1);

    if (st.phase === 'half-open') {
      st.probing = false;
      if (ok) {
        st.phase = 'closed';
        st.consecutive = 0;
      } else {
        st.phase = 'open';
        st.openedAtMs = ctx.now;
        st.trips += 1;
      }
      return;
    }
    if (st.phase !== 'closed') return;

    if (ok) {
      st.consecutive = 0;
      return;
    }
    st.consecutive += 1;
    if (st.consecutive >= sidecarOutlierAfter(state)) {
      st.phase = 'open';
      st.openedAtMs = ctx.now;
      st.consecutive = 0;
      st.trips += 1;
    }
  },

  edgeStateFor(ctx, state, _edge, _index) {
    const st = state.ext as SidecarExt | null;
    if (!st) return null;
    const open = st.phase === 'open' && ctx.now - st.openedAtMs < sidecarOpenMs(state);
    return open ? 'blocked' : null;
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const st = state.ext as SidecarExt | null;
    if (!st) return;
    const phase =
      st.phase === 'open' && ctx.now - st.openedAtMs >= sidecarOpenMs(state)
        ? 'half-open'
        : st.phase;
    stats.breakerState = phase;
    stats.breakerTrips = st.trips;
    stats.consecutiveFails = st.consecutive;
    stats.rejectedRate = ctx.counterRate(state, 'rejected');
    stats.upstreamFailRate = ctx.counterRate(state, 'upstreamFail');
  },
};

/* ================================================================== *
 * lambda -- serverless: instant scale, cold starts
 * ================================================================== */

/**
 * A function-as-a-service pool. There is no fixed fleet: an invocation that
 * finds a WARM idle instance starts immediately; one that does not pays
 * `coldStartMs` on top of its service time while the platform provisions
 * an instance. Finished instances sit warm for `keepWarmMs` and are then
 * reclaimed, and reuse is most-recent-first (LIFO), which is what real
 * platforms do and is exactly why the warm pool shrinks to fit steady
 * traffic and gets caught flat by a burst.
 *
 * The visible consequences, all real in the numbers: an idle lambda's
 * first request is slow; a cron burst arriving at a cold pool pays
 * coldStartMs almost across the board (watch coldStartRate spike on the
 * cron's period); and beyond `maxConcurrency` the platform simply
 * throttles, because a lambda has no queue.
 */
interface LambdaExt {
  /** Absolute reclaim time of each warm idle instance, oldest first. */
  warmExpiry: number[];
  /** Read cursor into warmExpiry: entries before it are gone. */
  head: number;
  /** Invocations running right now. */
  busy: number;
}

function lambdaExt(state: NodeStateLike): LambdaExt {
  return state.ext as LambdaExt;
}

function lambdaLimit(state: NodeStateLike): number {
  return clampInt(state.config.maxConcurrency, 1, 40);
}

/** Reclaim warm instances whose keep-alive ended, as of `now`. */
function lambdaReap(ext: LambdaExt, now: number): void {
  const q = ext.warmExpiry;
  while (ext.head < q.length && q[ext.head] <= now) ext.head++;
  if (ext.head > 64 && ext.head * 2 >= q.length) {
    q.splice(0, ext.head);
    ext.head = 0;
  }
}

/** Warm idle count as of `now` without mutating, for pure snapshot reads. */
function lambdaWarmProjected(ext: LambdaExt, now: number): number {
  const q = ext.warmExpiry;
  let head = ext.head;
  while (head < q.length && q[head] <= now) head++;
  return q.length - head;
}

const lambda: ComponentBehaviour = {
  kind: 'lambda',
  // An invocation awaiting a call still counts against concurrency and is
  // still billed, so a slow dependency throttles the function.
  blocksOnDownstream: true,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,
  // One unit per live instance, busy or warm; the stack GROWS WITH LOAD,
  // which is the one picture that says "serverless" truthfully.
  instanceModel: 'custom',

  initState: (): LambdaExt => ({ warmExpiry: [], head: 0, busy: 0 }),

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = lambdaExt(state);
    lambdaReap(ext, ctx.now);

    if (ext.busy >= lambdaLimit(state)) {
      ctx.countCustom(state, 'throttled', 1);
      ctx.reject(state, req, 'throttled');
      return 'handled';
    }

    const warm = ext.warmExpiry.length - ext.head;
    if (warm > 0) {
      // Reuse the most recently freed instance (LIFO), leaving the oldest to
      // expire; this is why keep-warm does not accumulate a large fleet.
      ext.warmExpiry.pop();
      ctx.countCustom(state, 'warmStart', 1);
    } else {
      ctx.countCustom(state, 'coldStart', 1);
      // Booked as the function's own work: starting the runtime and running
      // its init code, which a slowed function does slowly too.
      ctx.addServiceDelay(req, Math.max(0, state.config.coldStartMs ?? 350));
    }

    ext.busy += 1;
    ctx.serveWithin(state, req, onLambdaDrained);
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = lambdaExt(state);
    lambdaReap(ext, ctx.now);
    ctx.reportOccupancy(state, ext.busy, lambdaLimit(state));
  },

  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = lambdaExt(state);
    const warm = lambdaWarmProjected(ext, ctx.now);
    // Cap the drawn stack; the badge carries the true count past this.
    const total = Math.min(ext.busy + warm, 64);
    const out = lambdaReport;
    out.length = total;
    for (let i = 0; i < total; i++) out[i] = i < ext.busy ? 1 : 0;
    ctx.reportInstances(state, out, 0);
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = lambdaExt(state);
    const cold = ctx.counterRate(state, 'coldStart');
    const warmStarts = ctx.counterRate(state, 'warmStart');
    const started = cold + warmStarts;
    stats.coldStartRate = started > 0 ? cold / started : 0;
    stats.coldStartsPerSec = cold;
    stats.warmIdle = lambdaWarmProjected(ext, ctx.now);
    // An invocation waiting on a call it made is still running and still
    // counts against maxConcurrency, so runningNow and the meter keep it.
    // inFlight is the part doing work, the same meaning it has elsewhere;
    // the engine publishes the rest as waitingOnDownstream.
    stats.runningNow = ext.busy;
    stats.inFlight = ext.busy > state.parked ? ext.busy - state.parked : 0;
    // The 'throttled' counter was already being booked at admission; publish
    // it so the UI can show refusals instead of inferring them from errors.
    stats.throttledRate = ctx.counterRate(state, 'throttled');
  },
};

/** Scratch for the lambda's instance vector; ctx.reportInstances copies it. */
const lambdaReport: number[] = [];

function onLambdaDrained(ctx: BehaviourCtx, state: NodeStateLike, _req: ReqLike): void {
  const ext = lambdaExt(state);
  if (ext.busy > 0) ext.busy -= 1;
  // The freed instance stays warm for keepWarmMs from THIS moment.
  const keep = Math.max(0, state.config.keepWarmMs ?? 12000);
  ext.warmExpiry.push(ctx.now + keep);
}

/* ================================================================== *
 * cron -- scheduled batch load
 * ================================================================== */

/**
 * A job on a clock. Every `intervalMs` it dumps `batchSize` detached
 * requests down EACH outgoing edge, effectively simultaneously; between
 * firings it does nothing at all. That burst shape is the entire lesson:
 * a database sized comfortably for its steady interactive load falls over
 * every time the report job lands on it, and the graphs show interactive
 * p95 spiking on the cron's period, which is exactly the page a real
 * on-call gets at midnight.
 *
 * Firing happens from onTick, so the instant is quantised to the advance()
 * boundary; the same latitude the autoscaler's decisions already take, and
 * fully replayable for a given advance() pattern. Message keys cycle a
 * deterministic counter rather than drawing randomness, so a cron never
 * perturbs anyone else's RNG stream. If firings were missed (a long stall),
 * ONE batch fires and the schedule resumes from now; a real cron with
 * `skip` overlap policy, not a backlog bomb.
 */
interface CronExt {
  /** Absolute simulated time of the next firing; -1 until initialised. */
  nextFireMs: number;
  /** Total requests emitted since sim start. */
  emitted: number;
  /** Deterministic key sequence for emitted messages. */
  keySeq: number;
}

function cronExt(state: NodeStateLike): CronExt {
  return state.ext as CronExt;
}

function cronInterval(state: NodeStateLike): number {
  const v = state.config.intervalMs;
  return v !== undefined && v >= 250
    ? Math.floor(v)
    : v !== undefined && v > 0
      ? 250
      : 20000;
}

/** Requests per edge per firing, bounded so a slider cannot wedge the heap. */
function cronBatch(state: NodeStateLike): number {
  return Math.min(clampInt(state.config.batchSize, 1, 50), 2000);
}

const cron: ComponentBehaviour = {
  kind: 'cron',
  // It emits detached work and waits on none of it.
  blocksOnDownstream: false,
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  initState: (): CronExt => ({ nextFireMs: -1, emitted: 0, keySeq: 0 }),

  // Traffic INTO a cron is a wiring mistake, same as into an autoscaler.
  onAdmit: (ctx, state, req) => {
    ctx.reject(state, req, 'no-route');
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const st = cronExt(state);
    const interval = cronInterval(state);
    if (st.nextFireMs < 0) {
      // First fire one full interval in, so a fresh topology settles first
      // and the burst reads as an event rather than as part of startup.
      st.nextFireMs = ctx.now + interval;
      return;
    }
    if (ctx.now < st.nextFireMs) return;

    const batch = cronBatch(state);
    for (let i = 0; i < state.out.length; i++) {
      const edge = state.out[i];
      for (let n = 0; n < batch; n++) {
        if (!ctx.emitDetached(state, edge, st.keySeq)) break;
        st.keySeq = (st.keySeq + 1) % 64;
        st.emitted += 1;
      }
    }
    ctx.countCustom(state, 'fired', 1);
    st.nextFireMs = ctx.now + interval;
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const st = state.ext as CronExt | null;
    if (!st) return;
    stats.nextFireInMs =
      st.nextFireMs < 0 ? cronInterval(state) : Math.max(0, st.nextFireMs - ctx.now);
    stats.batchEmitted = st.emitted;
    // What the next firing will dump downstream, all edges together. A pure
    // read of config and wiring, so the readout can say "burst 150" before
    // the burst ever lands.
    stats.burstSize = cronBatch(state) * state.out.length;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const MESSAGING_BEHAVIOURS: ComponentBehaviour[] = [
  streambroker,
  pubsub,
  websocket,
  apigateway,
  sidecar,
  lambda,
  cron,
];

/* Re-exported for the verification harness; not used by the engine. */
export type { BrokerExt, WsExt, SidecarExt, LambdaExt, CronExt };
