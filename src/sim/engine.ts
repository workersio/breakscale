import {
  behaviourFor,
  canCrashOneInstance,
  type ComponentBehaviour,
} from './behaviour';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import { MinHeap, type Timed } from './heap';
import { cos, exp, pow } from './fdlibm';
import { sanitizeFaults } from './faults';
import { Rng } from './random';
import { DEFAULT_SEED, sanitizeSeed } from './seed';
import { DEFAULT_TRAFFIC_PERIOD_S } from './types';
import type {
  ActiveFailure,
  EdgeState,
  FailureCounts,
  FailureKind,
  FailureOpts,
  FailureReason,
  FaultEvent,
  HistoryPoint,
  NodeConfig,
  NodeStats,
  SimEdge,
  SimNode,
  RequestTrace,
  RoutePoint,
  RouteStats,
  RouteTally,
  RunTally,
  SimSnapshot,
  SystemStats,
  Topology,
  TraceHop,
} from './types';

/* ------------------------------------------------------------------ *
 * Tuning constants
 * ------------------------------------------------------------------ */

/** Wall-clock delta is clamped to this so a backgrounded tab cannot death-spiral. */
const MAX_DELTA_MS = 100;
/** Hard ceiling on events processed per advance() call. */
const MAX_EVENTS_PER_ADVANCE = 60000;
/** Hop-depth ceiling; deeper resolves as FailureReason 'depth'. */
const MAX_HOP_DEPTH = 32;
/**
 * Instance-count ceiling, matching the inspector's own slider.
 *
 * The engine writes one array element per instance on every snapshot, so an
 * unbounded count is an unbounded allocation. A design does not only come from
 * the editor: a shared link, a `.breakscale` file and a restored session all
 * carry `instances` straight through, and `isTopology` does not police it.
 */
const MAX_INSTANCES = 512;
/** Trailing window for latency percentiles. */
const LATENCY_WINDOW_MS = 5000;
/** Capacity of each latency ring buffer. */
const LATENCY_RING = 4096;
/** Max samples sorted per percentile computation; beyond this the window is strided. */
const PERCENTILE_SAMPLE_CAP = 512;
/** Latencies a tally holds before its first doubling: 40s at 100 rps. */
const TALLY_INITIAL = 4096;
/** Starting length of each client's own tally buffer; it doubles as needed. */
const TALLY_ROUTE_INITIAL = 1024;
/** Trailing window for rate (per-second) measurements. */
/* Traffic pattern shape. Chosen so a spike's MEAN over one cycle stays near
   the baseline: the reader compares the same work arriving unevenly, not more
   of it. 0.9 quiet at 0.1x plus 0.1 loud at 4x averages 0.49x, near enough
   that the comparison is about burstiness rather than volume. */
const SPIKE_QUIET_FRACTION = 0.9;
const SPIKE_PEAK = 4;
const SPIKE_TROUGH = 0.1;

/* A day swings between a quarter of the baseline and twice it. */
const DIURNAL_TROUGH = 0.25;
const DIURNAL_PEAK = 2;

const RATE_WINDOW_MS = 1000;
/** Number of buckets the rate window is split into. */
const RATE_BUCKETS = 10;
/** How often a HistoryPoint is appended. */
const HISTORY_INTERVAL_MS = 250;
/** How many HistoryPoints are retained (~60s). */
const HISTORY_MAX = 240;
/** Base delay before a retry is re-issued; doubles per attempt, with jitter. */
const RETRY_BASE_BACKOFF_MS = 25;
/** Guard so a runaway topology cannot allocate unbounded requests. */
const MAX_LIVE_REQUESTS = 200000;
/**
 * Size of the keyspace every client draws request keys from.
 *
 * Deliberately small. The point of a key is that collisions happen often
 * enough to be observable in a 30-second run: a read must frequently land on
 * a key that was just written (so replication lag produces visible stale
 * reads), and shard occupancy must be a meaningful distribution rather than
 * every request landing on its own partition. Drawn from the seeded RNG, so
 * the key stream is part of the deterministic replay.
 */
const KEYSPACE = 64;
/**
 * Shared empty vector for every kind that is not partitioned. snapshot() runs
 * at 10Hz over every node; handing them all one frozen array avoids an
 * allocation per node per frame for a field only shard nodes ever fill.
 */
const EMPTY_SHARDS: number[] = [];

/* ------------------------------------------------------------------ *
 * Event types
 * ------------------------------------------------------------------ */

const EV_ARRIVAL = 0;
const EV_SERVICE_DONE = 1;
const EV_TIMEOUT = 2;
const EV_WORKER_POLL = 3;
const EV_RETRY = 4;
/** A request finished traversing an edge with a latencyMs and is now offered. */
const EV_LINK_ARRIVE = 5;
/** A timer owned by a behaviour for a request it held at admission. */
const EV_BEHAVIOUR_WAKE = 6;

interface Ev extends Timed {
  time: number;
  seq: number;
  kind: number;
  /** Node this event targets. */
  nodeId: string;
  /** Request this event concerns (null for arrivals / worker polls). */
  req: Req | null;
  /** Monotonic guard so a stale timer for a recycled request is ignored. */
  token: number;
}

/* ------------------------------------------------------------------ *
 * Request object (pooled)
 * ------------------------------------------------------------------ */

interface Req {
  /** Unique-per-incarnation id; bumped on every reuse so stale timers die. */
  token: number;
  /** Node currently handling this request. */
  nodeId: string;
  /** Parent request that issued this call, or null for a client root / queue message. */
  parent: Req | null;
  /** Number of child calls still outstanding. */
  pending: number;
  /** Largest latency reported by any resolved child (fan-out join). */
  maxChildMs: number;
  /** True once any child failed. */
  childFailed: boolean;
  /** Failure reason bubbled up from a child. */
  childReason: FailureReason;
  /** Simulated time this request entered its current node. */
  enterMs: number;
  /**
   * Simulated time this request ARRIVED at its current node, kept separate
   * from enterMs because startService overwrites that one when the work
   * actually begins. The gap between the two is the time the request spent
   * waiting in line, which is the single number the tracer exists to show:
   * latency under load is mostly queueing, not service, and nothing in the
   * interface said so.
   */
  arriveMs: number;
  /**
   * Hops recorded so far, for the ONE request being traced, else null.
   *
   * Only the sampled request allocates this array. Tracing every request
   * would put an allocation and a push on the hot path for data that is
   * thrown away, and `advance()` runs per frame.
   */
  trace: TraceHop[] | null;
  /** Simulated time the root request was generated (client only). */
  rootStartMs: number;
  /** Hop depth from the client root. */
  hop: number;
  /** Which retry attempt this call represents at the parent. */
  attempt: number;
  /** True once the parent stopped waiting (timeout). Work continues, result discarded. */
  abandoned: boolean;
  /** Set while the request occupies a server slot, so release is idempotent. */
  holdingSlot: boolean;
  /**
   * The node whose slot this request holds, engine-managed or kept in `ext`,
   * or null once it is released. Set wherever a slot is taken (startService,
   * beginZeroService, serveWithin) and cleared by releaseHeld(), so a slot is
   * always given back to the state that granted it. That matters when a node
   * is retyped or removed mid-request: the id then names a different state,
   * or none, and releasing by id would decrement a counter this request never
   * incremented.
   */
  heldAt: NodeState | null;
  /**
   * True while the request's own work is done but its slot stays held,
   * because its node blocks on downstream calls that have not all answered.
   * Such a request sits on its node's parked list (parkPrev / parkNext).
   */
  parked: boolean;
  parkPrev: Req | null;
  parkNext: Req | null;
  /**
   * Set when the node lost this request's thread while it was parked: a crash
   * ('crashed') or the node being removed ('no-route'). The slot was reclaimed
   * at that moment; the request still waits for its children, because they
   * would otherwise join into a recycled parent, and then fails with this
   * reason instead of succeeding. Null on every ordinary request.
   */
  lostReason: FailureReason | null;
  /**
   * Which instance of `heldAt` this request's work is on, or -1 while it
   * holds no slot. Placed when service starts and given back with the slot,
   * so a 'crash-instance' fault can fail exactly the work its machine held.
   */
  instance: number;
  /** Edge this request traversed to reach nodeId, for edgeFlow accounting. */
  viaEdge: string;
  /** True when this request is a detached queue message being drained by a worker. */
  detached: boolean;
  /**
   * The tally a write-behind cache acked this detached copy under, so its
   * landing is counted there even after the tally stops. Null on every
   * request but those copies, and on them too when no tally ran.
   */
  ackedIn: Tally | null;
  /**
   * The tally a queue accepted this buffered message under, so a job that
   * fails behind the ack is counted there, past the tally's stop too. Null on
   * every request but those messages, and on them too when no tally ran.
   */
  queuedIn: Tally | null;
  /** Node that must be re-called on retry (the downstream target). */
  retryTarget: string;
  /** Attempt number for a scheduled retry. */
  retryAttempt: number;
  /** Own service time already spent at this node, part of parent latency accounting. */
  ownMs: number;
  /** Free-list link. */
  next: Req | null;
  /** Guards double resolution. */
  resolved: boolean;
  /**
   * Partition / cache key this request concerns. Drawn once by the client
   * from `KEYSPACE` and inherited unchanged by every downstream call, so a
   * shard or replica set several hops away partitions on the key the client
   * actually asked for. Kinds that do not partition by key ignore it.
   */
  key: number;
  /** True when this request is a write. Classified once, inherited downstream. */
  isWrite: boolean;
  /**
   * Extra work (ms) a behaviour asked for at this node, consumed when its
   * service starts. Stretched by a 'slow' fault like the drawn time.
   */
  extraServiceMs: number;
  /**
   * Extra waiting (ms) inside service that is not this node's own work, such
   * as a write's lock wait or a write-behind flush delay. Consumed when its
   * service starts, and never stretched by a 'slow' fault.
   */
  extraWaitMs: number;
  /**
   * Callback a self-managing kind (a sharded store) registers via
   * serveWithin(), fired when this request's service time elapses so the
   * behaviour can release its own slot. Null for the ordinary path.
   */
  onDrained: ((ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void) | null;
}

/* ------------------------------------------------------------------ *
 * Rate counter: bucketed trailing window
 * ------------------------------------------------------------------ */

class RateCounter {
  private buckets = new Float64Array(RATE_BUCKETS);
  private stamps = new Float64Array(RATE_BUCKETS).fill(-1);
  private bucketMs = RATE_WINDOW_MS / RATE_BUCKETS;

  add(now: number, n: number): void {
    const stamp = Math.floor(now / this.bucketMs);
    const idx = ((stamp % RATE_BUCKETS) + RATE_BUCKETS) % RATE_BUCKETS;
    if (this.stamps[idx] !== stamp) {
      this.stamps[idx] = stamp;
      this.buckets[idx] = 0;
    }
    this.buckets[idx] += n;
  }

  /**
   * Events per second over the trailing window.
   *
   * Every counter divides by the SAME fixed span, so rates from different
   * counters stay comparable and their ratios mean something -- goodput can
   * never exceed offered just because one of them happened to be idle for
   * part of the window. The in-progress bucket is excluded rather than
   * scaled: a partially elapsed bucket read as if it were whole is what
   * makes a live rate flicker.
   */
  rate(now: number): number {
    const current = Math.floor(now / this.bucketMs);
    let total = 0;
    for (let i = 0; i < RATE_BUCKETS; i++) {
      const age = current - this.stamps[i];
      // Sum only the fully elapsed buckets. age === 0 is the bucket still
      // filling: reading a partially elapsed bucket as if it were whole is
      // what makes a live rate flicker at the sampling boundary.
      if (age > 0 && age < RATE_BUCKETS) {
        total += this.buckets[i];
      }
    }
    if (total === 0) return 0;
    // Divide by exactly the span the numerator covers. Two things this must
    // not do: divide by how many buckets happened to receive events (a quiet
    // bucket is a real zero and has to pull the average down, or bursty
    // traffic reads several times high), or include the in-progress bucket
    // the events could not have landed in (which under-reports every rate by
    // one bucket's worth). Every counter uses this same span, so goodput can
    // never exceed offered merely because one of them was briefly idle.
    const elapsedBuckets = Math.max(1, Math.min(RATE_BUCKETS - 1, current));
    return (total * 1000) / (elapsedBuckets * this.bucketMs);
  }

  reset(): void {
    this.buckets.fill(0);
    this.stamps.fill(-1);
  }
}

/* ------------------------------------------------------------------ *
 * Latency reservoir: ring buffer with timestamps, exact percentiles
 * ------------------------------------------------------------------ */

class LatencyRing {
  private vals = new Float64Array(LATENCY_RING);
  private times = new Float64Array(LATENCY_RING);
  private head = 0;
  private count = 0;
  private scratch = new Float64Array(LATENCY_RING);
  /** Monotonic count of samples ever added; part of the memo key. */
  private added = 0;
  private cacheTime = -1;
  private cacheAdded = -1;
  private cache0 = 0;
  private cache1 = 0;
  private cache2 = 0;

  add(now: number, v: number): void {
    this.vals[this.head] = v;
    this.times[this.head] = now;
    this.head = (this.head + 1) % LATENCY_RING;
    if (this.count < LATENCY_RING) this.count++;
    this.added++;
  }

  /**
   * Fills out[0..2] with p50/p95/p99 over the trailing window.
   *
   * Results are memoized per (time, sample count): snapshot() is polled at
   * 10Hz and asks every node for percentiles, but the underlying samples only
   * change when a request completes. Re-sorting an unchanged window would
   * dominate the frame budget.
   */
  percentiles(now: number, out: Float64Array): void {
    if (now === this.cacheTime && this.added === this.cacheAdded) {
      out[0] = this.cache0;
      out[1] = this.cache1;
      out[2] = this.cache2;
      return;
    }

    const cutoff = now - LATENCY_WINDOW_MS;
    const s = this.scratch;
    let n = 0;
    // Walk newest-first and stop at the window edge. Sampling is capped: a
    // few hundred points give the same percentiles as several thousand, and
    // this keeps snapshot() cheap at 10Hz under heavy traffic.
    const limit =
      this.count < PERCENTILE_SAMPLE_CAP ? this.count : PERCENTILE_SAMPLE_CAP;
    const stride =
      this.count > PERCENTILE_SAMPLE_CAP
        ? Math.floor(this.count / PERCENTILE_SAMPLE_CAP)
        : 1;
    for (let i = 0, taken = 0; taken < limit && i < this.count; i += stride) {
      const idx = (this.head - 1 - i + LATENCY_RING * 2) % LATENCY_RING;
      if (this.times[idx] < cutoff) break;
      s[n++] = this.vals[idx];
      taken++;
    }
    if (n === 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    } else {
      // sort() on a subarray sorts in place over the shared buffer without
      // allocating a copy.
      const view = s.subarray(0, n);
      view.sort();
      out[0] = quantile(view, n, 0.5);
      out[1] = quantile(view, n, 0.95);
      out[2] = quantile(view, n, 0.99);
    }

    this.cacheTime = now;
    this.cacheAdded = this.added;
    this.cache0 = out[0];
    this.cache1 = out[1];
    this.cache2 = out[2];
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.added = 0;
    this.cacheTime = -1;
    this.cacheAdded = -1;
  }
}

function quantile(sorted: Float64Array, n: number, q: number): number {
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/* ------------------------------------------------------------------ *
 * Injected failures
 *
 * Chaos is engine state, not a component: it is attached to a node id, so a
 * node can be faulted and healed without the topology changing shape. The
 * engine keeps one record per faulted node, plus a flat Set of cut edge ids
 * so the send path can test a partition with a single Set lookup.
 * ------------------------------------------------------------------ */

/** A tally while it is recorded. `latencies` is filled up to `completed`. */
interface Tally {
  fromMs: number;
  /** -1 while running. */
  toMs: number;
  arrived: number;
  completed: number;
  failed: number;
  failures: Partial<Record<FailureReason, number>>;
  latencies: Float64Array;
  /** Writes a write-behind cache said were saved while this tally ran. */
  writesAcked: number;
  /**
   * How many of those reached the store. Counted for as long as the engine
   * runs, past the tally's stop, since a write acked near the end of the
   * window is still on its way to the store then.
   */
  writesLanded: number;
  /** Jobs a queue accepted while this tally ran. */
  jobsQueued: number;
  /**
   * How many of `jobsQueued` failed once a worker took them. Counted past the
   * tally's stop, like `writesLanded`.
   */
  jobsFailed: number;
  /** The same record per client, by node id, created on its first request. */
  routes: Map<string, TallyCounts>;
}

/** The part of a tally that is kept for the whole system and per client. */
interface TallyCounts {
  arrived: number;
  completed: number;
  failed: number;
  failures: Partial<Record<FailureReason, number>>;
  latencies: Float64Array;
}

/** A client's counts in `t`, created the first time that client is seen. */
function tallyRoute(t: Tally, clientId: string): TallyCounts {
  let r = t.routes.get(clientId);
  if (r === undefined) {
    r = {
      arrived: 0,
      completed: 0,
      failed: 0,
      failures: {},
      latencies: new Float64Array(TALLY_ROUTE_INITIAL),
    };
    t.routes.set(clientId, r);
  }
  return r;
}

function tallyLatency(t: TallyCounts, ms: number): void {
  if (t.completed === t.latencies.length) {
    // Doubling keeps the copies to about one per element over a whole run.
    const grown = new Float64Array(t.latencies.length * 2);
    grown.set(t.latencies);
    t.latencies = grown;
  }
  t.latencies[t.completed++] = ms;
}

function tallyFailure(t: TallyCounts, reason: FailureReason): void {
  t.failed++;
  t.failures[reason] = (t.failures[reason] ?? 0) + 1;
}

/* ------------------------------------------------------------------ *
 * Routes
 *
 * Each client is a route, and these are its own end-to-end figures: what
 * the people behind that client saw. Counted at the same place the system
 * figures are, so the routes always add up to the system. Nothing here
 * draws from the RNG or reaches the snapshot.
 * ------------------------------------------------------------------ */

interface RouteState {
  good: RateCounter;
  failed: RateCounter;
  latency: LatencyRing;
  /** Failures per reason, created the first time a reason happens here. */
  failedBy: Map<FailureReason, RateCounter>;
  totalRequests: number;
  totalCompleted: number;
  totalFailed: number;
  failures: Partial<Record<FailureReason, number>>;
  history: RoutePoint[];
}

function createRouteState(): RouteState {
  return {
    good: new RateCounter(),
    failed: new RateCounter(),
    latency: new LatencyRing(),
    failedBy: new Map(),
    totalRequests: 0,
    totalCompleted: 0,
    totalFailed: 0,
    failures: {},
    history: [],
  };
}

function routeFailed(r: RouteState, now: number, reason: FailureReason): void {
  r.failed.add(now, 1);
  let c = r.failedBy.get(reason);
  if (c === undefined) {
    c = new RateCounter();
    r.failedBy.set(reason, c);
  }
  c.add(now, 1);
  r.totalFailed++;
  r.failures[reason] = (r.failures[reason] ?? 0) + 1;
}

interface Fault {
  kind: FailureKind;
  /** Simulated time the fault was injected. */
  sinceMs: number;
  /** 'slow': service-time multiplier, >= 1. */
  factor: number;
  /** 'errors': forced failure fraction, 0..1. */
  rate: number;
  /** 'partition': edge ids cut. Empty means "every edge leaving the node". */
  edgeIds: string[];
}

/* ------------------------------------------------------------------ *
 * Per-node runtime state
 * ------------------------------------------------------------------ */

interface NodeState {
  id: string;
  kind: SimNode['kind'];
  /**
   * This kind's behaviour, resolved once at buildNodes() time. The event loop
   * reads policy through this reference only -- there is no per-event map
   * lookup and no `kind === ...` test anywhere on the hot path.
   */
  behaviour: ComponentBehaviour;
  config: NodeConfig;
  /** Requests occupying a server slot right now. */
  busy: number;
  /**
   * How many of the slots held at this node belong to parked requests: their
   * own work is done and they are waiting on downstream calls. Included in
   * `busy` for a kind the engine slots itself (admission and least-loaded
   * routing must see a stuck thread as load) and subtracted wherever work is
   * measured. Only a kind whose behaviour blocks on downstream calls parks.
   */
  parked: number;
  /** Head of the intrusive list of parked requests, so a crash can reclaim them. */
  parkHead: Req | null;
  /**
   * Set on a state the moment a topology edit drops it, before anything it
   * held is failed. Failing those requests runs other nodes' code, which can
   * route back here through the old node map; this flag is what stops a dead
   * state admitting or starting work.
   */
  discarded: boolean;
  /**
   * The call cycle this node sits on, as an index shared by every node on the
   * same one, or -1 when no chain of calls leads from it back to itself.
   * Rebuilt with the topology. A thread parked on a cycle can end up waiting
   * on a thread that waits on it, so admission treats these nodes with care.
   */
  cycle: number;
  /** FIFO of requests waiting for a slot (service/db/worker) or buffered messages (queue). */
  waiting: Req[];
  /** Read cursor into `waiting`, so dequeue is O(1) without splice. */
  waitHead: number;
  /**
   * Outgoing REQUEST edges, resolved from the topology. Control edges are
   * deliberately absent: this is the routing set, and everything that
   * dispatches work walks it, so keeping them out here is what makes "no
   * request is ever sent down a control edge" true by construction rather
   * than by every routing site remembering to check.
   */
  out: SimEdge[];
  /**
   * Outgoing CONTROL edges -- "this node acts on that one". Held apart from
   * `out` because they are a different relationship, not a weaker one: an
   * autoscaler finds its target here, and nothing that routes traffic ever
   * looks at this list.
   */
  ctrl: SimEdge[];
  /** Queue nodes that feed this worker. */
  sources: string[];
  /** Integrated busy-slot-milliseconds, for utilization. */
  busyMsAccum: number;
  /** Simulated time busyMsAccum was last integrated. */
  lastIntegrateMs: number;
  /** Rolling utilization sample, recomputed each stats tick. */
  utilization: number;

  arrivals: RateCounter;
  completions: RateCounter;
  errors: RateCounter;
  sheds: RateCounter;
  timeouts: RateCounter;
  hits: RateCounter;
  misses: RateCounter;

  latency: LatencyRing;

  totalCompleted: number;
  totalFailed: number;

  /** Identifies the arrival stream for this incarnation of a load generator. */
  arrivalGeneration: number;
  /** True once a worker poll event is scheduled, so we do not stack pollers. */
  pollScheduled: boolean;
  /**
   * Per-shard utilisation published by a self-partitioning behaviour, 0..1.
   * Empty for every kind that is not partitioned; the engine only copies it
   * into the snapshot and has no opinion about what a shard is.
   */
  shardUtil: number[];

  /* ---- instance model ---- *
   *
   * The vector is held in two halves on purpose. `instanceUnits` is the
   * engine's own working copy, mutated in place every frame at no allocation
   * cost; `instancePublished` is the array actually handed to the snapshot,
   * and is replaced with a fresh array ONLY when the contents changed.
   *
   * That split is what makes the field both cheap and correct. Publishing the
   * working copy directly would be the aliasing bug that once froze the
   * canvas: a memoised consumer holding last frame's NodeStats would find the
   * same array identity with silently different contents, compare equal, and
   * never re-render. Allocating unconditionally would be honest but would
   * churn one array per node per frame at 10Hz forever. Copy-on-change gives
   * a new identity exactly when there is something new to see.
   */

  /** Working per-unit utilisation, mutated in place. Length is the unit count. */
  instanceUnits: number[];
  /** The array published to the last snapshot, or null if none yet. */
  instancePublished: number[] | null;
  /** Units decided but not yet serving (autoscaler warm-up). */
  instancePending: number;
  /** `instancePending` as last published, so a change in it alone is noticed. */
  instancePendingPublished: number;

  /**
   * Work held on each instance right now, indexed by `Req.instance`: requests
   * in service and threads parked on downstream calls. Null until the node
   * first serves. It never shrinks, so work on an instance a scale-down
   * removed is still counted until it finishes.
   *
   * The node's slots stay one pool, and admission still compares the whole
   * node's work against `instances * capacity`. This only records which
   * machine each slot is on, which is what losing one machine needs to know.
   */
  instanceBusy: Int32Array | null;
  /** Where the next placement starts looking, so work is spread round the fleet. */
  instanceNext: number;
  /**
   * 1 while a 'crash-instance' fault holds instance 0 down, else 0. A copy of
   * the fault map kept on the state, because effectiveCapacity() reads it on
   * every admission.
   */
  instancesDown: number;

  /**
   * Behaviour-private scratch state, allocated once from the behaviour's
   * initState() hook. The engine never reads or interprets it. This is what
   * lets a stateful kind (an autoscaler's cooldown clock, a region's failover
   * deadline, a token bucket) exist without NodeState growing a field per
   * kind -- the same thicket the registry refactor removed from the loop.
   */
  ext: unknown;

  /**
   * Behaviour-defined rate counters, created on first use. Namespaced per
   * node, so two behaviours can never collide over a name.
   */
  custom: Map<string, RateCounter> | null;

  /**
   * Occupancy reported by a kind that runs its own slot discipline, or null
   * for every kind the engine slots itself.
   *
   * Set through reportOccupancy(). When present it replaces `state.busy` in
   * the utilisation integration, which is what stops a replica set or a
   * sharded store -- whose slots live in `ext`, invisible to state.busy --
   * from reporting 0.0 while saturated and fooling an autoscaler into
   * scaling it down.
   */
  ownOccupancy: { busy: number; capacity: number } | null;

  /** This client's route figures, or null for a kind that sends no load. */
  route: RouteState | null;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export class Engine implements BehaviourCtx {
  private topology: Topology;
  private seed: number;
  private rng: Rng;

  /** Current simulated time in ms. Part of BehaviourCtx; never written from outside. */
  now = 0;
  private seq = 0;
  private heap = new MinHeap<Ev>();

  private nodes = new Map<string, NodeState>();
  private clientIds: string[] = [];
  private nextArrivalGeneration = 1;
  /**
   * Nodes whose behaviour declares onTick. Kept as a separate list so the
   * per-advance walk costs nothing at all while no such kind exists.
   */
  private tickNodes: NodeState[] = [];
  private edgeFlow = new Map<string, RateCounter>();

  private freeReq: Req | null = null;
  private freeEv: Ev[] = [];
  private liveRequests = 0;

  /** Root-level (end-to-end) measurements. */
  private sysLatency = new LatencyRing();
  private sysOffered = new RateCounter();
  private sysGood = new RateCounter();
  private sysFailed = new RateCounter();
  private totalRequests = 0;
  private totalFailed = 0;
  /**
   * The tally being recorded, or null, which is every run that never asked
   * for one. The root paths test this and nothing else, so a run without a
   * tally does one comparison per request more than it did before.
   */
  private tally: Tally | null = null;
  /** The last tally stopped, kept for readTally() until the next starts. */
  private tallyStopped: Tally | null = null;
  private failures: FailureCounts = {
    error: 0,
    shed: 0,
    timeout: 0,
    'no-route': 0,
    depth: 0,
    throttled: 0,
    rejected: 0,
    crashed: 0,
    partitioned: 0,
    'region-down': 0,
    'conn-refused': 0,
    unauthorized: 0,
    'bulkhead-full': 0,
    'acquire-timeout': 0,
    deprioritized: 0,
  };

  /** Injected failures, keyed by node id. At most one fault per node. */
  private faults = new Map<string, Fault>();
  /**
   * Every edge id cut by an active partition, flattened out of `faults` so the
   * send path tests a partition with one Set lookup instead of walking faults.
   * Rebuilt whenever faults or the topology change.
   */
  private cutEdges = new Set<string>();
  /** Reused snapshot array for active failures. */
  private snapFailures: ActiveFailure[] = [];
  /**
   * Edges severed one at a time by cutEdge(), independent of any node fault.
   * Folded into `cutEdges` with the partitions, so the send path still asks
   * one Set and never learns which of the two cut the wire.
   */
  private severed = new Set<string>();

  /**
   * The fault schedule, sorted by `atMs` (stable, so entries sharing a time
   * keep their list order). Everything before `scheduleNext` has been applied
   * this run; `nextFaultMs` caches the time of the entry at `scheduleNext`, or
   * Infinity, so the event loop pays one number comparison per event for it
   * and nothing more when the schedule is empty.
   */
  private schedule: FaultEvent[] = [];
  private scheduleNext = 0;
  private nextFaultMs = Infinity;
  /**
   * Simulated time through which the schedule has been played. An entry at
   * or before it is in the past. Separate from `now` because a fresh engine
   * at t=0 has played nothing yet, while one that has just advanced TO some
   * time has already applied the entries due at it.
   */
  private scheduleThroughMs = -Infinity;

  private history: HistoryPoint[] = [];
  private lastHistoryMs = 0;

  private pctScratch = new Float64Array(3);
  private nodePctScratch = new Float64Array(3);
  private routePctScratch = new Float64Array(3);

  /** Reused snapshot containers so 10Hz polling does not churn the heap. */
  private snapNodes: Record<string, NodeStats> = {};
  private snapEdges: Record<string, number> = {};
  private snapEdgeState: Record<string, EdgeState> = {};

  /**
   * Capacity each node was authored with, by node id.
   *
   * A controller (the autoscaler) writes the capacity it has decided on back
   * into `this.topology`, so the Inspector shows the size the node actually
   * has rather than the one it started at. That write is correct for the live
   * run and wrong for reset(): rebuilding from the mutated topology would
   * restart the simulation at whatever capacity the controller happened to
   * have reached, so the same seed would not replay. Recording the authored
   * value at construction -- and at every setTopology, which is the only other
   * time the student states an intent -- lets reset() put it back.
   */
  private authoredCapacity = new Map<string, number>();
  /** Same, for the per-shard knob a sharded store is scaled through. */
  private authoredShardCapacity = new Map<string, number>();
  /**
   * Same, for the instance count a plain service is scaled through. `instances`
   * is optional in NodeConfig, so an entry can be `undefined`: that records
   * "the preset left it unset", and reset() has to put the field back to unset
   * rather than skip it, because a scale-up will have written a number there.
   */
  private authoredInstances = new Map<string, number | undefined>();

  /**
   * `seed`, when given, wins over the topology's own. Without either the run
   * uses DEFAULT_SEED, which is what every engine did before a topology could
   * carry one.
   */
  constructor(topology: Topology, seed?: number) {
    this.seed = (seed ?? sanitizeSeed(topology.seed) ?? DEFAULT_SEED) >>> 0;
    this.rng = new Rng(this.seed);
    this.topology = cloneTopology(topology);
    this.recordAuthoredCapacity();
    this.buildNodes(null);
    this.loadSchedule(sortedSchedule(topology.faults));
  }

  /**
   * Snapshot the authored scale of every node, for reset() to restore.
   *
   * All three scalable knobs are recorded, because a controller may write any
   * one depending on the target kind's `scaleField`. Restoring only `capacity`
   * would let a controller-scaled sharded store carry its grown `shardCapacity`
   * across a reset, or an autoscaled service its grown `instances`, so the same
   * seed would not replay.
   */
  private recordAuthoredCapacity(): void {
    this.authoredCapacity.clear();
    this.authoredShardCapacity.clear();
    this.authoredInstances.clear();
    for (const n of this.topology.nodes) {
      this.authoredCapacity.set(n.id, n.config.capacity);
      this.authoredShardCapacity.set(n.id, n.config.shardCapacity);
      this.authoredInstances.set(n.id, n.config.instances);
    }
  }

  /**
   * The authored value of whichever knob a kind scales along, or undefined when
   * the preset left it unset. The hot-swap preserve rule in buildNodes() reads
   * this to tell a controller write (which moves state.config but not the
   * authored map) from a student edit (which moves both).
   */
  private authoredScale(
    nodeId: string,
    field: 'instances' | 'shardCapacity',
  ): number | undefined {
    return field === 'shardCapacity'
      ? this.authoredShardCapacity.get(nodeId)
      : this.authoredInstances.get(nodeId);
  }

  /* ---------------- public API ---------------- */

  setTopology(t: Topology): void {
    const previous = this.nodes;
    const wasDown = this.instanceCrashState();
    this.topology = cloneTopology(t);
    this.recordAuthoredCapacity();
    this.buildNodes(previous);
    // Faults survive a topology edit, but a whole-node partition names its
    // edges implicitly, so the flattened set has to be recomputed against the
    // new wiring. A fault on a node that no longer exists is dropped, and so
    // is a cut on an edge that no longer exists.
    const droppedNodes: string[] = [];
    const droppedEdges: string[] = [];
    for (const [nodeId, fault] of [...this.faults]) {
      const state = this.nodes.get(nodeId);
      // A node retyped to a kind that cannot lose one instance has no
      // machine left down, so its fault goes the way a removed node's does.
      if (
        !state ||
        (fault.kind === 'crash-instance' && !canCrashOneInstance(state.kind))
      ) {
        this.faults.delete(nodeId);
        droppedNodes.push(nodeId);
      }
    }
    // A state built fresh by this edit (a retyped node) starts with nothing
    // down, so the copy of the fault map is written again for every node.
    for (const state of this.nodes.values()) {
      state.instancesDown =
        this.faults.get(state.id)?.kind === 'crash-instance' ? 1 : 0;
    }
    for (const [id, down] of wasDown) {
      const state = this.nodes.get(id);
      if (state !== undefined && state === previous.get(id)) {
        this.refitInstanceCrash(state, down);
      }
    }
    if (this.severed.size > 0) {
      const edgeIds = new Set(this.topology.edges.map((e) => e.id));
      for (const id of [...this.severed]) {
        if (!edgeIds.has(id)) {
          this.severed.delete(id);
          droppedEdges.push(id);
        }
      }
    }
    this.rebuildCutEdges();

    // The schedule follows the same rule as everything else here: an edit
    // changes what happens next, never what already happened.
    //
    //   faults absent    the schedule is kept as it is, recordings included,
    //                    so a shell that does not know about schedules can
    //                    keep calling this on every edit.
    //   the same list    nothing changes, so a shell that does carry the
    //                    schedule in its topology does not replay it per edit.
    //   a new list       it replaces the schedule. Entries at or before the
    //                    time already played are treated as past and skipped,
    //                    not applied late; faults in force stay in force.
    //
    // An entry naming a node or edge that this edit removed stays in the
    // schedule and does nothing when it comes due.
    if (t.faults !== undefined) {
      const next = sortedSchedule(t.faults);
      if (JSON.stringify(next) !== JSON.stringify(this.schedule)) {
        this.loadSchedule(next);
        let i = 0;
        while (
          i < this.schedule.length &&
          this.schedule[i].atMs <= this.scheduleThroughMs
        ) {
          i++;
        }
        this.scheduleNext = i;
        this.nextFaultMs = i < this.schedule.length ? this.schedule[i].atMs : Infinity;
      }
    }

    // Dropping a fault with its node, or a cut with its edge, heals it live.
    // Where the schedule played that fault, it also gets the entry that heals
    // it, or a node or edge added back under the same id would come back
    // healthy here and broken in every replay of the schedule.
    for (const nodeId of droppedNodes) {
      if (this.playedLast(nodeId, 'node') === 'inject') {
        this.appendRecorded({ atMs: this.now, action: 'clear', nodeId });
      }
    }
    for (const edgeId of droppedEdges) {
      if (this.playedLast(edgeId, 'edge') === 'cut') {
        this.appendRecorded({ atMs: this.now, action: 'restore', edgeId });
      }
    }

    // A seed in the topology is the seed the NEXT run starts from. The run in
    // progress has already drawn from the old one, and reseeding it halfway
    // would give a trajectory no single seed reproduces, so it takes effect
    // at reset(). Absent means keep the current seed, as with faults.
    const seed = sanitizeSeed(t.seed);
    if (seed !== undefined) this.seed = seed;
  }

  updateNodeConfig(id: string, patch: Partial<NodeConfig>): void {
    const node = this.topology.nodes.find((n) => n.id === id);
    if (node) Object.assign(node.config, patch);
    // A scale value the student typed is a new authored value, so reset() should
    // return to it rather than to the one the preset shipped with, and a later
    // hot swap should treat it as authored, not as a controller write. A value
    // written by a controller goes through setScale() and deliberately does NOT
    // land here.
    if (patch.capacity !== undefined) {
      this.authoredCapacity.set(id, Math.max(1, Math.floor(patch.capacity)));
    }
    if (patch.shardCapacity !== undefined) {
      this.authoredShardCapacity.set(id, Math.max(1, Math.floor(patch.shardCapacity)));
    }
    if (patch.instances !== undefined) {
      this.authoredInstances.set(id, Math.max(1, Math.floor(patch.instances)));
    }
    const state = this.nodes.get(id);
    if (!state) return;
    const fault = this.faults.get(id);
    const wasDown = fault !== undefined && this.downBy(fault, state);
    Object.assign(state.config, patch);
    this.refitInstanceCrash(state, wasDown);
    // A capacity increase may free up slots for waiting work immediately.
    this.pumpQueue(state);
  }

  /* ---------------- failure injection ---------------- *
   *
   * Chaos is a first-class engine operation rather than a component, so any
   * node in any topology can be faulted without rewiring anything. Each fault
   * intercepts at exactly one point in the request path, which is what makes
   * it compose with retries, timeouts and a circuit breaker for free:
   *
   *   crash      admit() refuses immediately, and in-flight work at the node
   *              is failed at injection time. The caller sees a failed call
   *              like any other, so its retry budget and its breaker's error
   *              window both observe it.
   *   crash-instance
   *              effectiveCapacity() drops by one machine's slots, and the
   *              work that machine held fails at injection time. Admission
   *              is otherwise untouched: the node keeps serving on the rest.
   *   slow       serviceTimeFor() and ownServiceMs() multiply the node's own
   *              work: the drawn service time and any surcharge its kind
   *              adds, on every path, the self-managed stores included.
   *              Nothing else changes, so the caller's timeout starts firing
   *              on its own -- which is the lesson.
   *   errors     onServiceComplete() rolls it after the node's own errorRate.
   *   partition  sendChild() refuses to cross a cut edge, so the CALLER sees
   *              the failure. That is what a network partition looks like
   *              from one side, and it leaves the target node untouched.
   * ------------------------------------------------------ */

  /**
   * Attach a fault to a node. One fault per node: injecting again replaces
   * whatever was there, so the UI never has to reason about stacking.
   * Returns false, changing nothing, when there is no such node or it is a
   * kind that cannot lose one instance and the fault is 'crash-instance'.
   */
  injectFailure(nodeId: string, kind: FailureKind, opts: FailureOpts = {}): boolean {
    const state = this.nodes.get(nodeId);
    if (!state) return false;
    if (kind === 'crash-instance' && !canCrashOneInstance(state.kind)) return false;

    const fault: Fault = {
      kind,
      sinceMs: this.now,
      // A fault may not make a node faster, so a factor below 1 is clamped.
      factor: opts.factor !== undefined && opts.factor > 1 ? opts.factor : 1,
      rate: opts.rate !== undefined ? clamp01(opts.rate) : 1,
      edgeIds: opts.edgeIds ? opts.edgeIds.slice() : [],
    };
    this.faults.set(nodeId, fault);
    state.instancesDown = kind === 'crash-instance' ? 1 : 0;
    this.rebuildCutEdges();

    // A crash is retroactive: work already inside the node dies with it.
    // Without this the node would keep answering for one service time after
    // being killed, and a student watching the graph would see the failure
    // arrive late for no visible reason.
    if (kind === 'crash') this.killInFlight(nodeId);
    else if (kind === 'crash-instance') this.killOneInstance(state);
    return true;
  }

  /** Heal a node. Work that already failed stays failed; new work succeeds. */
  clearFailure(nodeId: string): void {
    if (!this.faults.delete(nodeId)) return;
    this.rebuildCutEdges();
    const state = this.nodes.get(nodeId);
    if (!state) return;
    state.instancesDown = 0;
    // A healed node may have callers' work waiting on it right now.
    this.pumpQueue(state);
  }

  /**
   * Sever one edge, request or control, without faulting either end. Returns
   * false when there is no such edge or it is already severed. This is the
   * single-cable case a node's 'partition' cannot express cleanly: that one
   * occupies the node's only fault slot, so it would evict a 'slow' already
   * there, and its edges heal together when the fault clears.
   */
  cutEdge(edgeId: string): boolean {
    if (this.severed.has(edgeId)) return false;
    if (!this.topology.edges.some((e) => e.id === edgeId)) return false;
    this.severed.add(edgeId);
    this.rebuildCutEdges();
    return true;
  }

  /**
   * Reconnect an edge severed by cutEdge(). Returns false when it was not. An
   * edge also cut by a node's 'partition' stays cut until that fault clears,
   * because the two are separate faults and healing one is not healing both.
   */
  restoreEdge(edgeId: string): boolean {
    if (!this.severed.delete(edgeId)) return false;
    this.rebuildCutEdges();
    return true;
  }

  /** Edges severed by cutEdge() right now, in the order they were cut. */
  activeCuts(): string[] {
    return [...this.severed];
  }

  /* ---------------- recording ---------------- *
   *
   * The same four operations, applied now AND written into the schedule at
   * the current simulated time, so a run the student broke by hand can be
   * exported with exportTopology() and replayed exactly. An operation that
   * changes nothing (clearing a healthy node, cutting a cut edge) is not
   * recorded, so the schedule stays a list of things that happened.
   *
   * The entry is placed after every entry already played and before every
   * one still to come, so reset() replays it in the same position relative
   * to the authored schedule as it happened live.
   * ------------------------------------------- */

  /** injectFailure(), recorded. */
  recordFailure(nodeId: string, kind: FailureKind, opts: FailureOpts = {}): void {
    if (!this.nodes.has(nodeId)) return;
    this.applyOverdueFaults();
    if (!this.injectFailure(nodeId, kind, opts)) return;
    const copy: FailureOpts = {};
    if (opts.factor !== undefined) copy.factor = opts.factor;
    if (opts.rate !== undefined) copy.rate = opts.rate;
    if (opts.edgeIds !== undefined) copy.edgeIds = opts.edgeIds.slice();
    this.appendRecorded({
      atMs: this.now,
      action: 'inject',
      nodeId,
      kind,
      ...(Object.keys(copy).length > 0 ? { opts: copy } : {}),
    });
  }

  /** clearFailure(), recorded. */
  recordClearFailure(nodeId: string): void {
    this.applyOverdueFaults();
    if (!this.faults.has(nodeId)) return;
    this.clearFailure(nodeId);
    this.appendRecorded({ atMs: this.now, action: 'clear', nodeId });
  }

  /** cutEdge(), recorded. Returns what cutEdge() returned. */
  recordCutEdge(edgeId: string): boolean {
    this.applyOverdueFaults();
    if (!this.cutEdge(edgeId)) return false;
    this.appendRecorded({ atMs: this.now, action: 'cut', edgeId });
    return true;
  }

  /** restoreEdge(), recorded. Returns what restoreEdge() returned. */
  recordRestoreEdge(edgeId: string): boolean {
    this.applyOverdueFaults();
    if (!this.restoreEdge(edgeId)) return false;
    this.appendRecorded({ atMs: this.now, action: 'restore', edgeId });
    return true;
  }

  /** The whole schedule, authored and recorded, as a copy the caller owns. */
  faultSchedule(): FaultEvent[] {
    return sanitizeFaults(this.schedule);
  }

  /**
   * Forget the schedule. Faults already in force stay in force; reset() after
   * this starts a healthy run.
   */
  clearFaultSchedule(): void {
    this.schedule = [];
    this.scheduleNext = 0;
    this.nextFaultMs = Infinity;
  }

  /**
   * The topology this engine was given, with its authored scale (not what a
   * controller grew it to), with the schedule and the seed attached, ready to
   * save or share and replay. Entries whose node or edge has since been
   * removed are left out, so the result passes the same validation an import
   * does.
   * Annotations are not engine state: a caller that has them spreads its own
   * topology under this one.
   */
  exportTopology(): Topology {
    const t = cloneTopology(this.topology);
    for (const n of t.nodes) {
      const authored = this.authoredCapacity.get(n.id);
      if (authored !== undefined) n.config.capacity = authored;
      const authoredShard = this.authoredShardCapacity.get(n.id);
      if (authoredShard !== undefined) n.config.shardCapacity = authoredShard;
      if (this.authoredInstances.has(n.id)) {
        n.config.instances = this.authoredInstances.get(n.id);
      }
    }
    const faults = sanitizeFaults(this.schedule, t);
    return {
      ...t,
      ...(faults.length > 0 ? { faults } : {}),
      // Left out at the default, so a design that never chose a seed exports
      // exactly as it did before seeds were saved.
      ...(this.seed !== DEFAULT_SEED ? { seed: this.seed } : {}),
    };
  }

  /** The seed reset() replays from. */
  runSeed(): number {
    return this.seed;
  }

  /* ---------------- tally ---------------- *
   *
   * An exact record of every client request that settles while it runs:
   * each success's end-to-end latency, and each failure's reason. Off unless
   * asked for. It reads what the run does and changes nothing, draws nothing
   * and is not in the snapshot, so a run with a tally replays exactly as the
   * same run without one.
   * ---------------------------------------- */

  /**
   * Start a tally at the current simulated time, discarding any earlier one.
   * Requests already in flight count in it if they finish inside it.
   */
  startTally(): void {
    this.tallyStopped = null;
    this.tally = {
      fromMs: this.now,
      toMs: -1,
      arrived: 0,
      completed: 0,
      failed: 0,
      failures: {},
      latencies: new Float64Array(TALLY_INITIAL),
      writesAcked: 0,
      writesLanded: 0,
      jobsQueued: 0,
      jobsFailed: 0,
      routes: new Map(),
    };
  }

  /** Stop recording. What was recorded stays readable until the next start. */
  stopTally(): void {
    const t = this.tally;
    if (t === null) return;
    t.toMs = this.now;
    this.tally = null;
    this.tallyStopped = t;
  }

  /**
   * The tally running now, or the last one stopped, as a copy the caller owns.
   * Null when none was started since the engine was built or last reset.
   */
  readTally(): RunTally | null {
    const t = this.tally ?? this.tallyStopped;
    if (t === null) return null;
    return {
      fromMs: t.fromMs,
      toMs: t.toMs < 0 ? this.now : t.toMs,
      arrived: t.arrived,
      completed: t.completed,
      failed: t.failed,
      failuresByReason: { ...t.failures },
      latencies: t.latencies.slice(0, t.completed),
      writesAcked: t.writesAcked,
      writesLanded: t.writesLanded,
      jobsQueued: t.jobsQueued,
      jobsFailed: t.jobsFailed,
      byRoute: Object.fromEntries(
        Array.from(t.routes, ([id, r]): [string, RouteTally] => [
          id,
          {
            arrived: r.arrived,
            completed: r.completed,
            failed: r.failed,
            failuresByReason: { ...r.failures },
            latencies: r.latencies.slice(0, r.completed),
          },
        ]),
      ),
    };
  }

  private appendRecorded(entry: FaultEvent): void {
    this.schedule.splice(this.scheduleNext, 0, entry);
    this.scheduleNext++;
  }

  /**
   * Play the entries already due. Only an advance() that ran out of its event
   * budget leaves any, and a recording made then has to land after them, the
   * way the sorted schedule will replay it.
   */
  private applyOverdueFaults(): void {
    while (this.nextFaultMs <= this.now) this.applyDueFaults();
  }

  /** The action of the last entry already played on a node or an edge. */
  private playedLast(id: string, target: 'node' | 'edge'): FaultEvent['action'] | null {
    for (let i = this.scheduleNext - 1; i >= 0; i--) {
      const f = this.schedule[i];
      if (f.action === 'inject' || f.action === 'clear') {
        if (target === 'node' && f.nodeId === id) return f.action;
      } else if (target === 'edge' && f.edgeId === id) {
        return f.action;
      }
    }
    return null;
  }

  /** Every fault in force, for the UI. */
  activeFailures(): ActiveFailure[] {
    const out: ActiveFailure[] = [];
    for (const [nodeId, f] of this.faults) {
      out.push(describeFault(nodeId, f));
    }
    return out;
  }

  /**
   * Fail everything the crashed node is holding: requests in service, and
   * requests queued behind them. Iterating a copy of the waiting list matters
   * because resolve() can re-enter the engine through the parent's retry path.
   */
  private killInFlight(nodeId: string): void {
    const state = this.nodes.get(nodeId);
    if (!state) return;

    const waiting: Req[] = [];
    for (let i = state.waitHead; i < state.waiting.length; i++) {
      const req = state.waiting[i];
      if (req) waiting.push(req);
    }
    state.waiting.length = 0;
    state.waitHead = 0;

    // Threads parked on downstream calls die with the process. Their slots
    // come back now, before anything below can re-enter the engine, and each
    // request fails as 'crashed' when its calls answer, even if the node has
    // been healed by then.
    this.reclaimParked(state, 'crashed');

    for (const req of waiting) {
      if (req.resolved) continue;
      // A buffered queue message has no caller to inform; it is simply lost,
      // which is what an unreplicated broker losing its disk looks like.
      state.totalFailed++;
      this.resolve(req, false, 'crashed', 0);
    }

    // Requests already in service are deliberately NOT unwound here. Each one
    // still holds a real slot, and its SERVICE_DONE event will release that
    // slot and then find the node crashed in onServiceComplete, failing it as
    // 'crashed'. Zeroing state.busy here instead would double-release those
    // slots and let the crashed node appear to have free capacity.
  }

  /**
   * Fail the work instance 0 of `state` was holding: the threads parked on it
   * and the requests in service on it. Its slots come back as each request
   * fails, and since the fault is already in force they are not handed out
   * again. Requests waiting in the node's line were on no machine yet and
   * stay where they are.
   *
   * With one instance there is nothing left, so it is a whole-node crash.
   */
  private killOneInstance(state: NodeState): void {
    if (this.effectiveInstances(state) <= 1) {
      this.killInFlight(state.id);
      return;
    }

    this.reclaimParked(state, 'crashed', 0);

    // Every request in service has exactly one live SERVICE_DONE event, so
    // the heap is the list of them. Collected first because failing one runs
    // its caller's code, which can push events. Ordered by when each was
    // scheduled, which is when its service began, so the order is the run's
    // own rather than the heap's layout.
    const victims: Ev[] = [];
    this.heap.each((ev) => {
      const req = ev.req;
      if (
        ev.kind === EV_SERVICE_DONE &&
        req !== null &&
        req.token === ev.token &&
        req.heldAt === state &&
        req.instance === 0
      ) {
        victims.push(ev);
      }
    });
    victims.sort((a, b) => a.seq - b.seq);
    for (const ev of victims) {
      const req = ev.req;
      // An earlier failure's caller may have resolved this one already.
      if (req === null || req.resolved || req.token !== ev.token) continue;
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'crashed', this.now - req.enterMs);
    }
  }

  /** Whether each node losing one instance is down outright, by id. */
  private instanceCrashState(): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const [id, fault] of this.faults) {
      const state = this.nodes.get(id);
      if (fault.kind === 'crash-instance' && state !== undefined) {
        out.set(id, this.downBy(fault, state));
      }
    }
    return out;
  }

  /**
   * A node with one instance down changed how many it runs. Down to the dead
   * one alone, the node is crashed, so what the machine left was holding dies
   * as a crash's would. Up from one, machines now run beside the dead one,
   * and the work it held dies at once rather than finishing on it.
   */
  private refitInstanceCrash(state: NodeState, wasDown: boolean): void {
    const fault = this.faults.get(state.id);
    if (fault?.kind !== 'crash-instance') return;
    const down = this.downBy(fault, state);
    if (down === wasDown) return;
    if (down) this.killInFlight(state.id);
    else this.killOneInstance(state);
  }

  private rebuildCutEdges(): void {
    this.cutEdges.clear();
    for (const id of this.severed) this.cutEdges.add(id);
    for (const [nodeId, fault] of this.faults) {
      if (fault.kind !== 'partition') continue;
      if (fault.edgeIds.length > 0) {
        for (const id of fault.edgeIds) this.cutEdges.add(id);
        continue;
      }
      // No edge ids given: cut everything leaving the node. Control edges
      // included -- "unplug this box" severs the controller's reach as much as
      // its traffic, and a partitioned autoscaler that kept steering its
      // target would be a lie about what a network partition does.
      const state = this.nodes.get(nodeId);
      if (!state) continue;
      for (const edge of state.out) this.cutEdges.add(edge.id);
      for (const edge of state.ctrl) this.cutEdges.add(edge.id);
    }
  }

  advance(deltaMs: number): void {
    if (!(deltaMs > 0)) return;
    const dt = Math.min(deltaMs, MAX_DELTA_MS);
    const target = this.now + dt;
    let budget = MAX_EVENTS_PER_ADVANCE;

    for (;;) {
      const next = this.heap.peek();
      // A scheduled fault lands after every event due at its own millisecond
      // and before the first one after it. One due exactly at `target` waits
      // for the tail below instead, which is where a fault the student clicks
      // between two frames lands, so a recording and its replay agree.
      if (this.nextFaultMs < target && (!next || this.nextFaultMs < next.time)) {
        this.applyDueFaults();
        continue;
      }
      if (!next || next.time > target) break;
      if (budget-- <= 0) break;
      const ev = this.heap.pop()!;
      // Integrate utilization up to this event before state changes.
      this.now = ev.time;
      this.dispatch(ev);
      this.releaseEv(ev);
    }

    this.now = target;
    this.integrateAll();
    if (this.tickNodes.length > 0) this.runTicks(dt);
    this.maybeRecordHistory();
    // Skipped when the event budget ran out: events are still owed before
    // `target`, and a fault applied now would jump ahead of them.
    if (budget > 0) {
      while (this.nextFaultMs <= target) this.applyDueFaults();
      this.scheduleThroughMs = target;
    }
  }

  /**
   * Apply every schedule entry due at `nextFaultMs`, in list order, as one
   * batch, so two faults at the same millisecond are not split by the work
   * the first one sets off.
   */
  private applyDueFaults(): void {
    const atMs = this.nextFaultMs;
    if (atMs > this.now) this.now = atMs;
    const schedule = this.schedule;
    while (
      this.scheduleNext < schedule.length &&
      schedule[this.scheduleNext].atMs <= atMs
    ) {
      const f = schedule[this.scheduleNext++];
      if (f.action === 'inject') this.injectFailure(f.nodeId, f.kind, f.opts);
      else if (f.action === 'clear') this.clearFailure(f.nodeId);
      else if (f.action === 'cut') this.cutEdge(f.edgeId);
      else this.restoreEdge(f.edgeId);
    }
    this.scheduleThroughMs = atMs;
    this.nextFaultMs =
      this.scheduleNext < schedule.length ? schedule[this.scheduleNext].atMs : Infinity;
  }

  /** Install a schedule from sortedSchedule() and rewind it to its first entry. */
  private loadSchedule(schedule: FaultEvent[]): void {
    this.schedule = schedule;
    this.scheduleNext = 0;
    this.nextFaultMs = this.schedule.length > 0 ? this.schedule[0].atMs : Infinity;
  }

  snapshot(): SimSnapshot {
    const now = this.now;
    this.sysLatency.percentiles(now, this.pctScratch);

    const system: SystemStats = {
      timeMs: now,
      offeredRps: this.sysOffered.rate(now),
      goodputRps: this.sysGood.rate(now),
      errorRate: 0,
      p50: this.pctScratch[0],
      p95: this.pctScratch[1],
      p99: this.pctScratch[2],
      totalRequests: this.totalRequests,
      totalFailed: this.totalFailed,
    };
    const failRate = this.sysFailed.rate(now);
    const done = system.goodputRps + failRate;
    system.errorRate = done > 0 ? failRate / done : 0;

    const nodeOut: Record<string, NodeStats> = this.snapNodes;
    for (const key of Object.keys(nodeOut)) {
      if (!this.nodes.has(key)) delete nodeOut[key];
    }

    for (const state of this.nodes.values()) {
      state.latency.percentiles(now, this.nodePctScratch);
      const completions = state.completions.rate(now);
      const errorsPerSec = state.errors.rate(now);
      const shedRate = state.sheds.rate(now);
      const timeoutRate = state.timeouts.rate(now);
      const hits = state.hits.rate(now);
      const misses = state.misses.rate(now);
      /*
       * Timeouts belong in both halves. They were in neither, so `errorRate`
       * answered "how many of the requests that did not time out went wrong"
       * while the cell rendering it says "failing", and a caller losing a
       * quarter of its traffic to a slow dependency read 0%.
       */
      const resolved = completions + errorsPerSec + shedRate + timeoutRate;

      // A fresh object per snapshot, deliberately. Mutating a reused entry in
      // place makes every memoised consumer see an unchanged reference and
      // skip its re-render, which silently freezes the canvas node readouts
      // at zero while the rest of the UI updates. At 10Hz over a handful of
      // nodes the allocation is irrelevant; the stale render is not.
      const entry: NodeStats = {
        inFlight: 0,
        queued: 0,
        throughput: 0,
        arrivalRate: 0,
        utilization: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        errorRate: 0,
        shedRate: 0,
        timeoutRate: 0,
        hitRate: 0,
        totalCompleted: 0,
        totalFailed: 0,
        queueLimit: this.effectiveQueueLimit(state),
        staleReadRate: 0,
        maxShardUtilization: 0,
        minShardUtilization: 0,
        shardUtilization: EMPTY_SHARDS,
      };
      nodeOut[state.id] = entry;

      // Being served means working. A parked slot is held but idle, so it is
      // published apart, and only where it can happen: a blocking kind with
      // somewhere to call. Everywhere else the field is absent rather than a
      // zero that could never be anything else.
      const parked = state.parked;
      entry.inFlight = state.busy > parked ? state.busy - parked : 0;
      if (state.behaviour.blocksOnDownstream && state.out.length > 0) {
        entry.waitingOnDownstream = parked;
      }
      entry.queued = state.waiting.length - state.waitHead;
      entry.throughput = completions;
      entry.arrivalRate = state.arrivals.rate(now);
      entry.utilization = state.utilization;
      entry.p50 = this.nodePctScratch[0];
      entry.p95 = this.nodePctScratch[1];
      entry.p99 = this.nodePctScratch[2];
      entry.errorRate =
        resolved > 0 ? (errorsPerSec + shedRate + timeoutRate) / resolved : 0;
      entry.shedRate = shedRate;
      entry.timeoutRate = timeoutRate;
      entry.hitRate = hits + misses > 0 ? hits / (hits + misses) : 0;
      entry.totalCompleted = state.totalCompleted;
      entry.totalFailed = state.totalFailed;

      // Kind-specific readouts. Keeping this a hook means the snapshot loop
      // never grows a branch per kind, exactly as the event loop does not.
      if (state.behaviour.decorateStats) {
        state.behaviour.decorateStats(this, state, entry);
      }

      // The instance vector is built AFTER decorateStats, because a custom
      // kind fills its working buffer from there (a shard's per-partition
      // utilisation is computed in the same pass that fills shardUtilization)
      // and because a slot-model kind's waterline must reflect any utilisation
      // decorateStats corrected -- a sharded store rewrites `utilization` to
      // the mean across partitions, and a stack drawn from the pre-correction
      // value would disagree with the meter beside it.
      const model = state.behaviour.instanceModel;
      if (model === 'slots') {
        this.fillSlotInstances(state);
        this.finishInstances(state, entry);
        if (state.instancesDown > 0) entry.instancesDown = state.instancesDown;
      } else if (model === 'custom') {
        state.instancePending = 0;
        if (state.behaviour.reportInstances)
          state.behaviour.reportInstances(this, state);
        this.finishInstances(state, entry);
      }
    }

    // Warm-up units belong to the node being SCALED, not to the controller
    // that ordered them. The autoscaler is the only node that knows a scale-up
    // is booked, so the count is moved across here, once every node's own
    // vector exists. Done as a second pass rather than inline because the
    // target's NodeStats may not have been built yet when the controller's is.
    this.attachPendingInstances(nodeOut);

    const edgeOut: Record<string, number> = this.snapEdges;
    for (const key of Object.keys(edgeOut)) {
      if (!this.edgeFlow.has(key)) delete edgeOut[key];
    }
    for (const [id, counter] of this.edgeFlow) {
      edgeOut[id] = counter.rate(now);
    }

    return {
      system,
      nodes: nodeOut,
      history: this.history,
      edgeFlow: edgeOut,
      edgeState: this.snapshotEdgeState(edgeOut),
      failuresByReason: this.failures,
      activeFailures: this.snapshotFailures(),
      trace: this.lastTrace,
    };
  }

  /**
   * Hand each autoscaler's booked-but-not-yet-live units to the node they were
   * booked FOR.
   *
   * The controller knows the number; the target is what the student is
   * looking at. Reporting it only on the autoscaler would leave the UI unable
   * to draw ghosted units on the stack that is about to grow, which is the
   * one place the warm-up lag is legible.
   *
   * `targetInstances` while scaling is the fleet size the target will reach,
   * and its live `instances` is the size it has, so the difference is exactly
   * what is still booting. Clamped at zero: a scale-up whose target was
   * manually enlarged past the booked figure in the meantime owes nothing.
   *
   * Driven off the behaviour's own control-target resolution rather than a
   * kind test, so the wiring rule lives in exactly one place.
   */
  private attachPendingInstances(nodeOut: Record<string, NodeStats>): void {
    for (const state of this.nodes.values()) {
      if (state.ctrl.length === 0) continue;
      const own = nodeOut[state.id];
      if (!own || own.scaling !== true) continue;
      const watched = this.controlTargetOf(state);
      const target = watched ? nodeOut[watched] : undefined;
      if (!target || target.instances === undefined) continue;
      const booked = own.targetInstances ?? 0;
      const pending = booked - target.instances;
      if (pending > 0) target.instancesPending = pending;
    }
  }

  /**
   * Classify every edge for the snapshot.
   *
   * Resolution order is fixed and matters: an injected cut is reported over a
   * breaker's refusal, because the fault is the more specific truth about that
   * particular wire. Below those, a kind that withholds traffic for a reason
   * of its own gets to say so through edgeStateFor(); everything else falls
   * back to whether the edge is actually moving requests.
   */
  private snapshotEdgeState(rates: Record<string, number>): Record<string, EdgeState> {
    const out = this.snapEdgeState;
    for (const key of Object.keys(out)) {
      if (!this.edgeFlow.has(key)) delete out[key];
    }

    for (const state of this.nodes.values()) {
      const hook = state.behaviour.edgeStateFor;
      for (let i = 0; i < state.out.length; i++) {
        const edge = state.out[i];
        if (this.cutEdges.size > 0 && this.cutEdges.has(edge.id)) {
          out[edge.id] = 'cut';
          continue;
        }
        const declared = hook ? hook(this, state, edge, i) : null;
        if (declared !== null) {
          out[edge.id] = declared;
          continue;
        }
        out[edge.id] = (rates[edge.id] ?? 0) > 0 ? 'live' : 'idle';
      }

      // Control edges get an entry too, because the map promises one per edge
      // and a renderer asking about a wire it can see must never get
      // undefined. They are never 'live': no request crosses one, so judging
      // them by flow would paint every control link permanently idle-looking.
      // 'standby' says the honest thing -- wired, healthy, carrying no
      // traffic because that is not what it is for.
      for (const edge of state.ctrl) {
        out[edge.id] =
          this.cutEdges.size > 0 && this.cutEdges.has(edge.id) ? 'cut' : 'standby';
      }
    }

    // An edge whose source node no longer exists still has a flow counter, so
    // give it a state rather than leaving a hole the UI has to guard against.
    for (const id of this.edgeFlow.keys()) {
      if (out[id] === undefined) out[id] = (rates[id] ?? 0) > 0 ? 'live' : 'idle';
    }
    return out;
  }

  /**
   * Injected failures, rebuilt into the reused array. Length is the number of
   * faulted nodes -- normally zero -- so this costs nothing on a healthy run.
   */
  private snapshotFailures(): ActiveFailure[] {
    const out = this.snapFailures;
    out.length = 0;
    for (const [nodeId, fault] of this.faults) {
      out.push(describeFault(nodeId, fault));
    }
    return out;
  }

  reset(): void {
    this.rng = new Rng(this.seed);
    this.now = 0;
    this.seq = 0;
    this.nextArrivalGeneration = 1;
    this.heap.clear();
    this.freeReq = null;
    this.freeEv.length = 0;
    this.liveRequests = 0;
    this.sysLatency.reset();
    this.sysOffered.reset();
    this.sysGood.reset();
    this.sysFailed.reset();
    this.totalRequests = 0;
    this.totalFailed = 0;
    // A tally is a window of one run. The run it measured is gone.
    this.tally = null;
    this.tallyStopped = null;
    this.failures = {
      error: 0,
      shed: 0,
      timeout: 0,
      'no-route': 0,
      depth: 0,
      throttled: 0,
      rejected: 0,
      crashed: 0,
      partitioned: 0,
      'region-down': 0,
      'conn-refused': 0,
      unauthorized: 0,
      'bulkhead-full': 0,
      'acquire-timeout': 0,
      deprioritized: 0,
    };
    this.history = [];
    this.lastHistoryMs = 0;
    this.snapNodes = {};
    this.snapEdges = {};
    // Edge-flow counters are deliberately carried across setTopology so a
    // live edit does not blank every edge label, but a reset() rewinds the
    // clock to 0, and a stale bucket whose stamp happens to line up with the
    // replay would double-count that edge. Sparse edges (a 2 rps batch
    // client) are exactly the ones that keep such buckets alive.
    for (const counter of this.edgeFlow.values()) counter.reset();
    // Chaos is part of the run, not of the topology: reset() must reproduce
    // the original trajectory from t=0, which it cannot do while a fault
    // injected mid-run is still in force. What WAS scheduled, or recorded,
    // is replayed from its first entry instead.
    this.faults.clear();
    this.severed.clear();
    this.cutEdges.clear();
    this.snapFailures.length = 0;
    this.scheduleNext = 0;
    this.nextFaultMs = this.schedule.length > 0 ? this.schedule[0].atMs : Infinity;
    this.scheduleThroughMs = -Infinity;
    // The trace belongs to the run that produced it. Keeping it across a
    // reset would show a journey through a system that no longer exists.
    this.tracing = null;
    this.lastTrace = null;
    // Undo anything a controller wrote back into the topology during the run,
    // so the rebuild below starts from the capacities the run started with.
    for (const n of this.topology.nodes) {
      const authored = this.authoredCapacity.get(n.id);
      if (authored !== undefined) n.config.capacity = authored;
      const authoredShard = this.authoredShardCapacity.get(n.id);
      if (authoredShard !== undefined) n.config.shardCapacity = authoredShard;
      // `instances` is optional, so an authored value of undefined is a real
      // state to restore to, not a missing entry: a scale-up wrote a number
      // here, and leaving it would replay the run from the grown fleet.
      if (this.authoredInstances.has(n.id)) {
        n.config.instances = this.authoredInstances.get(n.id);
      }
    }
    this.buildNodes(null);
  }

  /* ---------------- topology wiring ---------------- */

  private buildNodes(previous: Map<string, NodeState> | null): void {
    const next = new Map<string, NodeState>();
    const newClientIds: string[] = [];
    this.clientIds = [];

    for (const node of this.topology.nodes) {
      const kept = previous?.get(node.id);
      let state: NodeState;
      if (kept && kept.kind === node.kind) {
        // Preserve in-flight work across a hot swap.
        state = kept;
        // A controller (the autoscaler) writes its scale decision into
        // state.config[scaleField] and into this.topology, but never into the
        // authored map. `node.config` here is the shell topology's, which still
        // carries the authored value, so `{ ...node.config }` would revert a
        // live autoscaled fleet and leave the controller's target pointing at a
        // size the node no longer has. Keep the live value whenever it diverges
        // from authored. A student edit cannot be mistaken for a controller
        // write: updateNodeConfig moves node.config, the authored map and
        // state.config together, so it shows no divergence and flows through.
        const field = state.behaviour.scaleField;
        const liveScale =
          field !== undefined &&
          state.config[field] !== this.authoredScale(node.id, field)
            ? state.config[field]
            : undefined;
        state.config = { ...node.config };
        if (field !== undefined && liveScale !== undefined) {
          state.config[field] = liveScale;
        }
        state.out = [];
        state.ctrl = [];
        state.sources = [];
      } else {
        state = createNodeState(node);
        state.arrivalGeneration = this.nextArrivalGeneration++;
        if (state.behaviour.generatesLoad) newClientIds.push(node.id);
      }
      state.lastIntegrateMs = this.now;
      next.set(node.id, state);
      if (state.behaviour.generatesLoad) this.clientIds.push(node.id);
    }

    for (const edge of this.topology.edges) {
      const from = next.get(edge.from);
      const to = next.get(edge.to);
      if (!from || !to) continue;
      // A control edge is a supervisory relationship, not a traffic path, so
      // it never enters the routing set. Two ways to be one: the edge says so
      // (`control: true`), or the source kind only ever supervises (an
      // autoscaler). The OR is what lets every preset written before the flag
      // existed get the right behaviour without being edited.
      if (edge.control === true || from.behaviour.controlsTarget === true) {
        from.ctrl.push(edge);
        continue;
      }
      from.out.push(edge);
      // Structural wiring: a pull-based consumer drains whatever buffers feed
      // it. Both traits come off the behaviour, so a future kind that also
      // pulls (or also buffers) is wired up here with no edit.
      if (to.behaviour.pullsFromQueues && from.behaviour.buffersForConsumers) {
        to.sources.push(from.id);
      }
    }
    // A consumer may be drawn in either direction relative to its buffer;
    // treat an outgoing edge to a buffer as a pull source too.
    for (const state of next.values()) {
      if (!state.behaviour.pullsFromQueues) continue;
      for (const edge of state.out) {
        const target = next.get(edge.to);
        if (
          target &&
          target.behaviour.buffersForConsumers &&
          !state.sources.includes(target.id)
        ) {
          state.sources.push(target.id);
        }
      }
    }

    markCycles(next);

    // Drop state belonging to removed nodes: their in-flight requests are gone.
    // Every dropped state is marked before any is discarded, because failing
    // one node's requests runs other nodes' code, and that code may route into
    // a second dropped node through the old map.
    if (previous) {
      let dropped = false;
      for (const [id, state] of previous) {
        if (next.get(id) === state) continue;
        state.discarded = true;
        dropped = true;
      }
      if (dropped) {
        for (const [id, state] of previous) {
          if (next.get(id) === state) continue;
          this.discardNodeState(state);
        }
      }
    }

    this.nodes = next;

    const flow = new Map<string, RateCounter>();
    for (const edge of this.topology.edges) {
      flow.set(edge.id, this.edgeFlow.get(edge.id) ?? new RateCounter());
    }
    this.edgeFlow = flow;

    // Retained clients keep their already scheduled arrival. Only a new or
    // retyped client needs an initial event to start its generator.
    for (const id of newClientIds) {
      this.scheduleArrival(id);
    }
    this.tickNodes = [];
    for (const state of this.nodes.values()) {
      state.pollScheduled = false;
      // Allocate behaviour-private state before anything can run. A node kept
      // across a hot swap keeps the state it already had, so an autoscaler
      // does not forget its cooldown because an unrelated node was moved.
      if (state.ext === null && state.behaviour.initState) {
        state.ext = state.behaviour.initState(state);
      }
      this.pumpQueue(state);
      if (state.behaviour.onTick) this.tickNodes.push(state);
    }
  }

  private discardNodeState(state: NodeState): void {
    // Parked requests lose their thread with the node; their callers hear
    // 'no-route' once the calls they made have answered.
    this.reclaimParked(state, 'no-route');
    const waiting = state.waiting;
    const head = state.waitHead;
    state.waiting = [];
    state.waitHead = 0;
    for (let i = head; i < waiting.length; i++) {
      const req = waiting[i];
      if (req && !req.resolved) this.resolve(req, false, 'no-route', 0);
    }
    // Requests a kind keeps in `ext` are invisible to the engine, and would
    // otherwise never resolve.
    if (state.ext !== null) state.behaviour.onDiscard?.(this, state);
    state.busy = 0;
  }

  /* ---------------- event dispatch ---------------- */

  private dispatch(ev: Ev): void {
    const state = this.nodes.get(ev.nodeId);
    if (!state) {
      this.dispatchOrphan(ev);
      return;
    }

    switch (ev.kind) {
      case EV_ARRIVAL:
        if (state.behaviour.generatesLoad && state.arrivalGeneration === ev.token) {
          this.onClientArrival(state);
        }
        break;
      case EV_SERVICE_DONE:
        if (ev.req && ev.req.token === ev.token) {
          // The state that granted the slot is not the one under this id any
          // more: the node was retyped mid-service. That process is gone.
          if (ev.req.heldAt === state) this.onServiceDone(state, ev.req);
          else this.resolve(ev.req, false, 'no-route', 0);
        }
        break;
      case EV_TIMEOUT:
        if (ev.req && ev.req.token === ev.token) this.onTimeout(ev.req);
        break;
      case EV_WORKER_POLL:
        state.pollScheduled = false;
        this.pumpWorker(state);
        break;
      case EV_RETRY:
        if (ev.req && ev.req.token === ev.token) this.onRetry(state, ev.req);
        break;
      case EV_LINK_ARRIVE:
        // The request finished crossing an edge with a latencyMs and is only
        // now offered to the target. A caller that already gave up during the
        // crossing leaves a resolved request, which is dropped here.
        if (ev.req && ev.req.token === ev.token && !ev.req.resolved) {
          this.admit(state, ev.req);
        }
        break;
      case EV_BEHAVIOUR_WAKE:
        if (ev.req && ev.req.token === ev.token && !ev.req.resolved) {
          state.behaviour.onWake?.(this, state, ev.req);
        }
        break;
      default:
        break;
    }
  }

  /**
   * An event for a node a topology edit removed. A request caught there would
   * otherwise never resolve, and a blocking caller waiting on it would keep
   * its slot for good, so each one is answered as 'no-route', the reason a
   * call to a node that does not exist gets everywhere else. A timeout still
   * fires, because the caller that armed it is a different node. A pending
   * retry is answered at the join rather than resolved, since its siblings
   * may still be live. A behaviour's own wake is dropped: onDiscard already
   * failed whatever it was holding.
   */
  private dispatchOrphan(ev: Ev): void {
    const req = ev.req;
    if (!req || req.token !== ev.token) return;
    switch (ev.kind) {
      case EV_SERVICE_DONE:
      case EV_LINK_ARRIVE:
        if (!req.resolved) this.resolve(req, false, 'no-route', 0);
        break;
      case EV_TIMEOUT:
        this.onTimeout(req);
        break;
      case EV_RETRY:
        if (!req.resolved) this.childResolved(req, false, 'no-route', 0);
        break;
      default:
        break;
    }
  }

  /* ---------------- client ---------------- */

  private scheduleArrival(nodeId: string): void {
    const state = this.nodes.get(nodeId);
    if (!state || !state.behaviour.generatesLoad) return;
    // The pattern's rate, not the baseline: a spike's quiet phase must
    // actually schedule arrivals further apart.
    const rps = this.effectiveRps(state);
    if (!(rps > 0)) {
      // Poll again shortly so raising the slider, or a pattern coming back up
      // off its trough, resumes traffic.
      this.push(this.now + 50, EV_ARRIVAL, nodeId, null, state.arrivalGeneration);
      return;
    }
    const gap = this.rng.exponential(1000 / rps);
    this.push(this.now + gap, EV_ARRIVAL, nodeId, null, state.arrivalGeneration);
  }

  private onClientArrival(state: NodeState): void {
    this.scheduleArrival(state.id);
    if (this.effectiveRps(state) <= 0) return;

    /*
     * Past the live-request ceiling the request is still OFFERED, and
     * saying so is the whole point. Returning silently here left every
     * rate reading zero while the design was maximally overloaded: a
     * client sending a million a second reported "offered 0.0/s, served
     * 0.0/s, 0.0% failed" beside a service pinned at 100% busy, which
     * reads as an idle system rather than a drowning one.
     *
     * So it is counted and then shed. The ceiling is this engine
     * protecting itself rather than anything the design did, but a
     * request the system could not take IS a shed from the reader's
     * side, and the alternative is a meter that lies at exactly the
     * moment it matters most.
     */
    if (this.liveRequests >= MAX_LIVE_REQUESTS) {
      this.totalRequests++;
      this.sysOffered.add(this.now, 1);
      state.arrivals.add(this.now, 1);
      state.sheds.add(this.now, 1);
      state.totalFailed++;
      this.failures.shed++;
      this.sysFailed.add(this.now, 1);
      const route = state.route;
      if (route !== null) {
        route.totalRequests++;
        routeFailed(route, this.now, 'shed');
      }
      const tally = this.tally;
      if (tally !== null) {
        tally.arrived++;
        tallyFailure(tally, 'shed');
        const rt = tallyRoute(tally, state.id);
        rt.arrived++;
        tallyFailure(rt, 'shed');
      }
      return;
    }

    const root = this.acquireReq();
    root.nodeId = state.id;
    root.parent = null;
    root.rootStartMs = this.now;
    root.enterMs = this.now;
    root.hop = 0;
    root.attempt = 0;
    root.pending = 0;
    root.maxChildMs = 0;
    root.ownMs = 0;
    // Draw this request's key. Every downstream call inherits it, so the
    // whole chain agrees on which partition/record is being touched.
    root.key = Math.floor(this.rng.next() * KEYSPACE);

    // Trace one request at a time, and only once the previous one has been
    // published. Sampling instead of tracing everything keeps the allocation
    // off the hot path, and tracing one at a time means the recorded hops
    // always belong to a single journey rather than being interleaved.
    if (this.tracing === null) {
      this.tracing = root;
      root.trace = [];
    }

    this.totalRequests++;
    this.sysOffered.add(this.now, 1);
    state.arrivals.add(this.now, 1);
    if (state.route !== null) state.route.totalRequests++;
    if (this.tally !== null) {
      this.tally.arrived++;
      tallyRoute(this.tally, state.id).arrived++;
    }

    this.dispatchDownstream(state, root);
  }

  /* ---------------- routing ---------------- */

  /**
   * Issue this node's downstream calls. For an lb exactly one edge is chosen;
   * for anything else every distinct downstream is called and joined.
   */
  private dispatchDownstream(state: NodeState, req: Req): void {
    if (req.hop >= MAX_HOP_DEPTH) {
      this.resolve(req, false, 'depth', req.ownMs);
      return;
    }

    const out = state.out;
    if (out.length === 0) {
      // Terminal node: nothing downstream, this call is done.
      this.resolve(req, true, 'error', req.ownMs);
      return;
    }

    const b = state.behaviour;
    const mode = b.route ? b.route(this, state, req) : 'all';

    if (mode === 'none') {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    if (mode === 'one') {
      const edge = b.pickEdge
        ? b.pickEdge(this, state, req, out)
        : this.pickWeightedOrLeastLoaded(out);
      if (!edge) {
        // A kind whose pickEdge can decline for a reason of its own names it
        // here (a region node that has no healthy region reports
        // 'region-down', not a generic routing error). Read as a plain field,
        // so this stays a trait lookup rather than a kind test.
        const reason = state.behaviour.noRouteReason ?? 'no-route';
        if (reason !== 'no-route') {
          // A deliberate refusal by this node, so it owns the failure. A plain
          // 'no-route' stays uncredited: that is a wiring mistake by the
          // student, not something the node did.
          state.errors.add(this.now, 1);
          state.totalFailed++;
        }
        this.resolve(req, false, reason, req.ownMs);
        return;
      }
      req.pending = 1;
      this.sendChild(state, req, edge, 0);
      return;
    }

    req.pending = out.length;
    // Snapshot the count: a child may resolve synchronously (shed) and
    // decrement pending mid-loop.
    for (let i = 0; i < out.length; i++) {
      if (req.resolved) return;
      this.sendChild(state, req, out[i], 0);
    }
  }

  /**
   * The shared edge-selection policy: weighted-random when the weights differ,
   * least-loaded when they are all equal. Exposed on BehaviourCtx so a
   * behaviour can reuse it instead of reimplementing the tie-break.
   */
  pickWeightedOrLeastLoaded(out: readonly SimEdge[]): SimEdge | null {
    // A partitioned edge is not a candidate. This matters more than it looks:
    // the least-loaded rule below measures load at the TARGET, and a cut edge
    // delivers nothing, so its target is permanently the idlest thing in the
    // set. A dispatcher would therefore lock onto the one broken link and send
    // it every single request -- one cut edge would take down a load balancer
    // with three healthy peers. Excluding cut edges up front is what makes a
    // partition behave like a lost link rather than a black hole with gravity.
    //
    // `cutEdges` is empty on every healthy run, so this costs one Set size
    // check and nothing else.
    const cut = this.cutEdges;
    const anyCut = cut.size > 0;

    if (out.length === 1) return anyCut && cut.has(out[0].id) ? null : out[0];

    let total = 0;
    let uniform = true;
    let firstLive = -1;
    for (let i = 0; i < out.length; i++) {
      if (anyCut && cut.has(out[i].id)) continue;
      const w = out[i].weight > 0 ? out[i].weight : 0;
      total += w;
      if (firstLive < 0) firstLive = i;
      else if (Math.abs(out[i].weight - out[firstLive].weight) > 1e-9) uniform = false;
    }
    // Every edge is cut: there is no route, and the caller reports it as such.
    if (firstLive < 0) return null;

    if (uniform) {
      // Least-loaded: fewest queued+busy relative to capacity, ties by index.
      let best: SimEdge | null = null;
      let bestLoad = Infinity;
      for (let i = 0; i < out.length; i++) {
        if (anyCut && cut.has(out[i].id)) continue;
        const target = this.nodes.get(out[i].to);
        if (!target) continue;
        const own = target.behaviour.load;
        let load: number;
        if (own) {
          load = own(this, target);
        } else {
          const depth = target.busy + (target.waiting.length - target.waitHead);
          const cap = target.config.capacity > 0 ? target.config.capacity : 1;
          load = depth / cap;
        }
        if (load < bestLoad) {
          bestLoad = load;
          best = out[i];
        }
      }
      return best ?? out[firstLive];
    }

    if (total <= 0) return out[firstLive];
    let r = this.rng.next() * total;
    let last = out[firstLive];
    for (let i = 0; i < out.length; i++) {
      if (anyCut && cut.has(out[i].id)) continue;
      const w = out[i].weight > 0 ? out[i].weight : 0;
      last = out[i];
      r -= w;
      if (r <= 0) return out[i];
    }
    return last;
  }

  private sendChild(
    parentState: NodeState,
    parent: Req,
    edge: SimEdge,
    attempt: number,
  ): void {
    const target = this.nodes.get(edge.to);
    if (!target) {
      this.childResolved(parent, false, 'no-route', 0);
      return;
    }

    // A partitioned link fails at the CALLER: the packet never arrives, so the
    // target node is untouched and sees no arrival at all. Reported through
    // childResolvedFrom rather than childResolved so the caller's retry budget
    // applies -- retrying across a cut link is exactly the behaviour that makes
    // a partition look like a slow outage rather than a clean failure.
    if (this.cutEdges.size > 0 && this.cutEdges.has(edge.id)) {
      parentState.errors.add(this.now, 1);
      parentState.totalFailed++;
      const stub = this.acquireReq();
      stub.attempt = attempt;
      stub.retryTarget = edge.id;
      stub.resolved = true;
      this.childResolvedFrom(stub, parent, false, 'partitioned', 0);
      this.recycle(stub);
      return;
    }

    // A lossy link drops the crossing, and like a cut it fails at the caller
    // with the target untouched, so the caller's retries draw again. Nothing
    // is drawn unless lossRate is set, which keeps a lossless design's random
    // stream, and so its whole run, exactly what it was.
    const loss = edge.lossRate;
    if (loss !== undefined && loss > 0 && this.rng.next() < loss) {
      parentState.errors.add(this.now, 1);
      parentState.totalFailed++;
      const stub = this.acquireReq();
      stub.attempt = attempt;
      stub.retryTarget = edge.id;
      stub.resolved = true;
      this.childResolvedFrom(stub, parent, false, 'packet-loss', 0);
      this.recycle(stub);
      return;
    }

    const child = this.acquireReq();
    child.nodeId = target.id;
    child.parent = parent;
    child.rootStartMs = parent.rootStartMs;
    child.enterMs = this.now;
    child.hop = parent.hop + 1;
    child.attempt = attempt;
    child.viaEdge = edge.id;
    child.retryTarget = edge.id;
    child.detached = parent.detached;
    child.key = parent.key;
    child.isWrite = parent.isWrite;

    const counter = this.edgeFlow.get(edge.id);
    if (counter) counter.add(this.now, 1);

    // The caller's timeout bounds THIS attempt, not the whole retry budget:
    // each re-issued call gets a fresh deadline, exactly like a real client.
    // It is armed at send time, so link latency counts against the deadline
    // exactly as propagation delay does for a real caller.
    this.armTimeout(parentState, child);

    // Link propagation delay. Absent (the case for every topology today) this
    // is a plain synchronous admission and the event stream is unchanged.
    // bandwidthRps is declared on SimEdge but not yet applied; the networking
    // phase adds it alongside this delay.
    const linkMs = edge.latencyMs;
    if (linkMs !== undefined && linkMs > 0) {
      this.push(this.now + linkMs, EV_LINK_ARRIVE, target.id, child, child.token);
      return;
    }

    this.admit(target, child);
  }

  /* ---------------- admission ---------------- */

  /** Offer a request to a node: shed, buffer, or start service. */
  /**
   * Record this node's share of a traced request's latency.
   *
   * Called once per hop, at the moment the node's own work finishes.
   * `arriveMs` is when the request reached the node, `enterMs` when a slot
   * freed and service began, so the gap between them is the queue and the
   * gap from `enterMs` to now is the work. Splitting them here, rather than
   * reporting one "time at this node", is the entire point of the feature.
   */
  /** The request currently being traced, or null between samples. */
  private tracing: Req | null = null;
  /** The last completed trace, handed to every snapshot until replaced. */
  private lastTrace: RequestTrace | null = null;

  private recordHop(req: Req): void {
    const traced = this.tracing;
    const trace = traced?.trace;
    if (!traced || !trace) return;
    // Only hops belonging to the sampled journey. A child does not carry the
    // trace array itself (allocating one per call would put the cost back on
    // the hot path), so its membership is established by walking up to its
    // root, which is at most a few links.
    let root: Req | null = req;
    while (root && root.parent) root = root.parent;
    if (root !== traced) return;
    // A client root is not admitted to a queue and holds no slot, so it has
    // no arrival stamp and no queue of its own; its elapsed time is the sum
    // of everything downstream and is already reported as the total. Booking
    // it as a hop would double-count the whole path.
    if (req.parent === null && req.hop === 0) return;
    // A node that never waited (a pass-through, or an idle server) entered
    // service the moment it arrived, so this is zero without a special case.
    const queuedMs = Math.max(0, req.enterMs - req.arriveMs);
    trace.push({
      nodeId: req.nodeId,
      depth: req.hop,
      queuedMs,
      // The node's OWN work, not its wall clock. A caller sits blocked while
      // its dependency runs, and charging that to the caller would make every
      // upstream node look slow when only the deepest one is: at 6x load the
      // api reads 344ms of wall clock against 22ms of actual work, and the
      // 322ms belongs to the database it was waiting on.
      serviceMs: req.ownMs,
    });
  }

  private admit(state: NodeState, req: Req): void {
    // A state dropped by a topology edit, reached through the old node map
    // while the edit fails what that node held. It is not there to answer.
    if (state.discarded) {
      this.resolve(req, false, 'no-route', 0);
      return;
    }
    state.arrivals.add(this.now, 1);
    // Stamped here, at the ONE point every request enters a node, so the
    // queued time the tracer reports cannot miss a path.
    req.arriveMs = this.now;

    // A crashed node accepts nothing. Checked before the behaviour runs, so a
    // crash takes a node out whatever kind it is, and the caller sees an
    // immediate failure it can retry (or that its breaker can count).
    const fault = this.faults.get(state.id);
    if (fault && this.downBy(fault, state)) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'crashed', 0);
      return;
    }

    const b = state.behaviour;
    const action = b.onAdmit ? b.onAdmit(this, state, req) : 'serve';

    if (action === 'handled') return;

    if (action === 'shed') {
      this.shed(state, req);
      return;
    }

    if (action === 'passthru') {
      // Effectively zero-capacity dispatchers: no queueing, immediate hand-off.
      req.ownMs = 0;
      this.beginZeroService(state, req);
      return;
    }

    const capacity = this.effectiveCapacity(state);
    if (state.busy < capacity) {
      this.startService(state, req);
      return;
    }

    // Every slot is taken, so this call would wait in line. On a call cycle
    // that wait can be circular: a thread parked somewhere on the cycle waits
    // on this call, and the slots this call waits for may belong to threads
    // that wait, call by call, on that first one. Nothing on such a loop ever
    // frees, even after the traffic stops. So a call whose own chain is
    // already parked on this cycle is refused as 'depth', the reason a cycle
    // has always produced, rather than queued. With a slot free it was served
    // above, as it always was, and the hop ceiling still bounds the recursion.
    if (state.cycle >= 0 && b.blocksOnDownstream && this.parkedOnCycle(state, req)) {
      this.resolve(req, false, 'depth', 0);
      return;
    }

    if (this.queueDepth(state) >= this.effectiveQueueLimit(state)) {
      this.shed(state, req);
      return;
    }
    state.waiting.push(req);
  }

  /**
   * Is an ancestor of `req` parked on a node of the cycle `state` sits on?
   * At most MAX_HOP_DEPTH links, and only walked when a node on a cycle is
   * full.
   */
  private parkedOnCycle(state: NodeState, req: Req): boolean {
    for (let p = req.parent; p !== null; p = p.parent) {
      if (p.parked && p.heldAt !== null && p.heldAt.cycle === state.cycle) return true;
    }
    return false;
  }

  /**
   * Draw one service time for a node, with any injected 'slow' fault applied.
   *
   * The acks of ackAndBuffer() and ackAndRelay() and a pass-through's hop
   * draw through here. A whole service, in startService() or serveWithin(),
   * goes through ownServiceMs() instead, which stretches the kind's
   * surcharges too. Between them a slow fault cannot be bypassed by whichever
   * path a kind happens to take. The RNG is consumed identically whether or
   * not a fault is present -- the multiplier scales the drawn value rather
   * than changing the distribution's parameters -- which keeps a faulted
   * run's random stream aligned with a healthy one.
   */
  private serviceTimeFor(state: NodeState): number {
    const ms = this.drawServiceMs(state);
    const factor = this.slowFactorOf(state);
    return factor > 1 ? ms * factor : ms;
  }

  /** One unslowed service-time draw, or 0 without a draw when serviceMs is 0. */
  private drawServiceMs(state: NodeState): number {
    if (!(state.config.serviceMs > 0)) return 0;
    return this.rng.serviceTime(state.config.serviceMs, state.config.serviceCv);
  }

  /** The 'slow' multiplier in force at a node, or 1 when it has none. */
  private slowFactorOf(state: NodeState): number {
    const fault = this.faults.get(state.id);
    return fault && fault.kind === 'slow' ? fault.factor : 1;
  }

  /**
   * One request's whole time in service at a node: its own work, stretched
   * by any 'slow' fault, plus any waiting, which is not. Consumes both
   * extras, so a request entering service again starts clean.
   */
  private ownServiceMs(state: NodeState, req: Req, drawnMs: number): number {
    const factor = this.slowFactorOf(state);
    const extra = req.extraServiceMs;
    const wait = req.extraWaitMs;
    req.extraServiceMs = 0;
    req.extraWaitMs = 0;
    // Exactly the old sum when nothing is slowed and nothing waits, so a
    // healthy run's timings are unchanged to the last bit.
    let ms = factor > 1 ? (drawnMs + extra) * factor : drawnMs + extra;
    if (wait > 0) ms += wait;
    return ms;
  }

  /** Book a shed against a node and fail the call. */
  private shed(state: NodeState, req: Req): void {
    state.sheds.add(this.now, 1);
    state.totalFailed++;
    this.resolve(req, false, 'shed', 0);
  }

  /**
   * A buffering node acknowledges immediately: the caller's chain resolves as
   * a success right here, and the message is parked for the consumers. Called
   * by the queue behaviour, which has already checked the depth limit.
   */
  ackAndBuffer(stateLike: NodeStateLike, reqLike: ReqLike): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    const ackMs = this.serviceTimeFor(state);

    // Detach a buffered copy for the workers, then ack the caller.
    const msg = this.acquireReq();
    msg.nodeId = state.id;
    msg.parent = null;
    msg.rootStartMs = this.now;
    msg.enterMs = this.now;
    msg.hop = req.hop;
    msg.detached = true;
    // The caller hears yes now, so a job that fails later fails where no
    // client sees it. The tally counts those for a check to see.
    const tally = this.tally;
    if (tally !== null) {
      tally.jobsQueued++;
      msg.queuedIn = tally;
    }
    state.waiting.push(msg);

    state.completions.add(this.now, 1);
    state.totalCompleted++;
    state.latency.add(this.now, ackMs);
    this.resolve(req, true, 'error', ackMs);

    // Wake any worker that feeds off this queue.
    this.wakeWorkersFor(state.id);
  }

  /**
   * Acknowledge the caller and RELAY a detached copy through this node's
   * own slot discipline.
   *
   * This is the delivery-side sibling of ackAndBuffer(): where a queue
   * parks its detached message for pull-based consumers, a relaying kind
   * (a retry queue, a write-behind cache) keeps the message and delivers
   * it downstream ITSELF -- the copy occupies this node's slots, draws the
   * node's service time, and then takes the ordinary completion path:
   * error roll, routing to the out edges, and the caller-side retry
   * machinery, so a failed delivery is re-issued with backoff by exactly
   * the code every other retry uses.
   *
   * `extraDeliveryMs` is added on top of the drawn service time of the
   * relayed copy (not of the ack), which is how a write-behind cache
   * models the interval a write sits dirty before its flush lands.
   *
   * The messages live in the engine's own waiting list, so `queueDepth`,
   * the snapshot's `queued`, and -- crucially -- killInFlight() all see
   * them: crashing the node loses the buffered messages instantly and
   * visibly, which is the write-behind lesson.
   *
   * The behaviour must check its own depth limit BEFORE calling this, the
   * same contract ackAndBuffer has.
   */
  ackAndRelay(stateLike: NodeStateLike, reqLike: ReqLike, extraDeliveryMs = 0): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    const ackMs = this.serviceTimeFor(state);

    const msg = this.acquireReq();
    msg.nodeId = state.id;
    msg.parent = null;
    msg.rootStartMs = this.now;
    msg.enterMs = this.now;
    msg.hop = req.hop;
    msg.detached = true;
    msg.key = req.key;
    msg.isWrite = req.isWrite;
    // A write-behind cache's ack is a promise the write will land. The tally
    // keeps count of the promises so a check can see the ones that are
    // broken behind it, which no client ever hears about.
    const tally = this.tally;
    if (tally !== null && state.kind === 'writebehind') {
      tally.writesAcked++;
      msg.ackedIn = tally;
    }
    // The flush delay is the time a write sits dirty, not work, so it goes
    // in as waiting and a 'slow' fault leaves it alone.
    if (extraDeliveryMs > 0) msg.extraWaitMs = extraDeliveryMs;

    // Start delivering now if a slot is free, else park it in the waiting
    // list for pumpQueue to drain. Started BEFORE the caller is acked, in
    // the same buffer-first order ackAndBuffer uses.
    if (state.busy < this.effectiveCapacity(state)) {
      this.startService(state, msg);
    } else {
      state.waiting.push(msg);
    }

    state.completions.add(this.now, 1);
    state.totalCompleted++;
    state.latency.add(this.now, ackMs);
    this.resolve(req, true, 'error', ackMs);
  }

  private wakeWorkersFor(queueId: string): void {
    for (const state of this.nodes.values()) {
      if (!state.behaviour.pullsFromQueues) continue;
      if (!state.sources.includes(queueId)) continue;
      this.pumpWorker(state);
    }
  }

  /** Client-style pass-through with a tiny (possibly zero) service time. */
  private beginZeroService(state: NodeState, req: Req): void {
    const ms = this.serviceTimeFor(state);
    req.ownMs = ms;
    if (ms > 0) {
      state.busy++;
      req.holdingSlot = true;
      req.heldAt = state;
      this.placeOnInstance(state, req);
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceComplete(state, req);
    }
  }

  private startService(state: NodeState, req: Req): void {
    state.busy++;
    req.holdingSlot = true;
    req.heldAt = state;
    this.placeOnInstance(state, req);
    req.enterMs = this.now;
    // Any extra time a behaviour attached to this request (a write-behind
    // cache's flush residence, booked via ackAndRelay) is consumed here,
    // exactly as serveWithin() consumes it for the self-managed kinds. Zero
    // for every request on the ordinary path, so no existing kind's timing
    // changes.
    const ms = this.ownServiceMs(state, req, this.drawServiceMs(state));
    req.ownMs = ms;
    if (ms > 0) {
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceDone(state, req);
    }
  }

  private onServiceDone(state: NodeState, req: Req): void {
    // A node that blocks on its downstream calls keeps the slot until this
    // request resolves, however that happens: resolve() releases it. Only a
    // node with somewhere to call parks; for a leaf the request is about to
    // resolve here anyway, and releasing now keeps today's event order.
    if (state.behaviour.blocksOnDownstream && state.out.length > 0) {
      this.park(state, req);
    } else {
      // The slot is released the instant this node's own work finishes, even
      // if the caller already gave up: abandoned work burned the slot until
      // now.
      this.releaseHeld(state, req);
    }
    this.onServiceComplete(state, req);
  }

  /**
   * Give back the slot `req` holds at `state` and let the next waiter in.
   *
   * The order is fixed and is the order the engine has always used at service
   * end: free the engine slot, start whoever is next in line, then tell a
   * self-managing kind (a pooled store, a lambda) to free the slot it keeps in
   * `ext`. Its callback is cleared before it runs, so a recycled request can
   * never fire a stale one.
   *
   * A state dropped by a topology edit only has its flags cleared. It must
   * never start work, and its `ext` no longer means anything.
   */
  private releaseHeld(state: NodeState, req: Req): void {
    req.heldAt = null;
    this.leaveInstance(state, req);
    if (req.parked) this.unlinkParked(state, req);
    const drained = req.onDrained;
    req.onDrained = null;
    if (state.discarded) {
      req.holdingSlot = false;
      return;
    }
    this.releaseSlot(state, req);
    this.pumpQueue(state);
    if (drained !== null) drained(this, state, req);
  }

  /**
   * Put `req`'s work on one instance of `state`: the next one round the fleet
   * with a free slot, skipping a machine that is down. When none has one,
   * which only a kind that serves without asking for a slot can reach, the
   * least loaded instance that is up takes it.
   *
   * No random draw, so the run's stream is the same with or without it, and
   * nothing here changes what the node admits.
   */
  private placeOnInstance(state: NodeState, req: Req): void {
    const n = this.effectiveInstances(state);
    let busy = state.instanceBusy;
    if (busy === null || busy.length < n) {
      // Only when the fleet first serves or grows past every size it has had.
      const grown = new Int32Array(Math.max(n, busy === null ? 1 : busy.length * 2));
      if (busy !== null) grown.set(busy);
      busy = grown;
      state.instanceBusy = grown;
    }
    if (n === 1) {
      busy[0]++;
      req.instance = 0;
      return;
    }
    const perInstance = Math.max(1, Math.floor(state.config.capacity));
    const skip = state.instancesDown;
    let i = state.instanceNext < n ? state.instanceNext : 0;
    let pick = -1;
    let fewest = Infinity;
    for (let k = 0; k < n; k++) {
      if (i >= skip) {
        const held = busy[i];
        if (held < perInstance) {
          pick = i;
          break;
        }
        if (held < fewest) {
          fewest = held;
          pick = i;
        }
      }
      i = i + 1 < n ? i + 1 : 0;
    }
    // n > 1 and at most one instance is down, so the loop always picked.
    busy[pick]++;
    req.instance = pick;
    state.instanceNext = pick + 1 < n ? pick + 1 : 0;
  }

  /** Take `req`'s work off the instance it was placed on. */
  private leaveInstance(state: NodeState, req: Req): void {
    const i = req.instance;
    if (i < 0) return;
    req.instance = -1;
    const busy = state.instanceBusy;
    if (busy !== null && i < busy.length && busy[i] > 0) busy[i]--;
  }

  private releaseSlot(state: NodeState, req: Req): void {
    if (!req.holdingSlot) return;
    req.holdingSlot = false;
    state.busy = Math.max(0, state.busy - 1);
  }

  /** Keep `req`'s slot while it waits on the calls it is about to make. */
  private park(state: NodeState, req: Req): void {
    req.parked = true;
    req.parkPrev = null;
    req.parkNext = state.parkHead;
    if (state.parkHead !== null) state.parkHead.parkPrev = req;
    state.parkHead = req;
    state.parked++;
  }

  private unlinkParked(state: NodeState, req: Req): void {
    const prev = req.parkPrev;
    const next = req.parkNext;
    if (prev !== null) prev.parkNext = next;
    else if (state.parkHead === req) state.parkHead = next;
    if (next !== null) next.parkPrev = prev;
    req.parked = false;
    req.parkPrev = null;
    req.parkNext = null;
    if (state.parked > 0) state.parked--;
  }

  /**
   * The node lost every thread that was parked on it: reclaim their slots now,
   * and mark each request so its join fails with `reason` when its children
   * answer. The children are left to run, because failing the parent first
   * would leave them joining into a recycled request. No pump: the caller
   * decides what the freed slots are for.
   *
   * With `onInstance`, only the threads on that one instance are lost and the
   * rest stay parked.
   */
  private reclaimParked(
    state: NodeState,
    reason: FailureReason,
    onInstance = -1,
  ): void {
    if (onInstance >= 0) {
      let req = state.parkHead;
      while (req !== null) {
        const next = req.parkNext;
        if (req.instance === onInstance) {
          this.unlinkParked(state, req);
          this.loseThread(state, req, reason);
        }
        req = next;
      }
      return;
    }
    let req = state.parkHead;
    while (req !== null) {
      const next = req.parkNext;
      req.parked = false;
      req.parkPrev = null;
      req.parkNext = null;
      this.loseThread(state, req, reason);
      req = next;
    }
    state.parkHead = null;
    state.parked = 0;
  }

  /** One parked thread is gone: give its slot back and mark its request lost. */
  private loseThread(state: NodeState, req: Req, reason: FailureReason): void {
    req.heldAt = null;
    this.leaveInstance(state, req);
    req.lostReason = reason;
    const drained = req.onDrained;
    req.onDrained = null;
    if (!state.discarded) {
      this.releaseSlot(state, req);
      if (drained !== null) drained(this, state, req);
    } else {
      req.holdingSlot = false;
    }
  }

  /** Start serving whoever is next in line, if a slot is free. */
  private pumpQueue(state: NodeState): void {
    const mode = state.behaviour.pump;
    if (mode === 'none' || state.discarded) return;
    if (mode === 'sources') {
      this.pumpWorker(state);
      return;
    }
    const capacity = this.effectiveCapacity(state);
    while (state.busy < capacity && state.waitHead < state.waiting.length) {
      const req = state.waiting[state.waitHead];
      state.waiting[state.waitHead] = undefined as unknown as Req;
      state.waitHead++;
      this.compactWaiting(state);
      if (req.resolved) continue;
      this.startService(state, req);
    }
  }

  /** Workers pull messages out of the queue nodes that feed them. */
  private pumpWorker(state: NodeState): void {
    if (state.discarded) return;
    const capacity = this.effectiveCapacity(state);
    // A call wired straight into a consumer, not through a queue, waits in
    // the consumer's own line when every slot is taken. Its caller is waiting
    // on it (and a blocking caller holds a slot for it), so that line is
    // served first, ahead of the buffered messages that nobody waits on.
    while (state.busy < capacity && state.waitHead < state.waiting.length) {
      const req = state.waiting[state.waitHead];
      state.waiting[state.waitHead] = undefined as unknown as Req;
      state.waitHead++;
      this.compactWaiting(state);
      if (req.resolved) continue;
      this.startService(state, req);
    }
    while (state.busy < capacity) {
      const msg = this.takeFromSources(state);
      if (!msg) break;
      msg.nodeId = state.id;
      msg.enterMs = this.now;
      state.arrivals.add(this.now, 1);
      this.startService(state, msg);
    }
  }

  /** Round-robin-free deterministic pull: oldest message across feeding queues. */
  private takeFromSources(state: NodeState): Req | null {
    let best: NodeState | null = null;
    let bestTime = Infinity;
    for (let i = 0; i < state.sources.length; i++) {
      const q = this.nodes.get(state.sources[i]);
      if (!q || q.waitHead >= q.waiting.length) continue;
      const head = q.waiting[q.waitHead];
      if (head.enterMs < bestTime) {
        bestTime = head.enterMs;
        best = q;
      }
    }
    if (!best) return null;
    const msg = best.waiting[best.waitHead];
    best.waiting[best.waitHead] = undefined as unknown as Req;
    best.waitHead++;
    this.compactWaiting(best);
    return msg;
  }

  private compactWaiting(state: NodeState): void {
    if (state.waitHead > 64 && state.waitHead * 2 >= state.waiting.length) {
      state.waiting.splice(0, state.waitHead);
      state.waitHead = 0;
    }
  }

  /* ---------------- completion of a node's own work ---------------- */

  /** This node finished its own service; decide whether to call downstream. */
  private onServiceComplete(state: NodeState, req: Req): void {
    if (req.resolved) return;

    const fault = this.faults.get(state.id);

    // The node died while this request was in service. Its work is lost; the
    // slot it held has already been released by the normal path above, so the
    // accounting stays in one place.
    if (fault && this.downBy(fault, state)) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'crashed', req.ownMs);
      return;
    }

    // Independent per-attempt failure.
    if (state.config.errorRate > 0 && this.rng.next() < state.config.errorRate) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'error', req.ownMs);
      return;
    }

    // Injected error rate, rolled after (and independently of) the node's own.
    // Two separate rolls rather than a combined probability, so clearing the
    // fault leaves the configured errorRate behaving exactly as before.
    if (fault && fault.kind === 'errors' && this.rng.next() < fault.rate) {
      state.errors.add(this.now, 1);
      state.totalFailed++;
      this.resolve(req, false, 'error', req.ownMs);
      return;
    }

    const hook = state.behaviour.onServiceComplete;
    if (hook && hook(this, state, req) === 'complete') {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    if (state.out.length === 0) {
      this.completeNode(state, req, req.ownMs);
      return;
    }

    this.dispatchDownstream(state, req);
  }

  /** Record this node's own latency and resolve the call upward. */
  private completeNode(state: NodeState, req: Req, latencyMs: number): void {
    state.completions.add(this.now, 1);
    state.totalCompleted++;
    state.latency.add(this.now, latencyMs);
    this.resolve(req, true, 'error', latencyMs);
  }

  /* ---------------- timeouts ---------------- */

  /**
   * Arm the caller's deadline on one outgoing call. `caller` supplies the
   * timeoutMs; `call` is the child request being bounded.
   */
  private armTimeout(caller: NodeState, call: Req): void {
    const t = caller.config.timeoutMs;
    if (!(t > 0)) return;
    this.push(this.now + t, EV_TIMEOUT, caller.id, call, call.token);
  }

  /**
   * The caller gave up on this call. The call itself is NOT cancelled: it
   * keeps its server slot and keeps running until its service time elapses.
   * Abandoned-but-still-running work is what makes a retry storm compound,
   * so it must stay on the books.
   */
  private onTimeout(call: Req): void {
    if (call.resolved) return;

    // Attribute the timeout to the caller that gave up.
    const parent = call.parent;
    const callerState = parent ? this.nodes.get(parent.nodeId) : null;
    if (callerState) {
      // Giving up is what this counter means, so it belongs here and only
      // here: this is the node whose deadline elapsed.
      callerState.timeouts.add(this.now, 1);
      // The failure itself is NOT booked here. Every node already has one
      // path that books it when the request ends there: `resolve` for the
      // root client, and the fan-out join for everything below it, both of
      // which fire for every reason rather than only this one. Booking it
      // here as well is what made a node fail more often than the system did.
    }

    // Detach the call from its parent so its eventual completion is discarded,
    // then report the timeout upward (which may trigger a retry).
    call.parent = null;
    call.abandoned = true;

    if (parent && !parent.resolved) {
      this.childResolvedFrom(call, parent, false, 'timeout', this.now - call.enterMs);
    }
  }

  /* ---------------- resolution & join ---------------- */

  /**
   * Resolve one request. `latencyMs` is the latency this call contributes to
   * its parent (own service time plus the joined subtree).
   */
  private resolve(
    req: Req,
    ok: boolean,
    reason: FailureReason,
    latencyMs: number,
  ): void {
    if (req.resolved) return;
    req.resolved = true;

    // A blocking node's slot is held until its request resolves, and every
    // way a request ends comes through here, so this is the one release that
    // cannot be missed. It runs before the answer travels upward: the thread
    // is free the moment its answer leaves. For every other kind the slot was
    // already released at service end and `heldAt` is null.
    const held = req.heldAt;
    if (held !== null) this.releaseHeld(held, req);

    // Recorded here rather than at each completion site: resolve() is the one
    // funnel every request passes through however it ends, so a hop cannot be
    // missed by a path that finishes some other way. Measuring it anywhere
    // else meant only the client was ever recorded.
    this.recordHop(req);

    const parent = req.parent;

    if (parent === null) {
      if (req.detached || req.abandoned) {
        // Either a queue message that finished its worker path, or work the
        // caller already timed out on. Nobody is waiting for this result.
        if (ok && req.ackedIn !== null) req.ackedIn.writesLanded++;
        if (!ok && req.queuedIn !== null) req.queuedIn.jobsFailed++;
        // Free the sampler if this was the traced one, or nothing would ever
        // be traced again.
        if (this.tracing === req) this.tracing = null;
        this.recycle(req);
        return;
      }
      // Root request measured at the client.
      const total = this.now - req.rootStartMs;
      if (req.trace) {
        // Deepest first would be arbitrary; ordering by depth then by the
        // moment each hop finished gives the reader the path in the order
        // the request actually walked it.
        const hops = req.trace.slice().sort((a, b) => a.depth - b.depth);
        this.lastTrace = {
          startMs: req.rootStartMs,
          totalMs: total,
          ok,
          reason: ok ? null : reason,
          hops,
        };
        this.tracing = null;
      }
      const client = this.nodes.get(req.nodeId);
      const route = client?.route ?? null;
      const tally = this.tally;
      if (tally !== null) {
        const rt = tallyRoute(tally, req.nodeId);
        if (ok) {
          tallyLatency(tally, total);
          tallyLatency(rt, total);
        } else {
          tallyFailure(tally, reason);
          tallyFailure(rt, reason);
        }
      }
      if (route !== null) {
        if (ok) {
          route.good.add(this.now, 1);
          route.latency.add(this.now, total);
          route.totalCompleted++;
        } else {
          routeFailed(route, this.now, reason);
        }
      }
      if (ok) {
        this.sysGood.add(this.now, 1);
        this.sysLatency.add(this.now, total);
        if (client) {
          client.completions.add(this.now, 1);
          client.totalCompleted++;
          client.latency.add(this.now, total);
        }
      } else {
        this.sysFailed.add(this.now, 1);
        this.totalFailed++;
        this.failures[reason] = (this.failures[reason] ?? 0) + 1;
        if (client) {
          client.totalFailed++;
          // No timeout arm. `onTimeout` already attributed it to whichever
          // node gave up, which is this client when it called its dependency
          // directly and some node below it otherwise. Counting it again here
          // is what made a client's timeout rate outrun the load it offered.
          if (reason === 'shed') client.sheds.add(this.now, 1);
          else if (reason !== 'timeout') client.errors.add(this.now, 1);
        }
      }
      this.recycle(req);
      return;
    }

    this.childResolvedFrom(req, parent, ok, reason, latencyMs);
    this.recycle(req);
  }

  /** A backoff delay elapsed: re-issue the failed downstream call. */
  private onRetry(state: NodeState, parent: Req): void {
    if (parent.resolved) return;
    // The thread waiting out this backoff died with its node (see
    // reclaimParked). Nobody is left to make the call; the join fails it.
    if (parent.lostReason !== null) {
      this.childResolved(parent, false, parent.lostReason, 0);
      return;
    }
    const edge = state.out.find((e) => e.id === parent.retryTarget);
    if (!edge) {
      this.childResolved(parent, false, 'no-route', 0);
      return;
    }
    this.sendChild(state, parent, edge, parent.retryAttempt);
  }

  private childResolvedFrom(
    child: Req,
    parent: Req,
    ok: boolean,
    reason: FailureReason,
    latencyMs: number,
  ): void {
    if (parent.resolved) return; // Parent already gave up: discard the result.

    // Report the outcome to the caller's behaviour, for kinds that watch their
    // dependency's health. Deliberately BEFORE the retry decision, so a
    // breaker sees every individual attempt rather than only the last one --
    // a dependency failing three times and succeeding on the fourth retry is
    // three failures' worth of evidence, not zero. Purely observational: it
    // cannot change what happens next.
    const caller = this.nodes.get(parent.nodeId);
    if (caller && caller.behaviour.observesOutcome) {
      caller.behaviour.onDownstreamResult!(this, caller, child, ok, reason);
    }

    if (!ok) {
      const parentState = this.nodes.get(parent.nodeId);
      const retries = parentState
        ? Math.max(0, Math.floor(parentState.config.retries))
        : 0;
      // A parent whose thread was lost (see reclaimParked) has nobody left to
      // retry, so the failure goes straight to the join.
      if (
        parentState &&
        child.attempt < retries &&
        reason !== 'depth' &&
        reason !== 'no-route' &&
        parent.lostReason === null
      ) {
        // Re-issue the same downstream call. This is real extra load.
        const edge = parentState.out.find((e) => e.id === child.retryTarget);
        if (edge) {
          const attempt = child.attempt + 1;
          // Exponential backoff with jitter. Without a delay a shed (which
          // fails in zero time) would let a request burn its whole retry
          // budget in the same instant, making the collapse infinitely sharp
          // instead of a progression the student can watch develop.
          const backoff = RETRY_BASE_BACKOFF_MS * pow(2, attempt - 1);
          const delay = backoff * (0.5 + this.rng.next());
          parent.retryTarget = edge.id;
          parent.retryAttempt = attempt;
          this.push(this.now + delay, EV_RETRY, parentState.id, parent, parent.token);
          return;
        }
      }
    }

    this.childResolved(parent, ok, reason, latencyMs);
  }

  private childResolved(
    parent: Req,
    ok: boolean,
    reason: FailureReason,
    latencyMs: number,
  ): void {
    if (parent.resolved) return;

    if (!ok && !parent.childFailed) {
      parent.childFailed = true;
      parent.childReason = reason;
    }
    if (latencyMs > parent.maxChildMs) parent.maxChildMs = latencyMs;

    parent.pending--;
    if (parent.pending > 0) return;

    const parentState = this.nodes.get(parent.nodeId);
    const total = parent.ownMs + parent.maxChildMs;

    // The thread that made these calls died while it waited for them (see
    // reclaimParked). Whatever the children said, there is no one left to
    // answer the caller. Booked like the crash check in onServiceComplete,
    // and instead of the failure branch below, so it is counted once.
    const lost = parent.lostReason;
    if (lost !== null) {
      if (lost === 'crashed' && parentState) {
        parentState.errors.add(this.now, 1);
        parentState.totalFailed++;
      }
      this.resolve(parent, false, lost, total);
      return;
    }

    if (parent.childFailed) {
      // Same as above: resolve() books the client's failure itself.
      if (parentState && parentState.behaviour.creditsJoinCompletion)
        parentState.totalFailed++;
      this.resolve(parent, false, parent.childReason, total);
      return;
    }

    // A client is credited once, in resolve(), where end-to-end latency is
    // measured. Counting it here as well would double every root request.
    if (parentState && parentState.behaviour.creditsJoinCompletion) {
      parentState.completions.add(this.now, 1);
      parentState.totalCompleted++;
      parentState.latency.add(this.now, total);
    }
    this.resolve(parent, true, 'error', total);
  }

  /* ---------------- BehaviourCtx surface ---------------- *
   *
   * The small, deliberate set of engine operations a behaviour may drive.
   * Everything a behaviour needs goes through here; nothing exposes the heap,
   * the request pool, or a writable clock, so a behaviour cannot desynchronise
   * the simulation.
   * ------------------------------------------------------ */

  /** One draw from the deterministic RNG. */
  roll(): number {
    return this.rng.next();
  }

  /** Queued (not yet in service) request count. */
  queueDepth(state: NodeStateLike): number {
    const s = state as NodeState;
    return s.waiting.length - s.waitHead;
  }

  effectiveQueueLimit(state: NodeStateLike): number {
    return Math.max(0, Math.floor(state.config.queueLimit));
  }

  /**
   * How many requests this node can serve at once: `instances * capacity`.
   *
   * `capacity` is the slot count of ONE instance and `instances` is how many
   * of them are running, so the product is the node's real parallelism and is
   * what every slot decision in the engine compares against. A topology that
   * never mentions `instances` runs one instance, and the product collapses to
   * `capacity` -- which is exactly the quantity this function returned before
   * the instance model existed, so nothing written against the old meaning
   * changes behaviour.
   */
  /**
   * The rate this client is offering RIGHT NOW, after its traffic pattern.
   *
   * `config.rps` is the baseline the reader set and keeps its meaning; the
   * pattern scales it. Absent or `steady` returns the baseline unchanged, so
   * every design written before patterns existed behaves exactly as it did.
   *
   * A pure function of simulation time and config: nothing is carried between
   * ticks and the RNG is untouched, so the same seed and topology still
   * replay byte-identically.
   */
  effectiveRps(state: NodeStateLike): number {
    const base = state.config.rps;
    const pattern = state.config.traffic;
    if (!pattern || pattern === 'steady' || !(base > 0)) return base;

    const periodS = state.config.trafficPeriodS ?? DEFAULT_TRAFFIC_PERIOD_S;
    if (!(periodS > 0)) return base;

    const t = (this.now / 1000) % periodS;
    const phase = t / periodS;

    switch (pattern) {
      case 'ramp':
        // Climbs over the first cycle and holds. Past one period the reader
        // is watching a system at full load, which is the point of a ramp:
        // it is how you got there that differs, not where you end up.
        return this.now / 1000 >= periodS ? base : base * phase;
      case 'spike':
        // Quiet, then a burst in the last tenth of the cycle. The burst is
        // 4x the baseline and the quiet is a tenth of it, so the MEAN over a
        // cycle stays near the baseline: the reader is comparing the same
        // amount of work arriving unevenly, not simply more work.
        return phase >= SPIKE_QUIET_FRACTION ? base * SPIKE_PEAK : base * SPIKE_TROUGH;
      case 'diurnal': {
        // A day as a cosine between a quarter of the baseline and twice it.
        // Smooth because real daily traffic has no corners, and offset so a
        // run starts in the small hours rather than mid-peak.
        const swing = (1 - cos(2 * Math.PI * phase)) / 2;
        return base * (DIURNAL_TROUGH + (DIURNAL_PEAK - DIURNAL_TROUGH) * swing);
      }
      default:
        return base;
    }
  }

  effectiveCapacity(state: NodeStateLike): number {
    const instances = this.effectiveInstances(state);
    // One machine down leaves the rest. With only one there is no rest, and
    // the node is crashed outright (see downBy), so the slot count is left as
    // it is: a crashed node's work has to drain to be failed.
    const live =
      (state as NodeState).instancesDown > 0 && instances > 1
        ? instances - 1
        : instances;
    return Math.max(1, Math.floor(state.config.capacity)) * live;
  }

  /**
   * How many instances this node is running, >= 1.
   *
   * Absent means one, which is what makes the field additive: every topology,
   * preset and saved graph written before instances existed keeps its exact
   * behaviour. Floored rather than rounded so a slider mid-drag can never
   * conjure a fractional machine.
   */
  effectiveInstances(state: NodeStateLike): number {
    const raw = state.config.instances;
    // `Math.max(1, Math.floor(NaN))` is NaN, so the ">= 1" above was a promise
    // this could not keep, and `units.length = NaN` throws where it is read.
    if (raw === undefined || !Number.isFinite(raw)) return 1;
    return Math.min(MAX_INSTANCES, Math.max(1, Math.floor(raw)));
  }

  countHit(state: NodeStateLike): void {
    (state as NodeState).hits.add(this.now, 1);
  }

  countMiss(state: NodeStateLike): void {
    (state as NodeState).misses.add(this.now, 1);
  }

  fail(req: ReqLike, reason: FailureReason, latencyMs: number): void {
    this.resolve(req as Req, false, reason, latencyMs);
  }

  /**
   * Refuse a request at a node with an arbitrary reason. This is the general
   * form of the engine's own shed path; the two differ only in which counter
   * is credited. Booked against `errors` rather than `sheds` because a
   * throttle or an open circuit is a deliberate refusal, not queue overflow.
   */
  reject(stateLike: NodeStateLike, req: ReqLike, reason: FailureReason): void {
    const state = stateLike as NodeState;
    state.errors.add(this.now, 1);
    state.totalFailed++;
    this.resolve(req as Req, false, reason, 0);
  }

  resumeAdmission(stateLike: NodeStateLike, reqLike: ReqLike): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    if (req.resolved) return;
    req.ownMs = 0;
    this.beginZeroService(state, req);
  }

  wakeAfter(stateLike: NodeStateLike, reqLike: ReqLike, delayMs: number): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    this.push(
      this.now + Math.max(0, delayMs),
      EV_BEHAVIOUR_WAKE,
      state.id,
      req,
      req.token,
    );
  }

  countCustom(stateLike: NodeStateLike, name: string, n: number): void {
    const state = stateLike as NodeState;
    let map = state.custom;
    if (!map) {
      map = new Map<string, RateCounter>();
      state.custom = map;
    }
    let counter = map.get(name);
    if (!counter) {
      counter = new RateCounter();
      map.set(name, counter);
    }
    counter.add(this.now, n);
  }

  counterRate(stateLike: NodeStateLike, name: string): number {
    const counter = (stateLike as NodeState).custom?.get(name);
    return counter ? counter.rate(this.now) : 0;
  }

  /* ---- controller surface ---- */

  utilizationOf(nodeId: string): number | null {
    const state = this.nodes.get(nodeId);
    return state ? state.utilization : null;
  }

  /**
   * How big a node's fleet is, in whatever unit that kind scales along --
   * instances for an ordinary server, slots-per-shard for a sharded store.
   *
   * Null means the kind has no fleet a controller can move. Reading back the
   * same quantity setScale() writes is what keeps a controller's arithmetic
   * consistent with what it observes.
   */
  scaleOf(nodeId: string): number | null {
    const state = this.nodes.get(nodeId);
    if (!state) return null;
    const field = state.behaviour.scaleField;
    if (field === undefined) return null;
    if (field === 'shardCapacity') {
      return Math.max(1, Math.floor(state.config.shardCapacity));
    }
    return this.effectiveInstances(state) - this.deadInstances(state);
  }

  /**
   * Instances counted in the fleet that are down and serve nothing. A
   * controller sees and sizes only the rest: counting the dead one as
   * running, it would scale the live ones away under light load and leave
   * the node with only the dead machine.
   */
  private deadInstances(state: NodeState): number {
    return state.instancesDown > 0 && this.effectiveInstances(state) > 1
      ? state.instancesDown
      : 0;
  }

  /**
   * Resize a node's fleet. Both the runtime state and the stored topology are
   * updated, so the Inspector shows what the controller actually did rather
   * than the value the student last typed. Newly freed slots are pumped
   * immediately, exactly as a manual change is.
   *
   * Writing `instances` rather than `capacity` is the substance of the
   * intuitiveness fix: the controller adds machines, the canvas draws
   * machines, and the number it moved is the number the student sees grow.
   */
  setScale(nodeId: string, units: number): void {
    const state = this.nodes.get(nodeId);
    if (!state) return;
    // Write whichever knob this kind actually scales along. A sharded store
    // ignores `instances` entirely, so writing it there would make the
    // controller a silent no-op that ramps to maxCapacity while nothing
    // improves. A kind with no scale field is left alone outright.
    const field = state.behaviour.scaleField;
    if (field === undefined) return;
    // `units` counts the machines that are up, the same as scaleOf() reads,
    // so a dead one is added back to keep it in the fleet until it is fixed.
    const next =
      Math.max(1, Math.floor(units)) +
      (field === 'instances' ? this.deadInstances(state) : 0);
    if (state.config[field] === next) return;
    const fault = this.faults.get(nodeId);
    const wasDown = fault !== undefined && this.downBy(fault, state);
    state.config[field] = next;
    const node = this.topology.nodes.find((n) => n.id === nodeId);
    if (node) node.config[field] = next;
    this.refitInstanceCrash(state, wasDown);
    this.pumpQueue(state);
  }

  /**
   * The node a controller drives, or '' when it is not wired to one.
   *
   * Read from the node's CONTROL edges, which are held separately from `out`
   * so that a request can never be dispatched down one. Taking the first is
   * deliberate: one controller drives one target, and a second control edge
   * would be an ambiguity the student should see rather than a silent merge.
   */
  controlTargetOf(stateLike: NodeStateLike): string {
    const ctrl = (stateLike as NodeState).ctrl;
    if (ctrl.length === 0) return '';
    // A severed control edge means the controller cannot reach its target.
    // Reporting no target is what makes an injected partition on a controller
    // do the thing it says on the tin: the fleet freezes at whatever size it
    // had, which is exactly how a real control plane losing its data plane
    // behaves.
    if (this.cutEdges.size > 0 && this.cutEdges.has(ctrl[0].id)) return '';
    return ctrl[0].to;
  }

  isCrashed(nodeId: string): boolean {
    const fault = this.faults.get(nodeId);
    const state = this.nodes.get(nodeId);
    return fault !== undefined && state !== undefined && this.downBy(fault, state);
  }

  /**
   * Does `fault` leave `state` with nothing serving? A crash does, and so
   * does losing one instance of a node that runs only one.
   */
  private downBy(fault: Fault, state: NodeState): boolean {
    return (
      fault.kind === 'crash' ||
      (fault.kind === 'crash-instance' && this.effectiveInstances(state) <= 1)
    );
  }

  /**
   * Service a request on behalf of a behaviour that runs its own slot
   * discipline. Deliberately does NOT touch state.busy: for a sharded store
   * the meaningful occupancy is per-shard, and double-counting it in the
   * node-level counter would make `utilization` wrong. Everything after the
   * service time -- error roll, onServiceComplete, routing, completion -- is
   * the same path every other kind takes.
   */
  serveWithin(
    stateLike: NodeStateLike,
    reqLike: ReqLike,
    onDrained: (ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) => void,
  ): void {
    const state = stateLike as NodeState;
    const req = reqLike as Req;
    req.enterMs = this.now;
    req.onDrained = onDrained;
    req.heldAt = state;
    this.placeOnInstance(state, req);
    // Drawn even when serviceMs is 0, unlike drawServiceMs(): this path has
    // always drawn, and skipping it would move every later draw in the run.
    const ms = this.ownServiceMs(
      state,
      req,
      this.rng.serviceTime(state.config.serviceMs, state.config.serviceCv),
    );
    req.ownMs = ms;
    if (ms > 0) {
      this.push(this.now + ms, EV_SERVICE_DONE, state.id, req, req.token);
    } else {
      this.onServiceDone(state, req);
    }
  }

  addServiceDelay(reqLike: ReqLike, extraMs: number): void {
    if (!(extraMs > 0)) return;
    (reqLike as Req).extraServiceMs += extraMs;
  }

  addWaitDelay(reqLike: ReqLike, extraMs: number): void {
    if (!(extraMs > 0)) return;
    (reqLike as Req).extraWaitMs += extraMs;
  }

  markWrite(reqLike: ReqLike, isWrite: boolean): void {
    (reqLike as Req).isWrite = isWrite;
  }

  /**
   * Create a DETACHED request at `state` and dispatch it down one specific
   * outgoing edge, for kinds that originate traffic of their own on an
   * event-driven schedule: a stream broker delivering the next message to a
   * consumer group, a pub/sub topic fanning one publish out to each
   * subscriber, a cron job dumping its batch.
   *
   * The message is a detached root -- nobody upstream is waiting on it, so
   * its eventual success or failure is booked at the nodes it visits and
   * never at the system level, exactly like a queue message drained by a
   * worker. The join still runs through this node, which means a behaviour
   * declaring `observesOutcome` hears about each delivery's result in
   * onDownstreamResult; that is how a broker paces a consumer group.
   *
   * Returns false without emitting when the edge is cut, the target does
   * not exist, or the live-request ceiling is reached -- the caller decides
   * what an undeliverable message means (a broker holds it; a cron drops
   * it). Consumes no randomness itself; the service-time draws happen at
   * the nodes the message visits, in event order, like any other request.
   *
   * This is a ctx addition, not an event-loop change: dispatch, admission
   * and resolution all run the same code every other request runs.
   */
  emitDetached(stateLike: NodeStateLike, edge: SimEdge, key: number): boolean {
    const state = stateLike as NodeState;
    if (this.liveRequests >= MAX_LIVE_REQUESTS) return false;
    if (this.cutEdges.size > 0 && this.cutEdges.has(edge.id)) return false;
    if (!this.nodes.has(edge.to)) return false;
    const msg = this.acquireReq();
    msg.nodeId = state.id;
    msg.parent = null;
    msg.rootStartMs = this.now;
    msg.enterMs = this.now;
    msg.hop = 0;
    msg.detached = true;
    msg.key = ((Math.floor(key) % KEYSPACE) + KEYSPACE) % KEYSPACE;
    msg.pending = 1;
    this.sendChild(state, msg, edge, 0);
    return true;
  }

  /**
   * Store a per-shard utilisation vector for the snapshot. Copied rather than
   * retained, so a behaviour reusing its own scratch array cannot mutate what
   * the UI is about to read.
   */
  reportShardUtilization(stateLike: NodeStateLike, perShard: readonly number[]): void {
    const dst = (stateLike as NodeState).shardUtil;
    dst.length = perShard.length;
    for (let i = 0; i < perShard.length; i++) dst[i] = perShard[i];
  }

  /**
   * Publish a kind's own instance vector. Writes into the node's working
   * buffer; the copy-on-change publish happens once per snapshot in
   * finishInstances(), so a behaviour cannot force an allocation by calling
   * this more often than another kind does.
   */
  reportInstances(
    stateLike: NodeStateLike,
    perUnit: readonly number[],
    pending: number,
  ): void {
    const state = stateLike as NodeState;
    const units = state.instanceUnits;
    units.length = perUnit.length;
    for (let i = 0; i < perUnit.length; i++) units[i] = perUnit[i];
    state.instancePending = pending > 0 ? Math.floor(pending) : 0;
  }

  /**
   * Fill the working instance buffer for an `instanceModel: 'slots'` kind.
   *
   * One unit per INSTANCE -- one machine, holding `capacity` slots -- and the
   * per-unit numbers are a WATERLINE: `utilization * instances`
   * busy-instance-equivalents poured in from index 0. The engine integrates
   * one smoothed utilisation per node, not one per instance, and requests go
   * to whichever slot is free, so there is no per-machine truth to report and
   * inventing one would be a prettier lie than the waterline.
   *
   * The count is read through effectiveInstances(), so a stack drawn from this
   * is exactly the fleet the autoscaler most recently wrote.
   *
   * A machine down to a 'crash-instance' fault is unit 0 and reads 0, and the
   * waterline fills the machines still up: utilisation is measured against
   * their slots alone, so that is the share of them that is busy.
   */
  private fillSlotInstances(state: NodeState): void {
    const instances = this.effectiveInstances(state);
    const units = state.instanceUnits;
    units.length = instances;
    const down = state.instancesDown < instances ? state.instancesDown : instances;
    for (let i = 0; i < down; i++) units[i] = 0;

    // Utilisation can sit marginally above 1 when a node is oversubscribed;
    // the waterline is capped so no unit ever reports more than full.
    const util =
      state.utilization > 1 ? 1 : state.utilization > 0 ? state.utilization : 0;
    let remaining = util * (instances - down);
    for (let i = down; i < instances; i++) {
      if (remaining >= 1) {
        units[i] = 1;
        remaining -= 1;
      } else {
        units[i] = remaining > 0 ? remaining : 0;
        remaining = 0;
      }
    }
  }

  /**
   * Copy the working instance buffer into the snapshot, allocating a new array
   * only when something actually changed.
   *
   * The reference identity of the published array is the signal a memoised
   * consumer keys off: unchanged contents keep the previous array, so a
   * shallow compare correctly says "nothing to redraw", and any change at all
   * -- a single unit's utilisation, the unit count, the pending count --
   * yields a brand new array that no such compare can mistake for the old one.
   */
  private finishInstances(state: NodeState, entry: NodeStats): void {
    const units = state.instanceUnits;
    const prev = state.instancePublished;

    let changed = prev === null || prev.length !== units.length;
    if (!changed && prev !== null) {
      for (let i = 0; i < units.length; i++) {
        if (prev[i] !== units[i]) {
          changed = true;
          break;
        }
      }
    }
    // The pending count rides on the same array identity, so a change in it
    // alone still has to force a republish -- otherwise warming-up units would
    // appear or vanish without the consumer being told anything changed.
    if (state.instancePending !== state.instancePendingPublished) changed = true;

    if (changed) {
      state.instancePublished = units.slice();
      state.instancePendingPublished = state.instancePending;
    }

    entry.instances = units.length;
    entry.perInstance = state.instancePublished ?? units;
    if (state.instancePending > 0) entry.instancesPending = state.instancePending;
  }

  /**
   * Record a self-managing kind's true occupancy, for the utilisation
   * integration to use in place of state.busy. Stored rather than applied
   * immediately so smoothing stays on the engine's clock and a behaviour
   * cannot make its meter jump by reporting more often than another kind.
   */
  reportOccupancy(stateLike: NodeStateLike, busySlots: number, capacity: number): void {
    const state = stateLike as NodeState;
    const busy = busySlots > 0 ? busySlots : 0;
    const cap = capacity > 0 ? capacity : 1;
    const slot = state.ownOccupancy;
    if (slot === null) {
      state.ownOccupancy = { busy, capacity: cap };
      return;
    }
    slot.busy = busy;
    slot.capacity = cap;
  }

  isEdgeCut(edgeId: string): boolean {
    return this.cutEdges.has(edgeId);
  }

  /* ---------------- utilization integration ---------------- */

  private integrateAll(): void {
    for (const state of this.nodes.values()) {
      const dt = this.now - state.lastIntegrateMs;
      state.lastIntegrateMs = this.now;
      if (dt <= 0) continue;
      // A kind that runs its own slot discipline reports occupancy itself,
      // because serveWithin() never touches state.busy and the raw counter
      // would read 0 however saturated the node really is.
      //
      // Utilisation is work. A slot parked on a downstream call is held but
      // idle, so it is left out here and shown as waitingOnDownstream instead;
      // admission still counts it, which is how a blocked server sheds while
      // its meter reads low. A self-reporting kind decides for itself (a
      // lambda reports concurrency, because that is what it throttles on).
      const own = state.ownOccupancy;
      const capacity = own !== null ? own.capacity : this.effectiveCapacity(state);
      const busy =
        own !== null
          ? own.busy
          : state.busy > state.parked
            ? state.busy - state.parked
            : 0;
      // A buffer's slot count is meaningless, so it reports zero utilisation.
      const instant = state.behaviour.servesRequests
        ? Math.min(capacity > 0 ? busy / capacity : 0, 1)
        : 0;
      // Exponential smoothing over roughly a 1s window.
      const alpha = 1 - exp(-dt / 500);
      state.utilization += (instant - state.utilization) * alpha;
      state.busyMsAccum += busy * dt;
    }
  }

  /**
   * Autonomous per-advance work for kinds that act without a request arriving.
   * No current kind declares onTick, so tickNodes is empty and this is never
   * reached; it exists so an autoscaler or circuit breaker can be added as a
   * pure registry entry.
   */
  private runTicks(dtMs: number): void {
    for (let i = 0; i < this.tickNodes.length; i++) {
      const state = this.tickNodes[i];
      state.behaviour.onTick!(this, state, dtMs);
    }
  }

  /* ---------------- history ---------------- */

  private maybeRecordHistory(): void {
    while (this.now - this.lastHistoryMs >= HISTORY_INTERVAL_MS) {
      this.lastHistoryMs += HISTORY_INTERVAL_MS;
      const t = this.lastHistoryMs;
      this.sysLatency.percentiles(this.now, this.pctScratch);
      const good = this.sysGood.rate(this.now);
      const failed = this.sysFailed.rate(this.now);
      const done = good + failed;
      this.history.push({
        t,
        p50: this.pctScratch[0],
        p95: this.pctScratch[1],
        p99: this.pctScratch[2],
        goodput: good,
        offered: this.sysOffered.rate(this.now),
        errorRate: done > 0 ? failed / done : 0,
      });
      if (this.history.length > HISTORY_MAX) {
        this.history.splice(0, this.history.length - HISTORY_MAX);
      }
      for (let i = 0; i < this.clientIds.length; i++) {
        const route = this.nodes.get(this.clientIds[i])?.route;
        if (route) this.recordRoutePoint(route, t);
      }
    }
  }

  private recordRoutePoint(route: RouteState, t: number): void {
    route.latency.percentiles(this.now, this.routePctScratch);
    const good = route.good.rate(this.now);
    const failed = route.failed.rate(this.now);
    const done = good + failed;
    route.history.push({
      t,
      goodput: good,
      errorRate: done > 0 ? failed / done : Number.NaN,
      p99: good > 0 ? this.routePctScratch[2] : Number.NaN,
    });
    if (route.history.length > HISTORY_MAX) {
      route.history.splice(0, route.history.length - HISTORY_MAX);
    }
  }

  /**
   * Each client's own end-to-end figures, in topology order. Built fresh on
   * every call; `history` is the one live array in it.
   *
   * Deliberately not in snapshot(): adding a field there would change the
   * bytes of every snapshot a test or a replay has ever pinned, and a caller
   * that does not draw routes should not pay for them.
   */
  routes(): RouteStats[] {
    const now = this.now;
    const out: RouteStats[] = [];
    for (let i = 0; i < this.clientIds.length; i++) {
      const id = this.clientIds[i];
      const client = this.nodes.get(id);
      const route = client?.route;
      if (!client || !route) continue;
      route.latency.percentiles(now, this.routePctScratch);
      const good = route.good.rate(now);
      const failed = route.failed.rate(now);
      const failureRates: Partial<Record<FailureReason, number>> = {};
      for (const [reason, counter] of route.failedBy) {
        const r = counter.rate(now);
        if (r > 0) failureRates[reason] = r;
      }
      out.push({
        clientId: id,
        offeredRps: client.arrivals.rate(now),
        goodputRps: good,
        failedRps: failed,
        errorRate: good + failed > 0 ? failed / (good + failed) : 0,
        p50: this.routePctScratch[0],
        p95: this.routePctScratch[1],
        p99: this.routePctScratch[2],
        failureRates,
        totalRequests: route.totalRequests,
        totalCompleted: route.totalCompleted,
        totalFailed: route.totalFailed,
        failuresByReason: { ...route.failures },
        history: route.history,
      });
    }
    return out;
  }

  /* ---------------- pools ---------------- */

  private push(
    time: number,
    kind: number,
    nodeId: string,
    req: Req | null,
    token: number,
  ): void {
    const ev = this.freeEv.pop();
    if (ev) {
      ev.time = time;
      ev.seq = this.seq++;
      ev.kind = kind;
      ev.nodeId = nodeId;
      ev.req = req;
      ev.token = token;
      this.heap.push(ev);
      return;
    }
    this.heap.push({ time, seq: this.seq++, kind, nodeId, req, token });
  }

  private releaseEv(ev: Ev): void {
    ev.req = null;
    if (this.freeEv.length < 4096) this.freeEv.push(ev);
  }

  private acquireReq(): Req {
    this.liveRequests++;
    const pooled = this.freeReq;
    if (pooled) {
      this.freeReq = pooled.next;
      pooled.next = null;
      pooled.token = (pooled.token + 1) | 0;
      pooled.nodeId = '';
      pooled.parent = null;
      pooled.pending = 0;
      pooled.maxChildMs = 0;
      pooled.childFailed = false;
      pooled.childReason = 'error';
      pooled.enterMs = 0;
      pooled.arriveMs = 0;
      pooled.trace = null;
      pooled.rootStartMs = 0;
      pooled.hop = 0;
      pooled.attempt = 0;
      pooled.abandoned = false;
      pooled.holdingSlot = false;
      pooled.heldAt = null;
      pooled.parked = false;
      pooled.parkPrev = null;
      pooled.parkNext = null;
      pooled.lostReason = null;
      pooled.instance = -1;
      pooled.viaEdge = '';
      pooled.detached = false;
      pooled.ackedIn = null;
      pooled.queuedIn = null;
      pooled.retryTarget = '';
      pooled.retryAttempt = 0;
      pooled.ownMs = 0;
      pooled.resolved = false;
      pooled.key = 0;
      pooled.isWrite = false;
      pooled.extraServiceMs = 0;
      pooled.extraWaitMs = 0;
      pooled.onDrained = null;
      return pooled;
    }
    return {
      token: 1,
      nodeId: '',
      parent: null,
      pending: 0,
      maxChildMs: 0,
      childFailed: false,
      childReason: 'error',
      enterMs: 0,
      arriveMs: 0,
      trace: null,
      rootStartMs: 0,
      hop: 0,
      attempt: 0,
      abandoned: false,
      holdingSlot: false,
      heldAt: null,
      parked: false,
      parkPrev: null,
      parkNext: null,
      lostReason: null,
      instance: -1,
      viaEdge: '',
      detached: false,
      ackedIn: null,
      queuedIn: null,
      retryTarget: '',
      retryAttempt: 0,
      ownMs: 0,
      next: null,
      resolved: false,
      key: 0,
      isWrite: false,
      extraServiceMs: 0,
      extraWaitMs: 0,
      onDrained: null,
    };
  }

  private recycle(req: Req): void {
    this.liveRequests--;
    // Bump the token so any timer still referencing this incarnation is stale.
    req.token = (req.token + 1) | 0;
    req.parent = null;
    // A pooled request must not keep a dropped node's state alive. resolve()
    // has already released the slot, so this only drops the reference.
    req.heldAt = null;
    req.next = this.freeReq;
    this.freeReq = req;
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/**
 * Mark every node that sits on a call cycle, giving the nodes of one cycle
 * the same index (the strongly connected components of the request graph,
 * by Tarjan's algorithm). An edge into or out of a buffer is left out: a
 * queue answers its caller at once and hands its consumer a message nobody
 * waits on, so no thread can wait across it. Runs once per topology edit.
 */
function markCycles(nodes: Map<string, NodeState>): void {
  const index = new Map<NodeState, number>();
  const low = new Map<NodeState, number>();
  const stack: NodeState[] = [];
  const onStack = new Set<NodeState>();
  let counter = 0;
  let cycles = 0;

  const follows = (from: NodeState, edge: SimEdge): NodeState | null => {
    const to = nodes.get(edge.to);
    if (!to) return null;
    if (from.behaviour.buffersForConsumers || to.behaviour.buffersForConsumers)
      return null;
    return to;
  };

  const visit = (v: NodeState): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    let selfLoop = false;
    for (const edge of v.out) {
      const w = follows(v, edge);
      if (w === null) continue;
      if (w === v) selfLoop = true;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const members: NodeState[] = [];
    let w: NodeState | undefined;
    do {
      w = stack.pop() as NodeState;
      onStack.delete(w);
      members.push(w);
    } while (w !== v);
    const cyclic = members.length > 1 || selfLoop;
    const id = cyclic ? cycles++ : -1;
    for (const m of members) m.cycle = id;
  };

  for (const state of nodes.values()) {
    if (!index.has(state)) visit(state);
  }
}

function createNodeState(node: SimNode): NodeState {
  return {
    id: node.id,
    kind: node.kind,
    behaviour: behaviourFor(node.kind),
    config: { ...node.config },
    busy: 0,
    parked: 0,
    parkHead: null,
    discarded: false,
    cycle: -1,
    waiting: [],
    waitHead: 0,
    out: [],
    ctrl: [],
    sources: [],
    busyMsAccum: 0,
    lastIntegrateMs: 0,
    utilization: 0,
    arrivals: new RateCounter(),
    completions: new RateCounter(),
    errors: new RateCounter(),
    sheds: new RateCounter(),
    timeouts: new RateCounter(),
    hits: new RateCounter(),
    misses: new RateCounter(),
    latency: new LatencyRing(),
    totalCompleted: 0,
    totalFailed: 0,
    arrivalGeneration: 0,
    pollScheduled: false,
    shardUtil: [],
    instanceUnits: [],
    instancePublished: null,
    instancePending: 0,
    instancePendingPublished: -1,
    instanceBusy: null,
    instanceNext: 0,
    instancesDown: 0,
    ext: null,
    custom: null,
    ownOccupancy: null,
    route: behaviourFor(node.kind).generatesLoad ? createRouteState() : null,
  };
}

/**
 * Project an internal Fault into the public ActiveFailure shape, carrying only
 * the knobs that actually apply to its kind so the UI does not render a
 * meaningless "factor 1" against a crash.
 */
function describeFault(nodeId: string, f: Fault): ActiveFailure {
  const out: ActiveFailure = { nodeId, kind: f.kind, sinceMs: f.sinceMs };
  if (f.kind === 'slow') out.factor = f.factor;
  else if (f.kind === 'errors') out.rate = f.rate;
  else if (f.kind === 'partition') out.edgeIds = f.edgeIds.slice();
  return out;
}

/**
 * A schedule as the engine plays it: shape-checked (targets are checked when
 * an entry comes due, since an edit may add or remove them) and sorted by
 * time. Array.prototype.sort is stable, so entries sharing a time keep their
 * list order, which is the order `FaultEvent` promises they apply in.
 */
function sortedSchedule(input: unknown): FaultEvent[] {
  return sanitizeFaults(input).sort((a, b) => a.atMs - b.atMs);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function cloneTopology(t: Topology): Topology {
  return {
    nodes: t.nodes.map((n) => ({ ...n, config: { ...n.config } })),
    edges: t.edges.map((e) => ({ ...e })),
  };
}
