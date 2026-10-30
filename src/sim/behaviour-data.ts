/**
 * Data-tier component behaviours: replicated reads, and horizontal sharding.
 *
 * Both are pure registry entries -- they add no branch to the event loop. Each
 * keeps whatever internal structure it needs on `state.ext`, which the engine
 * allocates and then never looks at, and drives service through the ctx so its
 * timing, error rolls and timeouts are the same ones every other kind gets.
 *
 * They live in their own module rather than in behaviour.ts because both carry
 * real internal machinery (a per-key write clock, a set of independent
 * partitions) and folding that into the registry file would bury the small
 * declarative behaviours that make the registry readable.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';

/** Keyspace the engine draws request keys from; mirrored here for sizing. */
const KEYSPACE = 64;

/* Fleet ceilings, each the maximum the inspector already offers for the
 * field, so nothing a reader can build is affected by them. They exist for
 * the designs a reader cannot build: `isTopology` checks the nine core
 * config numbers and none of these, so a shared link, a `.breakscale` file
 * and a restored session all carry whatever they say straight to the
 * structures below, which are sized from it. */
const MAX_SHARDS = 64;
const MAX_REPLICAS = 64;
const MAX_SHARD_CAPACITY = 512;

/**
 * A count from config: floored, held at `min`, and capped at `max`.
 *
 * NaN fails every comparison, so `n < min` was false for it and a value that
 * is not a number used to pass through and size an array. Nothing here can
 * absorb that: `new Array(NaN)` throws outright, and a count in the billions
 * allocates until the tab stops rather than merely running slowly.
 */
function clampInt(v: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(v)) return min;
  const n = Math.floor(v);
  return n < min ? min : n > max ? max : n;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Scratch buffer for building an instance vector.
 *
 * A single module-level array shared by every node of every data-tier kind,
 * which is safe for exactly one reason: ctx.reportInstances() COPIES what it
 * is handed before returning, so the buffer's contents never have to survive
 * past the call that fills them. Nothing may retain what this returns.
 *
 * The alternative -- a per-node buffer -- would be one more allocation per
 * node held forever to save nothing, since the copy happens either way.
 */
let scratch: number[] = [];
function instanceScratch(n: number): number[] {
  if (scratch.length !== n) scratch.length = n;
  return scratch;
}

/* ================================================================== *
 * replica -- a read replica set behind a primary
 * ================================================================== */

/**
 * Per-node state for a replica set.
 *
 * `visibleAt[key]` is the simulated time at which the most recent write to
 * that key becomes visible on the replicas -- i.e. write completion plus the
 * replication lag. A read of that key before then is reading a replica that
 * has not caught up, which is precisely what a stale read is. Storing the
 * deadline rather than the write time means changing the lag slider affects
 * only writes issued after the change, which is how a real system behaves.
 */
interface ReplicaExt {
  /** Visibility deadline per key; -Infinity means "never written". */
  visibleAt: Float64Array;
  /** Read slots in use across the whole replica set. */
  readBusy: number;
  /** Write slots in use on the primary. */
  writeBusy: number;
  /** Reads waiting for a replica slot. */
  readQueue: ReqLike[];
  /** Writes waiting for a primary slot. */
  writeQueue: ReqLike[];
  /** Read cursors, so dequeue is O(1) without splice. */
  readHead: number;
  writeHead: number;
}

function replicaExt(state: NodeStateLike): ReplicaExt {
  return state.ext as ReplicaExt;
}

/** Total read slots: every replica serves reads in parallel. */
function readCapacity(state: NodeStateLike): number {
  return (
    clampInt(state.config.capacity, 1) *
    clampInt(state.config.replicaCount, 1, MAX_REPLICAS)
  );
}

/** Write slots: the primary alone, which is why writes do not scale. */
function writeCapacity(state: NodeStateLike): number {
  return clampInt(state.config.capacity, 1);
}

const replica: ComponentBehaviour = {
  kind: 'replica',
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  // Admission, queueing and slot release are all handled inside onAdmit and
  // the drain callback, because reads and writes draw from two different
  // pools. The engine's single busy/waiting pair cannot express that.
  pump: 'none',
  creditsJoinCompletion: true,

  initState(_state: NodeStateLike): ReplicaExt {
    const visibleAt = new Float64Array(KEYSPACE);
    visibleAt.fill(-Infinity);
    return {
      visibleAt,
      readBusy: 0,
      writeBusy: 0,
      readQueue: [],
      writeQueue: [],
      readHead: 0,
      writeHead: 0,
    };
  },

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = replicaExt(state);

    // Classify read vs write ONCE, from a single RNG draw. A retry of the same
    // call re-draws, exactly as a real client re-issuing a request would.
    const isWrite = ctx.roll() >= clamp01(state.config.readFraction);
    ctx.markWrite(req, isWrite);

    const queue = isWrite ? ext.writeQueue : ext.readQueue;
    const head = isWrite ? ext.writeHead : ext.readHead;
    const busy = isWrite ? ext.writeBusy : ext.readBusy;
    const capacity = isWrite ? writeCapacity(state) : readCapacity(state);

    if (busy < capacity) {
      startReplicaService(ctx, state, req, isWrite);
      return 'handled';
    }

    // Reads and writes share one configured backlog; a full queue sheds.
    if (queue.length - head >= ctx.effectiveQueueLimit(state)) return 'shed';
    queue.push(req);
    return 'handled';
  },

  // A replica set is a primary plus N read replicas, and drawing it as one
  // box hides the reason adding replicas does not fix a write bottleneck.
  instanceModel: 'custom',

  /**
   * Unit 0 is the PRIMARY and reports the write pool's utilisation; units
   * 1..replicaCount are the read replicas.
   *
   * The read replicas all report the same number, and that is the honest
   * reading rather than a shortcut: the engine pools read slots across the
   * whole set, so a read is served by whichever replica is free and no
   * individual replica has a utilisation of its own. Splitting the pool's
   * load evenly across the drawn units says exactly that. What the vector
   * DOES separate -- the primary from the read set -- is the distinction that
   * carries the lesson, because it is where the two pools genuinely differ.
   */
  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = replicaExt(state);
    const replicas = clampInt(state.config.replicaCount, 1, MAX_REPLICAS);
    const out = instanceScratch(replicas + 1);

    const writeCap = writeCapacity(state);
    out[0] = writeCap > 0 ? Math.min(ext.writeBusy / writeCap, 1) : 0;

    const readCap = readCapacity(state);
    const readUtil = readCap > 0 ? Math.min(ext.readBusy / readCap, 1) : 0;
    for (let i = 1; i <= replicas; i++) out[i] = readUtil;

    ctx.reportInstances(state, out, 0);
  },

  load(_ctx: BehaviourCtx, state: NodeStateLike): number {
    const ext = replicaExt(state);
    const work =
      ext.readBusy +
      ext.writeBusy +
      (ext.readQueue.length - ext.readHead) +
      (ext.writeQueue.length - ext.writeHead);
    return work / (readCapacity(state) + writeCapacity(state));
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike, _dtMs: number): void {
    // Publish occupancy on the engine's clock. Reads and writes draw from two
    // different pools held in `ext`, so state.busy stays 0 and the engine
    // would otherwise integrate this node's utilisation as permanently idle --
    // which does not merely blank the meter, it tells an autoscaler watching
    // this node to scale it DOWN while its queue is overflowing.
    const ext = replicaExt(state);
    ctx.reportOccupancy(
      state,
      ext.readBusy + ext.writeBusy,
      readCapacity(state) + writeCapacity(state),
    );
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const fresh = ctx.counterRate(state, 'freshRead');
    const stale = ctx.counterRate(state, 'staleRead');
    const total = fresh + stale;
    stats.staleReadRate = total > 0 ? stale / total : 0;

    // Occupancy is the two pools together against their combined slots, so the
    // meter still means "how full is this thing".
    const ext = replicaExt(state);
    stats.queued =
      ext.readQueue.length - ext.readHead + (ext.writeQueue.length - ext.writeHead);
    stats.inFlight = ext.readBusy + ext.writeBusy;
  },
};

/**
 * Begin serving one request against the replica set.
 *
 * A write occupies a primary slot and, on completion, pushes this key's
 * visibility deadline out by the replication lag. A read occupies a replica
 * slot and is judged stale at the moment it is served.
 */
function startReplicaService(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
  isWrite: boolean,
): void {
  const ext = replicaExt(state);
  const key = req.key % KEYSPACE;

  if (isWrite) {
    ext.writeBusy++;
  } else {
    ext.readBusy++;
    // Judge staleness at service time: the replica answers from whatever it
    // holds right now. `visibleAt` is the write's arrival deadline on the
    // replicas, so "not yet visible" is exactly a stale read.
    const stale = ctx.now < ext.visibleAt[key];
    ctx.countCustom(state, stale ? 'staleRead' : 'freshRead', 1);
  }

  if (isWrite) {
    // Claim the key's visibility deadline BEFORE starting service. A
    // zero-millisecond service time completes synchronously inside
    // serveWithin(), so anything written afterwards would be set after the
    // request had already drained. The deadline is a lower bound here (it
    // ignores this write's own service time) and is pushed to its true value
    // when the write actually lands, in onReplicaDrained.
    const lag = state.config.replicationLagMs;
    const visible = ctx.now + (lag > 0 ? lag : 0);
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  }

  ctx.serveWithin(state, req, onReplicaDrained);
}

/** A replica-set request finished its service time: free its slot, pull next. */
function onReplicaDrained(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const ext = replicaExt(state);
  if (req.isWrite) {
    if (ext.writeBusy > 0) ext.writeBusy--;
    // The write has now committed on the primary. Replication starts from
    // here, so this is the moment the real visibility deadline is known.
    const lag = state.config.replicationLagMs;
    const key = req.key % KEYSPACE;
    const visible = ctx.now + (lag > 0 ? lag : 0);
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  } else if (ext.readBusy > 0) {
    ext.readBusy--;
  }
  pumpReplica(ctx, state);
}

/** Start whatever is waiting, up to each pool's own capacity. */
function pumpReplica(ctx: BehaviourCtx, state: NodeStateLike): void {
  const ext = replicaExt(state);

  while (
    ext.writeBusy < writeCapacity(state) &&
    ext.writeHead < ext.writeQueue.length
  ) {
    const req = ext.writeQueue[ext.writeHead];
    ext.writeQueue[ext.writeHead] = null as unknown as ReqLike;
    ext.writeHead++;
    compact(
      ext.writeQueue,
      () => ext.writeHead,
      (v) => (ext.writeHead = v),
    );
    startReplicaService(ctx, state, req, true);
  }
  while (ext.readBusy < readCapacity(state) && ext.readHead < ext.readQueue.length) {
    const req = ext.readQueue[ext.readHead];
    ext.readQueue[ext.readHead] = null as unknown as ReqLike;
    ext.readHead++;
    compact(
      ext.readQueue,
      () => ext.readHead,
      (v) => (ext.readHead = v),
    );
    startReplicaService(ctx, state, req, false);
  }
}

/* ================================================================== *
 * shard -- horizontal partitioning
 * ================================================================== */

/**
 * Per-node state for a sharded store: `shardCount` independent
 * queue-and-servers units. They are deliberately NOT one shared pool -- a
 * request for a key can only be served by the shard that owns that key, and
 * that constraint is the entire lesson of the component.
 */
interface ShardExt {
  /** Busy slots per shard. */
  busy: Int32Array;
  /** Waiting requests per shard. */
  queues: ReqLike[][];
  /** Read cursor per shard. */
  heads: Int32Array;
  /** Integrated busy-slot-ms per shard, for utilisation. */
  utilization: Float64Array;
  /** Scratch handed to reportShardUtilization, reused every snapshot. */
  report: number[];
  /** Shard count the arrays were sized for; a resize rebuilds them. */
  sized: number;
  /** Last time utilisation was integrated. */
  lastIntegrateMs: number;
}

function shardExt(state: NodeStateLike): ShardExt {
  return state.ext as ShardExt;
}

function makeShardExt(count: number): ShardExt {
  const queues: ReqLike[][] = [];
  for (let i = 0; i < count; i++) queues.push([]);
  return {
    busy: new Int32Array(count),
    queues,
    heads: new Int32Array(count),
    utilization: new Float64Array(count),
    report: new Array<number>(count).fill(0),
    sized: count,
    lastIntegrateMs: 0,
  };
}

/**
 * Resize in place when the student moves the shard-count slider mid-run.
 * Requests already queued on a shard that no longer exists are re-homed onto
 * the shard their key now maps to, rather than being silently dropped.
 */
function ensureSized(state: NodeStateLike, ext: ShardExt): ShardExt {
  const want = clampInt(state.config.shardCount, 1, MAX_SHARDS);
  if (ext.sized === want) return ext;

  const orphans: ReqLike[] = [];
  for (let i = 0; i < ext.sized; i++) {
    const q = ext.queues[i];
    for (let j = ext.heads[i]; j < q.length; j++) {
      if (q[j]) orphans.push(q[j]);
    }
  }

  const next = makeShardExt(want);
  next.lastIntegrateMs = ext.lastIntegrateMs;
  // Busy slots belong to requests already in service; their drain callback
  // will decrement whichever shard they were charged to, so carry the counts
  // across for the shards that still exist.
  for (let i = 0; i < Math.min(ext.sized, want); i++) next.busy[i] = ext.busy[i];
  for (const req of orphans) next.queues[req.key % want].push(req);

  Object.assign(ext, next);
  return ext;
}

/** Which shard owns this request: the hot key overrides the natural mapping. */
function shardIndexFor(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
  count: number,
): number {
  const hot = clamp01(state.config.hotKeyFraction);
  // A single RNG draw decides whether this request is part of the hot-key
  // traffic. Taken unconditionally so the draw sequence -- and therefore the
  // replay -- does not depend on the slider's value.
  const roll = ctx.roll();
  if (hot > 0 && roll < hot) return 0;
  return ((req.key % count) + count) % count;
}

const shard: ComponentBehaviour = {
  kind: 'shard',
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,
  // A shard serves from shardCapacity (per partition), never from `capacity`.
  // Without this an autoscaler pointed here writes a field this kind ignores.
  scaleField: 'shardCapacity',
  // One unit per partition. This is the kind the instance model exists for:
  // the per-partition numbers are genuinely independent, and the gap between
  // one pinned at 1.0 and the rest near idle IS the sharding lesson.
  instanceModel: 'custom',

  /**
   * Unit i is partition i, reporting that partition's own smoothed
   * utilisation -- the same vector already surfaced as `shardUtilization`,
   * published here through the general instance channel so a consumer can
   * draw any partitioned kind without knowing the word "shard".
   */
  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = ensureSized(state, shardExt(state));
    const out = instanceScratch(ext.sized);
    for (let i = 0; i < ext.sized; i++) out[i] = ext.utilization[i];
    ctx.reportInstances(state, out, 0);
  },

  initState(state: NodeStateLike): ShardExt {
    return makeShardExt(clampInt(state.config.shardCount, 1, MAX_SHARDS));
  },

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = ensureSized(state, shardExt(state));
    const count = ext.sized;
    const idx = shardIndexFor(ctx, state, req, count);
    const capacity = clampInt(state.config.shardCapacity, 1, MAX_SHARD_CAPACITY);

    if (ext.busy[idx] < capacity) {
      startShardService(ctx, state, ext, idx, req);
      return 'handled';
    }

    // Each shard has its own backlog. One shard filling up must not steal the
    // headroom of the others, or the hot-key demo would show sheds everywhere
    // instead of on the shard that is actually melting.
    const q = ext.queues[idx];
    if (q.length - ext.heads[idx] >= ctx.effectiveQueueLimit(state)) return 'shed';
    q.push(req);
    return 'handled';
  },

  load(_ctx: BehaviourCtx, state: NodeStateLike): number {
    // Not ensureSized(): this must be a pure read, and a pending resize is
    // applied on the next admit anyway.
    const ext = shardExt(state);
    let work = 0;
    for (let i = 0; i < ext.sized; i++) {
      work += ext.busy[i] + (ext.queues[i].length - ext.heads[i]);
    }
    const capacity = clampInt(state.config.shardCapacity, 1, MAX_SHARD_CAPACITY);
    return work / (ext.sized * capacity);
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike, _dtMs: number): void {
    // Integrate per-shard occupancy on the engine's own clock rather than per
    // event, so an idle shard's utilisation still decays toward zero.
    const ext = ensureSized(state, shardExt(state));
    const dt = ctx.now - ext.lastIntegrateMs;
    ext.lastIntegrateMs = ctx.now;
    if (dt <= 0) return;
    const capacity = clampInt(state.config.shardCapacity, 1, MAX_SHARD_CAPACITY);
    const alpha = 1 - Math.exp(-dt / 500);
    let busy = 0;
    for (let i = 0; i < ext.sized; i++) {
      const instant = Math.min(ext.busy[i] / capacity, 1);
      ext.utilization[i] += (instant - ext.utilization[i]) * alpha;
      busy += ext.busy[i];
    }
    // Slots live per-shard in `ext`, so state.busy is 0 and the engine would
    // integrate this node as idle. Report the real total, or an autoscaler
    // watching a melting sharded store reads 0.0 and scales it down.
    ctx.reportOccupancy(state, busy, ext.sized * capacity);
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = ensureSized(state, shardExt(state));
    const n = ext.sized;
    let max = 0;
    let min = Infinity;
    let sum = 0;
    let busy = 0;
    let queued = 0;
    for (let i = 0; i < n; i++) {
      const u = ext.utilization[i];
      ext.report[i] = u;
      if (u > max) max = u;
      if (u < min) min = u;
      sum += u;
      busy += ext.busy[i];
      queued += ext.queues[i].length - ext.heads[i];
    }
    ext.report.length = n;

    stats.maxShardUtilization = max;
    stats.minShardUtilization = min === Infinity ? 0 : min;
    // The node-level meter is the mean across shards -- which is exactly the
    // number that looks healthy while one shard is pinned at 1.0.
    stats.utilization = n > 0 ? sum / n : 0;
    stats.inFlight = busy;
    stats.queued = queued;
    ctx.reportShardUtilization(state, ext.report);
    stats.shardUtilization = ext.report;
  },
};

function startShardService(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  ext: ShardExt,
  idx: number,
  req: ReqLike,
): void {
  ext.busy[idx]++;
  // Remember which shard is paying for this request, so the drain callback
  // credits the slot back to the right one even if the count changed since.
  shardOf.set(req, idx);
  ctx.serveWithin(state, req, onShardDrained);
}

function onShardDrained(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const ext = shardExt(state);
  const idx = shardOf.get(req);
  shardOf.delete(req);
  if (idx === undefined || idx >= ext.sized) return;
  if (ext.busy[idx] > 0) ext.busy[idx]--;

  const capacity = clampInt(state.config.shardCapacity, 1, MAX_SHARD_CAPACITY);
  const q = ext.queues[idx];
  while (ext.busy[idx] < capacity && ext.heads[idx] < q.length) {
    const next = q[ext.heads[idx]];
    q[ext.heads[idx]] = null as unknown as ReqLike;
    ext.heads[idx]++;
    if (ext.heads[idx] > 64 && ext.heads[idx] * 2 >= q.length) {
      q.splice(0, ext.heads[idx]);
      ext.heads[idx] = 0;
    }
    if (!next) continue;
    startShardService(ctx, state, ext, idx, next);
  }
}

/**
 * Which shard each in-service request is charged to.
 *
 * A WeakMap keyed on the request rather than a field on Req: the shard index
 * is meaningful only to this behaviour, and putting it on the shared request
 * object would be the exact kind of per-kind field the registry exists to
 * avoid. Entries are deleted on drain, and the engine pools requests, so this
 * holds at most one entry per in-flight sharded request.
 */
const shardOf = new WeakMap<ReqLike, number>();

/** Drop a queue's dead prefix once it is mostly consumed. */
function compact(
  q: unknown[],
  getHead: () => number,
  setHead: (v: number) => void,
): void {
  const head = getHead();
  if (head > 64 && head * 2 >= q.length) {
    q.splice(0, head);
    setHead(0);
  }
}

export const DATA_BEHAVIOURS: ComponentBehaviour[] = [replica, shard];
