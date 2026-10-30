/**
 * Storage behaviours: relational database, object storage, search index,
 * time-series store, graph database, cold storage, vector database.
 *
 * All seven are pure registry entries -- no branch is added to the event
 * loop. Each one carries a mechanism no other kind has, because a store
 * whose only identity is its default sliders is a store the student can
 * rightly call a re-skinned service:
 *
 *   db           write lock contention (writes serialise against each other)
 *   objectstore  per-prefix rate ceilings and no queue (S3 SlowDown)
 *   searchindex  asynchronous indexing (a commit is not yet searchable)
 *   timeseriesdb two-class cost (cheap appends, expensive range queries)
 *   graphdb      traversal cost compounds with depth
 *   coldstorage  restore JOBS: flat multi-second latency, a slot quota,
 *                and no queue at all
 *   vectordb     recall target multiplies scan cost hyperbolically
 *
 * Five of them share one piece of machinery: a self-managed slot pool
 * whose per-request service cost is decided by the kind (a write pays an
 * indexing surcharge, a range query pays a scan surcharge, a deep traversal
 * multiplies, a high-recall vector query probes more of its index). The
 * engine's standard `startService` path draws every request's time from the
 * same distribution, so a kind whose whole lesson is "THIS class of request
 * costs more" must run its own admission and hand timing to serveWithin(),
 * exactly the way replica and shard already do.
 *
 * Determinism: every RNG draw here happens in classify(), once per admitted
 * request, unconditionally where a roll exists at all -- the same discipline
 * behaviour-data.ts follows, so replay never depends on a slider's value.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';

/** Keyspace the engine draws request keys from; mirrored here for sizing. */
const KEYSPACE = 64;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Read an optional config number, treating absent/NaN as `fallback`. */
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/* ================================================================== *
 * objectstore -- blob storage (S3-like)
 *
 * A wide flat-latency pool with one mechanism of its own: PER-PREFIX rate
 * ceilings. A blob store partitions its keyspace by prefix and each
 * partition sustains `prefixRps` on its own; a request that finds its
 * prefix over the ceiling is refused instantly with a SlowDown
 * ('throttled'), while the rest of the store idles. That is the S3 503,
 * and it is why blob-store performance advice is about key LAYOUT --
 * spread your prefixes -- rather than about capacity. The gate consumes
 * zero randomness (a continuous token bucket per prefix, refilled against
 * simulated time exactly like the rate limiter); requests that pass it
 * are served on the engine's ordinary wide slot pool.
 *
 * No instance model and no scaleField: it is a managed service, one
 * logical thing an autoscaler has no business resizing -- which is itself
 * part of the lesson, because when a prefix melts there is no "add
 * servers" knob to reach for.
 * ================================================================== */

/**
 * Fixed prefix count the 64-key keyspace folds onto. A constant rather
 * than a knob: the lesson lives in `prefixRps` and in the key layout of
 * the traffic, not in how many prefixes exist.
 */
const OBJECT_PREFIXES = 8;

interface ObjectStoreExt {
  /** Token bucket level per prefix. Fractional: refill is continuous. */
  tokens: Float64Array;
  /** Simulated time each prefix's bucket was last refilled. */
  lastRefillMs: Float64Array;
  /** Ceiling the buckets were last capped against, to catch slider moves. */
  lastRate: number;
}

function objectPrefixRate(state: NodeStateLike): number {
  const r = state.config.prefixRps;
  return r !== undefined && r > 0 ? r : 0;
}

/** Bring ONE prefix's bucket up to date with simulated time. */
function objectRefill(
  ext: ObjectStoreExt,
  prefix: number,
  rate: number,
  now: number,
): void {
  if (rate !== ext.lastRate) {
    // The ceiling moved: re-cap every bucket rather than letting one filled
    // under the old ceiling stay oversized.
    for (let p = 0; p < OBJECT_PREFIXES; p++) {
      if (ext.tokens[p] > rate) ext.tokens[p] = rate;
    }
    ext.lastRate = rate;
  }
  const elapsed = now - ext.lastRefillMs[prefix];
  if (elapsed <= 0) return;
  ext.lastRefillMs[prefix] = now;
  ext.tokens[prefix] += (elapsed / 1000) * rate;
  if (ext.tokens[prefix] > rate) ext.tokens[prefix] = rate;
}

const objectstore: ComponentBehaviour = {
  kind: 'objectstore',
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  initState(state: NodeStateLike): ObjectStoreExt {
    const rate = objectPrefixRate(state);
    const tokens = new Float64Array(OBJECT_PREFIXES);
    // Buckets start full, like every other token bucket in the app: an idle
    // store absorbs one burst per prefix before the ceiling bites.
    tokens.fill(rate > 0 ? rate : 0);
    return { tokens, lastRefillMs: new Float64Array(OBJECT_PREFIXES), lastRate: rate };
  },

  onAdmit(ctx, state, req): AdmitAction {
    const rate = objectPrefixRate(state);
    // No ceiling configured: a plain wide pool, exactly the old behaviour.
    if (rate <= 0) return 'serve';

    const ext = state.ext as ObjectStoreExt;
    const prefix = ((req.key % OBJECT_PREFIXES) + OBJECT_PREFIXES) % OBJECT_PREFIXES;
    objectRefill(ext, prefix, rate, ctx.now);
    if (ext.tokens[prefix] < 1) {
      ctx.countCustom(state, 'slowdown', 1);
      ctx.reject(state, req, 'throttled');
      return 'handled';
    }
    ext.tokens[prefix] -= 1;
    return 'serve';
  },

  decorateStats(ctx, state, stats: NodeStats): void {
    stats.slowdownRate = ctx.counterRate(state, 'slowdown');
  },
};

/* ================================================================== *
 * coldstorage -- archival tier (Glacier-like)
 *
 * NOT a slow database, and the difference is the whole component. A slow
 * database queues: push online traffic at it and latency compounds as the
 * line grows. An archive runs restore JOBS: a retrieval takes its flat
 * multi-second time no matter how busy the vault is, there is NO queue to
 * stand in, and the vault runs at most `capacity` concurrent restores
 * (its provisioned retrieval capacity). A request that finds every
 * restore slot taken is refused on the spot ('throttled', the archival
 * tier's RequestLimitExceeded).
 *
 * So under overload the two kinds fail in opposite directions: the slow
 * db's p99 explodes while its error rate stays low; the archive's p99
 * stays pinned at the flat retrieval time while refusals climb. Both
 * teach "keep online traffic away", but only this one teaches it the way
 * Glacier actually does.
 * ================================================================== */

interface ColdStorageExt {
  /** Restore jobs currently running. */
  jobs: number;
}

const coldDrained = (_ctx: BehaviourCtx, state: NodeStateLike, _req: ReqLike): void => {
  const ext = state.ext as ColdStorageExt;
  if (ext.jobs > 0) ext.jobs--;
};

const coldstorage: ComponentBehaviour = {
  kind: 'coldstorage',
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  // No queue and no engine slots: jobs are tracked in ext, timed by
  // serveWithin, and the only admission outcomes are "job started" and
  // "refused". queueLimit is ignored, because a vault has no line to wait in.
  pump: 'none',
  creditsJoinCompletion: true,

  initState: (): ColdStorageExt => ({ jobs: 0 }),

  onAdmit(ctx, state, req): AdmitAction {
    const ext = state.ext as ColdStorageExt;
    if (ext.jobs >= ctx.effectiveCapacity(state)) {
      ctx.countCustom(state, 'restoreDenied', 1);
      ctx.reject(state, req, 'throttled');
      return 'handled';
    }
    ext.jobs++;
    ctx.serveWithin(state, req, coldDrained);
    return 'handled';
  },

  load(ctx, state): number {
    const ext = state.ext as ColdStorageExt;
    return ext.jobs / Math.max(1, ctx.effectiveCapacity(state));
  },

  onTick(ctx, state): void {
    const ext = state.ext as ColdStorageExt;
    ctx.reportOccupancy(state, ext.jobs, ctx.effectiveCapacity(state));
  },

  decorateStats(ctx, state, stats: NodeStats): void {
    const ext = state.ext as ColdStorageExt | null;
    stats.inFlight = ext ? ext.jobs : 0;
    stats.queued = 0;
    stats.throttledRate = ctx.counterRate(state, 'restoreDenied');
  },
};

/* ================================================================== *
 * Shared costed pool
 *
 * One busy counter and one FIFO, exactly the engine's own discipline,
 * kept in `ext` because the per-request cost (added via addServiceDelay
 * in classify()) is only honoured by serveWithin(), never by the
 * engine-managed startService() path. Capacity and queue limit are read
 * through the ctx so `instances`, sliders and floors all mean the same
 * thing they mean everywhere else.
 * ================================================================== */

interface PoolExt {
  /** Slots in use across the whole pool. */
  busy: number;
  /** Waiting requests, FIFO. */
  queue: ReqLike[];
  /** Read cursor, so dequeue is O(1) without splice. */
  head: number;
}

function poolExt(state: NodeStateLike): PoolExt {
  return state.ext as PoolExt;
}

type Drained = (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void;

/**
 * Build the drain-and-pump callback for one kind. `onStart` runs just
 * before a request's service time begins (where staleness is judged and
 * served-class counters are booked); `onServed` runs when its service
 * time has elapsed (where a write's commit takes effect).
 */
function makeDrained(
  onStart: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null,
  onServed: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null,
): Drained {
  const drained: Drained = (ctx, state, req) => {
    const ext = poolExt(state);
    if (ext.busy > 0) ext.busy--;
    // Measured cost booking: `served` is queries, `servedMs` is the actual
    // milliseconds each one took (surcharges included), so a mean cost
    // readout is measurement rather than arithmetic on the config.
    ctx.countCustom(state, 'served', 1);
    ctx.countCustom(state, 'servedMs', req.ownMs);
    if (onServed) onServed(ctx, state, req);

    // Pump: start whatever is waiting, up to capacity. Requests that
    // resolved while queued are skipped without occupying a slot, the same
    // rule the engine's own pumpQueue applies.
    const q = ext.queue;
    while (ext.busy < ctx.effectiveCapacity(state) && ext.head < q.length) {
      const next = q[ext.head];
      q[ext.head] = null as unknown as ReqLike;
      ext.head++;
      if (ext.head > 64 && ext.head * 2 >= q.length) {
        q.splice(0, ext.head);
        ext.head = 0;
      }
      if (!next) continue;
      startPoolService(ctx, state, next, onStart, drained);
    }
  };
  return drained;
}

function startPoolService(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
  onStart: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null,
  drained: Drained,
): void {
  const ext = poolExt(state);
  ext.busy++;
  if (onStart) onStart(ctx, state, req);
  ctx.serveWithin(state, req, drained);
}

/** The shared admission path: classify, then slot-or-queue-or-shed. */
function poolAdmit(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
  classify: (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void,
  onStart: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null,
  drained: Drained,
): AdmitAction {
  const ext = poolExt(state);
  classify(ctx, state, req);
  if (ext.busy < ctx.effectiveCapacity(state)) {
    startPoolService(ctx, state, req, onStart, drained);
    return 'handled';
  }
  if (ext.queue.length - ext.head >= ctx.effectiveQueueLimit(state)) return 'shed';
  ext.queue.push(req);
  return 'handled';
}

function initPool(): PoolExt {
  return { busy: 0, queue: [], head: 0 };
}

/** Occupancy publishing shared by every pooled kind (see replica for why). */
function reportPool(ctx: BehaviourCtx, state: NodeStateLike): void {
  ctx.reportOccupancy(state, poolExt(state).busy, ctx.effectiveCapacity(state));
}

/** Busy plus queued over slots, for the least-loaded edge picker. */
function poolLoad(ctx: BehaviourCtx, state: NodeStateLike): number {
  const ext = poolExt(state);
  return (
    (ext.busy + (ext.queue.length - ext.head)) /
    Math.max(1, ctx.effectiveCapacity(state))
  );
}

function decoratePool(state: NodeStateLike, stats: NodeStats): void {
  const ext = poolExt(state);
  stats.inFlight = ext.busy;
  stats.queued = ext.queue.length - ext.head;
}

/** Measured mean ms per served request over the window, or 0 when idle. */
function meanServedMs(ctx: BehaviourCtx, state: NodeStateLike): number {
  const served = ctx.counterRate(state, 'served');
  if (!(served > 0)) return 0;
  const ms = ctx.counterRate(state, 'servedMs') / served;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/* ================================================================== *
 * db -- a relational store with write lock contention
 *
 * The one thing a database does that a stateless service cannot: it
 * guards shared data. Reads share the slot pool freely. A WRITE entering
 * service pays `lockMs` of extra wait for every other write already in
 * flight -- row and page locks, stated as arithmetic -- so write latency
 * grows with write CONCURRENCY, not with load per se.
 *
 * The consequence this exists to teach: `instances` multiplies the slot
 * pool, so adding instances fixes a slow READ path -- but the lock is a
 * property of the data, shared across the whole fleet, so the write path
 * gets nothing. Watch lockWaitMs stay put while a scale-up halves read
 * latency, and the case for read replicas (split the reads out) and
 * sharding (split the DATA, and with it the lock) writes itself.
 *
 * Classification draws one unconditional roll against `readFraction`,
 * the same convention the replica set and search index follow, so replay
 * never depends on the slider's value.
 * ================================================================== */

interface DbExt extends PoolExt {
  /** Writes currently holding service slots. */
  writers: number;
}

function dbClassify(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const isWrite = ctx.roll() >= clamp01(num(state.config.readFraction, 0.9));
  ctx.markWrite(req, isWrite);
}

/**
 * At service start: judge contention against the writers holding slots at
 * this moment (not at admission -- a write that waited in the queue meets
 * the lock as it actually is when its turn comes).
 */
const dbStart = (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void => {
  ctx.countCustom(state, req.isWrite ? 'write' : 'read', 1);
  if (!req.isWrite) return;
  const ext = state.ext as DbExt;
  const lockMs = Math.max(0, num(state.config.lockMs, 0));
  const wait = lockMs * ext.writers;
  if (wait > 0) {
    ctx.addServiceDelay(req, wait);
    ctx.countCustom(state, 'lockWaitMs', wait);
  }
  ext.writers++;
};

const dbDrained = makeDrained(dbStart, (_ctx, state, req) => {
  if (!req.isWrite) return;
  const ext = state.ext as DbExt;
  if (ext.writers > 0) ext.writers--;
});

const db: ComponentBehaviour = {
  kind: 'db',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: (): DbExt => ({ ...initPool(), writers: 0 }),

  onAdmit(ctx, state, req): AdmitAction {
    return poolAdmit(ctx, state, req, dbClassify, dbStart, dbDrained);
  },

  onTick: reportPool,
  load: poolLoad,

  decorateStats(ctx, state, stats: NodeStats): void {
    decoratePool(state, stats);
    const writes = ctx.counterRate(state, 'write');
    stats.readRate = ctx.counterRate(state, 'read');
    stats.writeRate = writes;
    const waited = ctx.counterRate(state, 'lockWaitMs');
    const mean = writes > 0 ? waited / writes : 0;
    stats.lockWaitMs = Number.isFinite(mean) && mean > 0 ? mean : 0;
  },
};

/* ================================================================== *
 * searchindex -- a search cluster with asynchronous indexing
 *
 * A write is acknowledged when its (expensive) indexing work completes,
 * but the document only becomes SEARCHABLE `indexLagMs` after that
 * commit, which is the refresh interval of a real search engine. A
 * search hitting a key inside that window is served from the old index
 * and counted as stale: that counter is the indexing lag made visible.
 * ================================================================== */

interface SearchExt extends PoolExt {
  /** Searchability deadline per key; -Infinity means "never written". */
  visibleAt: Float64Array;
}

const searchDrained = makeDrained(
  // At service start: a SEARCH is judged against the index it is actually
  // reading right now. Judged here rather than at admission so a query
  // that waited in line long enough for the refresh to land counts fresh,
  // which is exactly how a real cluster behaves.
  (ctx, state, req) => {
    if (req.isWrite) return;
    const ext = state.ext as SearchExt;
    const stale = ctx.now < ext.visibleAt[req.key % KEYSPACE];
    ctx.countCustom(state, stale ? 'staleSearch' : 'freshSearch', 1);
  },
  // At service end: the write has committed, so the refresh clock starts
  // HERE. The admission-time claim below was only a lower bound.
  (ctx, state, req) => {
    if (!req.isWrite) return;
    const ext = state.ext as SearchExt;
    const lag = Math.max(0, num(state.config.indexLagMs, 0));
    const key = req.key % KEYSPACE;
    const visible = ctx.now + lag;
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  },
);

// The onStart hook runs inside searchDrained's pump as well; capture it once
// so admission and pump judge staleness identically.
const searchStart = (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void => {
  if (req.isWrite) return;
  const ext = state.ext as SearchExt;
  const stale = ctx.now < ext.visibleAt[req.key % KEYSPACE];
  ctx.countCustom(state, stale ? 'staleSearch' : 'freshSearch', 1);
};

function searchClassify(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  // One unconditional draw decides search vs write, the same convention the
  // replica set uses for read vs write.
  const isWrite = ctx.roll() >= clamp01(num(state.config.readFraction, 0.9));
  ctx.markWrite(req, isWrite);
  if (isWrite) {
    // Writes pay the indexing surcharge on top of the drawn serviceMs.
    ctx.addServiceDelay(req, Math.max(0, num(state.config.indexMs, 0)));
    ctx.countCustom(state, 'indexWrite', 1);
    // Claim a lower-bound searchability deadline immediately: a zero-ms
    // service completes synchronously inside serveWithin, so waiting for
    // the commit alone would let a same-instant search read a write that
    // has not even been acknowledged yet. Pushed to its true value (commit
    // time + lag) in the onServed hook above.
    const ext = state.ext as SearchExt;
    const lag = Math.max(0, num(state.config.indexLagMs, 0));
    const key = req.key % KEYSPACE;
    const visible = ctx.now + lag;
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  }
}

const searchindex: ComponentBehaviour = {
  kind: 'searchindex',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState(): SearchExt {
    const visibleAt = new Float64Array(KEYSPACE);
    visibleAt.fill(-Infinity);
    return { ...initPool(), visibleAt };
  },

  onAdmit(ctx, state, req): AdmitAction {
    return poolAdmit(ctx, state, req, searchClassify, searchStart, searchDrained);
  },

  onTick: reportPool,
  load: poolLoad,

  decorateStats(ctx, state, stats): void {
    decoratePool(state, stats);
    const fresh = ctx.counterRate(state, 'freshSearch');
    const stale = ctx.counterRate(state, 'staleSearch');
    const total = fresh + stale;
    stats.searchRate = total;
    stats.staleSearchRate = total > 0 ? stale / total : 0;
    stats.indexWriteRate = ctx.counterRate(state, 'indexWrite');
  },
};

/* ================================================================== *
 * timeseriesdb -- cheap appends, expensive range queries
 *
 * An append costs only the drawn serviceMs (fractions of the cost of a
 * row in a relational store); a range query pays `rangeQueryMs` on top,
 * for scanning and aggregating many points. A few percent of range
 * queries dominates the pool, which is the argument for keeping metrics
 * out of the main database stated as arithmetic.
 * ================================================================== */

const tsdbStart = (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void => {
  // Appends were marked as writes in classify; count what is actually
  // being SERVED, so the readout matches throughput rather than arrivals.
  ctx.countCustom(state, req.isWrite ? 'append' : 'rangeQuery', 1);
};

const tsdbDrained = makeDrained(tsdbStart, null);

function tsdbClassify(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  // One unconditional draw: is this a range query? Taken whatever the
  // slider says, so replay does not depend on its value.
  const isRange = ctx.roll() < clamp01(num(state.config.rangeQueryFraction, 0));
  ctx.markWrite(req, !isRange);
  if (isRange) {
    ctx.addServiceDelay(req, Math.max(0, num(state.config.rangeQueryMs, 0)));
  }
}

const timeseriesdb: ComponentBehaviour = {
  kind: 'timeseriesdb',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: initPool,

  onAdmit(ctx, state, req): AdmitAction {
    return poolAdmit(ctx, state, req, tsdbClassify, tsdbStart, tsdbDrained);
  },

  onTick: reportPool,
  load: poolLoad,

  decorateStats(ctx, state, stats): void {
    decoratePool(state, stats);
    stats.appendRate = ctx.counterRate(state, 'append');
    stats.rangeQueryRate = ctx.counterRate(state, 'rangeQuery');
  },
};

/* ================================================================== *
 * graphdb -- traversal cost grows with depth
 *
 * Edges visited grow roughly with outDegree^depth, so with the modelled
 * mean out-degree of 3 a query costs serviceMs * 3^(depth-1): depth 1 is
 * one neighbourhood, depth 2 (friends-of-friends) is 3x, depth 3 is 9x.
 * The multiplier is applied as a deterministic surcharge on top of the
 * drawn serviceMs, so the depth slider moves the mean without touching
 * the variance shape.
 * ================================================================== */

/** Modelled mean out-degree per hop. Fixed, so depth is the single knob. */
const GRAPH_FANOUT = 3;

function graphClassify(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const depth = Math.max(1, Math.floor(num(state.config.traversalDepth, 1)));
  const base = Math.max(0, state.config.serviceMs);
  const mult = Math.pow(GRAPH_FANOUT, Math.min(depth, 8) - 1);
  ctx.addServiceDelay(req, base * (mult - 1));
}

const graphDrained = makeDrained(null, null);

const graphdb: ComponentBehaviour = {
  kind: 'graphdb',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: initPool,

  onAdmit(ctx, state, req): AdmitAction {
    return poolAdmit(ctx, state, req, graphClassify, null, graphDrained);
  },

  onTick: reportPool,
  load: poolLoad,

  decorateStats(ctx, state, stats): void {
    decoratePool(state, stats);
    stats.traversalCostMs = meanServedMs(ctx, state);
  },
};

/* ================================================================== *
 * vectordb -- embedding search over a large index
 *
 * Cost model: an ANN index probes log2(2 + indexSizeK) partitions, and
 * the recall target multiplies how much of each partition must actually
 * be scanned, as 1 / (1 - recall). So mean query cost is
 *
 *   serviceMs * log2(2 + indexSizeK) / (1 - recallTarget)
 *
 * and the two knobs move it independently: growing the corpus is a
 * logarithm, chasing the last point of recall is a hyperbola. Recall is
 * clamped to 0.99, where the multiplier is already 100x.
 * ================================================================== */

function vectorClassify(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const sizeK = Math.max(0, num(state.config.indexSizeK, 0));
  const recall = Math.min(0.99, Math.max(0, num(state.config.recallTarget, 0)));
  const base = Math.max(0, state.config.serviceMs);
  const mult = Math.log2(2 + sizeK) / (1 - recall);
  if (mult > 1) ctx.addServiceDelay(req, base * (mult - 1));
}

const vectorDrained = makeDrained(null, null);

const vectordb: ComponentBehaviour = {
  kind: 'vectordb',
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: initPool,

  onAdmit(ctx, state, req): AdmitAction {
    return poolAdmit(ctx, state, req, vectorClassify, null, vectorDrained);
  },

  onTick: reportPool,
  load: poolLoad,

  decorateStats(ctx, state, stats): void {
    decoratePool(state, stats);
    stats.queryCostMs = meanServedMs(ctx, state);
  },
};

export const STORE_BEHAVIOURS: ComponentBehaviour[] = [
  db,
  objectstore,
  searchindex,
  timeseriesdb,
  graphdb,
  coldstorage,
  vectordb,
];
