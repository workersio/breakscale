export type NodeKind =
  | 'client'
  | 'lb'
  | 'service'
  | 'cache'
  | 'db'
  | 'queue'
  | 'worker'
  | 'autoscaler'
  | 'region'
  | 'cdn'
  | 'ratelimiter'
  | 'breaker'
  | 'replica'
  | 'shard'
  | 'objectstore'
  | 'searchindex'
  | 'timeseriesdb'
  | 'graphdb'
  | 'coldstorage'
  | 'vectordb'
  | 'streambroker'
  | 'pubsub'
  | 'websocket'
  | 'apigateway'
  | 'sidecar'
  | 'lambda'
  | 'cron'
  | 'bulkhead'
  | 'retryqueue'
  | 'transcoder'
  | 'edgecompute'
  | 'writebehind'
  | 'loadshedder';

/** Tunable knobs per node kind. Not every field applies to every kind. */
export interface NodeConfig {
  /**
   * Parallel request slots ON ONE INSTANCE -- threads, connections, workers
   * inside a single process. This is a property of the machine image, not of
   * the fleet: it is what a student sets, and an autoscaler never touches it.
   *
   * The quantity that actually decides how much work a node can do at once is
   * `instances * capacity`. See `instances` below for why the two are split.
   */
  capacity: number;
  /**
   * How many copies of this node are running -- machines, pods, containers.
   * Defaults to 1 when absent, which is exactly the behaviour of every
   * topology written before this field existed: one instance holding
   * `capacity` slots, so `instances * capacity === capacity`.
   *
   * WHY THIS EXISTS. `capacity` alone had to mean two different things at
   * once. A student reads "traffic went up, so we added servers"; the engine
   * read "the number of threads went up". Those are not the same lesson, and
   * the ambiguity is what made the autoscaler feel like it did nothing: it
   * incremented a thread count nobody could see. Splitting the two gives each
   * number one job -- `capacity` is how big one box is, `instances` is how
   * many boxes there are -- and it makes the autoscaler do the thing its name
   * promises: it adds and removes INSTANCES, which is what a real one does.
   *
   * Only kinds with an instance model read it (service, worker, db, cache,
   * lb, cdn). A shard's fleet size is `shardCount` and a replica set's is
   * `replicaCount`; both already had their own honest count and neither is
   * driven through this field.
   */
  instances?: number;
  /** Mean service time in ms for one request. */
  serviceMs: number;
  /** Coefficient of variation of service time. 0 = deterministic, 1 = exponential. */
  serviceCv: number;
  /** Max queued requests before shedding load. */
  queueLimit: number;
  /** Fraction of reads answered without hitting downstream. Cache only. */
  hitRate: number;
  /** Probability a request fails on its own (bad deploy, bug). */
  errorRate: number;
  /**
   * ms after which the caller gives up on one downstream call, per attempt.
   * 0 = no timeout. A caller that blocks on its calls (a service, a worker, a
   * lambda) holds its slot until the answer or this deadline, so this is also
   * the longest a slow dependency can pin one of its threads per attempt.
   */
  timeoutMs: number;
  /**
   * Retries on failure/timeout. A blocking caller keeps its slot through the
   * backoff and every retry, as a thread inside a retry loop does.
   */
  retries: number;
  /** Client only: requests per second offered to the system. */
  rps: number;
  /**
   * Client only: how the offered rate varies over time.
   *
   * `rps` stays the BASELINE the reader set, and the pattern scales it. Real
   * traffic is never a flat line, and a system that copes with 500 a second
   * arriving evenly can still fall over when the same 500 arrive in a burst.
   *
   * Absent means steady, so every topology and saved design written before
   * patterns existed keeps its exact behaviour. The engine reads it through
   * `effectiveRps`, which is a pure function of simulation time: no state is
   * carried between ticks, so a seed and a topology still replay identically.
   */
  traffic?: TrafficPattern;
  /**
   * Client only: seconds for one full cycle of `traffic`.
   *
   * What a cycle means depends on the pattern: for `ramp` it is the climb
   * from nothing to the baseline, for `spike` the gap between bursts, for
   * `diurnal` a whole simulated day. Defaults to `DEFAULT_TRAFFIC_PERIOD_S`
   * when absent.
   */
  trafficPeriodS?: number;

  /* ---- autoscaler ------------------------------------------------- *
   * An autoscaler is a controller, not a request path. It watches one node's
   * utilisation and writes that node's INSTANCE COUNT -- it adds and removes
   * machines, leaving `capacity` (the size of one machine) alone.
   *
   * It is joined to the node it drives by a CONTROL EDGE (`SimEdge.control`),
   * which carries no requests. See SimEdge.
   * ------------------------------------------------------------------ */

  /**
   * Autoscaler only: utilisation the controller aims to hold the watched
   * node at, 0..1. Above it the controller scales up, below `targetUtil`
   * minus a dead band it scales down.
   */
  targetUtil?: number;
  /**
   * Autoscaler only: fewest instances the controller will leave running.
   *
   * Named `minCapacity` for backward compatibility -- every existing preset
   * and saved topology sets it -- but the unit is INSTANCES, matching what
   * the controller now writes. For the one-instance-per-slot topologies that
   * predate the instance model the two readings coincide, so nothing that
   * already worked changes meaning.
   */
  minCapacity?: number;
  /** Autoscaler only: most instances the controller will run. In instances. */
  maxCapacity?: number;
  /**
   * Autoscaler only: ms the controller must wait after one decision before
   * it may make another. Models the metric/decision interval of a real
   * autoscaler and is the main knob that determines whether it oscillates.
   */
  cooldownMs?: number;
  /**
   * Autoscaler only: size of a single scaling step as a fraction of the
   * current instance count, 0..1. 0.5 means "add or remove half the fleet".
   * A step always moves at least one instance, so a small percentage of a
   * small fleet is never a silent no-op.
   */
  scaleStepPct?: number;
  /**
   * Autoscaler only: ms between a scale-UP decision and the new instances
   * actually serving traffic (boot + image pull + warm-up). Scale-DOWN is
   * immediate, as it is in reality. This delay is what makes capacity lag
   * load, and it is the single most important knob in the component: it is
   * why a student sees requests fail *after* the autoscaler already decided
   * to help.
   */
  warmupMs?: number;

  /* ---- region ------------------------------------------------------ *
   * A region node is a failover switch in front of N downstream edges,
   * where edge index i is region i.
   * ------------------------------------------------------------------ */

  /**
   * Region only: how many of this node's outgoing edges are treated as
   * regions. Edge index i is region i; edges beyond `regions` are ignored.
   */
  regions?: number;
  /**
   * Region only: index of the region currently serving traffic, 0-based.
   * Set by the student, and advanced automatically by failover.
   */
  activeRegion?: number;
  /**
   * Region only: ms of downtime between the active region being detected as
   * failed and traffic actually landing on the next one. Requests arriving
   * during this window fail with 'region-down' -- failover is not free.
   */
  failoverMs?: number;

  /* ---- ratelimiter -------------------------------------------------- *
   * A token bucket in front of a downstream. It refills continuously in
   * simulated time, so admissions over T seconds converge on rate*T rather
   * than being quantised by any tick interval.
   * ------------------------------------------------------------------- */

  /**
   * Rate limiter only: sustained admission rate in tokens (requests) per
   * second. One token is spent per admitted request; the bucket refills at
   * exactly this many tokens per second of simulated time.
   */
  rateLimitRps?: number;
  /**
   * Rate limiter only: bucket size in tokens. This is the largest burst
   * admitted instantly from an idle limiter, and it is also the bucket's
   * refill ceiling. Defaults to `rateLimitRps` when unset.
   */
  burst?: number;

  /* ---- breaker ------------------------------------------------------ *
   * A circuit breaker wrapping its downstream. It watches the downstream's
   * error rate over a trailing window and, once that exceeds the threshold,
   * fails fast without calling downstream at all.
   * ------------------------------------------------------------------- */

  /**
   * Breaker only: downstream error fraction over the trailing window above
   * which the breaker trips OPEN, 0..1. 0.5 means "trip once half the
   * downstream calls in the window are failing".
   */
  errorThreshold?: number;
  /**
   * Breaker only: length of the trailing window over which the downstream
   * error fraction is measured, in ms. Outcomes older than this are
   * forgotten, so a recovered downstream stops holding old failures.
   */
  windowMs?: number;
  /**
   * Breaker only: ms the breaker stays OPEN (failing fast) before it moves
   * to HALF-OPEN and allows probe traffic through again.
   */
  openMs?: number;
  /**
   * Breaker only: number of probe requests admitted while HALF-OPEN. If all
   * of them succeed the breaker CLOSES; if any fails it re-OPENS
   * immediately and the remaining probes are not sent.
   */
  halfOpenProbes?: number;

  /* ---- cdn ---------------------------------------------------------- *
   * An edge cache in front of everything. It reuses `hitRate`, `serviceMs`
   * and `capacity` from the common knobs above; a miss costs a round trip to
   * whatever origin is wired downstream, which is where its teaching value
   * lives. It needs no extra config field of its own.
   * ------------------------------------------------------------------- */
  /* ---- replica: a read-replica set behind a primary ---------------- */

  /**
   * Number of read replicas in the set. Read capacity is
   * `replicaCount * capacity` slots; writes are serialised through the
   * primary's own `capacity` slots. Floored to at least 1.
   */
  replicaCount: number;
  /**
   * Replication lag in ms: how long a write takes to reach the replicas.
   * A read of a key issued less than this long after that key was written
   * is served from a replica that has not caught up yet, and is counted as
   * a stale read. 0 means synchronous replication and never goes stale.
   */
  replicationLagMs: number;
  /**
   * Fraction of traffic that is reads, 0..1. Reads go to the replicas (and
   * may be stale); the remainder are writes, which go to the primary and
   * then propagate.
   */
  readFraction: number;

  /* ---- shard: horizontal partitioning ------------------------------ */

  /**
   * Number of partitions. A request is routed to `key % shardCount`, so
   * each shard is an independent queue-and-servers unit. Floored to >= 1.
   */
  shardCount: number;
  /**
   * Parallel request slots *per shard*. Total capacity across the node is
   * `shardCount * shardCapacity`, but a single shard can only ever use its
   * own slots -- which is exactly why a hot key melts one shard.
   */
  shardCapacity: number;
  /**
   * Fraction of traffic forced onto one single shard, 0..1, regardless of
   * the request's own key. 0 spreads traffic by key as normal; 0.8 sends
   * 80% of it to shard 0 and leaves the rest nearly idle.
   */
  hotKeyFraction: number;

  /* ---- searchindex: a search cluster with asynchronous indexing ----- *
   * Reads (searches) are cheap; writes pay an extra indexing cost, and a
   * committed write is not searchable until `indexLagMs` later. The read
   * vs write split reuses `readFraction` above.
   * ------------------------------------------------------------------- */

  /**
   * Search index only: extra service milliseconds a WRITE pays on top of
   * the drawn `serviceMs`, for tokenising and updating the inverted index.
   * Searches pay only `serviceMs`. This asymmetry is why bulk writes can
   * starve a search cluster whose queries were never the problem.
   */
  indexMs?: number;
  /**
   * Search index only: milliseconds after a write COMMITS before the
   * document is visible to searches (the refresh interval of a real search
   * engine). A search for a key inside that window is served from the old
   * index and is counted as a stale search. 0 means instantly searchable.
   */
  indexLagMs?: number;

  /* ---- timeseriesdb: cheap appends, expensive range queries --------- */

  /**
   * Time-series store only: fraction of traffic that is RANGE QUERIES,
   * 0..1. The rest are appends, which cost only `serviceMs`. Raising this
   * a few percent is enough to melt a store sized for pure ingest.
   */
  rangeQueryFraction?: number;
  /**
   * Time-series store only: extra service milliseconds a range query pays
   * on top of the drawn `serviceMs`, for scanning and aggregating many
   * points. Appends never pay it.
   */
  rangeQueryMs?: number;

  /* ---- graphdb: traversal cost grows with depth --------------------- */

  /**
   * Graph database only: how many hops a query traverses from its start
   * node, >= 1. Each extra hop multiplies the edges visited by ~3 (the
   * modelled mean out-degree), so query cost is
   * `serviceMs * 3^(traversalDepth - 1)`: depth 1 reads one neighbourhood,
   * depth 2 is friends-of-friends at 3x, depth 3 is 9x, and so on. This is
   * the knob that shows why a deep traversal gets expensive fast.
   */
  traversalDepth?: number;

  /* ---- vectordb: embedding search over a large index ---------------- */

  /**
   * Vector database only: size of the vector index, in THOUSANDS of
   * embeddings. Query cost grows with log2 of this, matching an ANN index
   * that probes more partitions as the corpus grows.
   */
  indexSizeK?: number;
  /**
   * Vector database only: target recall of the approximate search, 0..0.99.
   * Cost scales with `1 / (1 - recallTarget)`: 0.9 probes 10x more of the
   * index than 0, 0.99 probes 100x. Mean query cost works out to
   * `serviceMs * log2(2 + indexSizeK) / (1 - recallTarget)`, which is the
   * recall/latency trade-off drawn as one curve.
   */
  recallTarget?: number;

  /* ---- streambroker: a partitioned, replayable log ------------------ *
   * Kafka-shaped: producers are acknowledged immediately, messages land in
   * a partition by key, and every outgoing edge is an independent CONSUMER
   * GROUP with its own cursor. Within one partition a group consumes
   * serially, so `partitions` is the parallelism ceiling of every group.
   * `queueLimit` doubles as the log's RETENTION in messages: a group that
   * falls further behind than that skips ahead, and the skipped messages
   * are lost to it, exactly like expiring out of a Kafka topic.
   * ------------------------------------------------------------------- */

  /**
   * Stream broker only: number of partitions in the log. A message lands in
   * partition `key % partitions`, and one consumer group consumes at most
   * one message per partition at a time, so this is also the maximum
   * delivery parallelism of every group. Floored to >= 1.
   */
  partitions?: number;

  /* ---- websocket: capacity in held connections ---------------------- */

  /**
   * Websocket gateway only: mean lifetime of one connection in ms. Each
   * accepted connection occupies one of the node's `instances * capacity`
   * connection slots for exactly this long. Concurrent connections settle
   * at `rps * connectionMs / 1000` (Little's law), which is why a chat
   * gateway saturates on connection count rather than on request rate.
   */
  connectionMs?: number;

  /* ---- apigateway: auth in front of routing ------------------------- */

  /**
   * API gateway only: fraction of requests refused as 'unauthorized',
   * 0..1. Rolled at admission, after the token bucket, so a burst of bad
   * credentials still spends rate-limit tokens the way it does in life.
   */
  authFailRate?: number;

  /* ---- sidecar: outlier ejection ------------------------------------ */

  /**
   * Sidecar only: consecutive downstream failures after which the proxy
   * ejects its upstream and fails fast for `openMs`. A simpler policy than
   * the breaker's windowed error rate on purpose; this is Envoy-style
   * outlier detection, and having both flavours in the palette is itself
   * a lesson. Floored to >= 1; defaults to 5 when unset.
   */
  outlierAfter?: number;

  /* ---- lambda: serverless scaling ----------------------------------- */

  /**
   * Lambda only: extra latency in ms paid by a request that arrives when
   * no warm instance is idle. This is the cold start: the platform must
   * provision and boot an instance before the function body even runs.
   */
  coldStartMs?: number;
  /**
   * Lambda only: ms an idle warm instance is kept alive after finishing a
   * request before the platform reclaims it. Short keep-warm plus bursty
   * traffic is the recipe for a high cold-start rate.
   */
  keepWarmMs?: number;
  /**
   * Lambda only: most invocations allowed to run at once (the account
   * concurrency limit). Arrivals beyond it are refused as 'throttled';
   * a lambda has no queue of its own.
   */
  maxConcurrency?: number;

  /* ---- cron: scheduled batch load ----------------------------------- */

  /**
   * Cron only: ms between firings of the scheduled job. Each firing dumps
   * `batchSize` requests down every outgoing edge at once.
   */
  intervalMs?: number;
  /**
   * Cron only: requests emitted per outgoing edge each time the job fires.
   * The burst arrives effectively simultaneously, which is the point: it
   * is what a midnight report run does to a database.
   */
  batchSize?: number;

  /* ---- bulkhead: an isolated concurrency pool ------------------------ *
   * A gate in front of ONE dependency. It caps how many calls may be
   * outstanding to that dependency at once; the excess fails fast as
   * 'bulkhead-full' instead of queueing behind a slow downstream.
   * ------------------------------------------------------------------- */

  /**
   * Bulkhead only: most downstream calls allowed to be in flight at once
   * through this bulkhead. Requests arriving with the pool full are
   * refused immediately as 'bulkhead-full'. Floored to >= 1; defaults to
   * 8 when unset. By Little's law the pool supports roughly
   * `bulkheadMax / serviceSeconds` requests per second of admitted
   * traffic, and the cap is what keeps a slowed dependency's backlog
   * bounded instead of letting it grow without limit.
   */
  bulkheadMax?: number;
  /** Bulkhead only: reject immediately, or wait for a pool slot to open. */
  bulkheadMode?: BulkheadMode;
  /** Bulkhead only: waiting acquire requests allowed before shedding. */
  acquireQueueMax?: number;
  /** Bulkhead only: longest a request may wait to acquire a pool slot, in ms. */
  acquireTimeoutMs?: number;

  /* ---- retryqueue: retried delivery with a dead letter shelf --------- *
   * Reuses the shared knobs: `capacity` is delivery concurrency,
   * `serviceMs` the per-delivery dispatch cost, `queueLimit` the buffered
   * message ceiling, `timeoutMs` the per-attempt deadline, and `retries`
   * how many redeliveries a failed message gets before it is dead-lettered.
   * No field of its own is needed.
   * ------------------------------------------------------------------- */

  /* ---- writebehind: a write buffer in front of a store --------------- */

  /**
   * Write-behind cache only: ms an acknowledged write sits dirty in the
   * buffer before its flush lands on the backing store. Models the batch
   * interval of a real write-behind cache. The standing dirty population
   * is roughly `writeRate * (flushDelayMs / 1000)` writes, and that
   * population is exactly what a crash of this node loses. 0 means the
   * flush is issued immediately.
   */
  flushDelayMs?: number;

  /* ---- edgecompute: limited compute at the CDN edge ------------------ */

  /**
   * Edge compute only: fraction of requests the edge function can answer
   * entirely on its own, 0..1. The rest pass through to whatever is wired
   * downstream. This is capability, not caching: the edge is fast but
   * limited, and this knob is how limited.
   */
  edgeShare?: number;

  /* ---- loadshedder: priority-aware admission ------------------------- *
   * A token bucket like the rate limiter's (it reuses `rateLimitRps` and
   * `burst`), but it refuses by PRIORITY: low-priority traffic is turned
   * away while the bucket still holds a reserve, so high-priority traffic
   * keeps finding tokens when the system is saturated.
   * ------------------------------------------------------------------- */

  /**
   * Load shedder only: fraction of traffic classified low priority, 0..1.
   * Priority is derived deterministically from the request key (a hash of
   * the key against this share), so the same key is always the same
   * priority and no RNG draw is spent on classification. Defaults to 0,
   * under which every request is high priority and the shedder behaves
   * like a plain rate limiter.
   */
  lowPriorityShare?: number;
  /**
   * Load shedder only: fraction of the token bucket reserved for
   * high-priority traffic, 0..1. A low-priority request needs the bucket
   * to hold more than `1 + priorityReserve * burst` tokens; a
   * high-priority one needs only 1. Under saturation the bucket hovers
   * inside the reserve, so low-priority traffic is dropped first while
   * high-priority traffic keeps being admitted. Defaults to 0.3.
   */
  priorityReserve?: number;

  /* ---- db: write lock contention ------------------------------------- *
   * Reads share the slot pool freely. Writes also contend with each other:
   * each write entering service waits an extra `lockMs` for every other
   * write already in flight, which is row/page lock contention stated as
   * arithmetic. The consequence it teaches: adding instances multiplies
   * read capacity but does nothing for the write path, because the lock is
   * a property of the data, not of the fleet.
   * ------------------------------------------------------------------- */

  /**
   * Database only: extra service milliseconds a WRITE pays per concurrent
   * write already in flight when it starts. 0 (or unset) disables
   * contention entirely. The read/write split reuses `readFraction`.
   */
  lockMs?: number;

  /* ---- objectstore: per-prefix rate ceiling --------------------------- *
   * Blob stores scale by key prefix: each prefix is its own partition with
   * its own request-rate ceiling, and the store as a whole has no queue.
   * A hot prefix is refused with a 'slowdown' while the rest of the store
   * idles -- which is why S3 performance guidance is about key LAYOUT, not
   * about buying a bigger bucket.
   * ------------------------------------------------------------------- */

  /**
   * Object storage only: sustained requests per second ONE key prefix
   * sustains before further requests to it are refused ('throttled', the
   * S3 503 SlowDown). Keys map onto 8 fixed prefixes; uniform traffic
   * therefore sustains ~8x this figure while a single-prefix hotspot gets
   * exactly 1x. 0 or unset means no per-prefix limit.
   */
  prefixRps?: number;

  /* ---- transcoder: the quality ladder --------------------------------- */

  /**
   * Transcoder only: output files produced per finished job, per outgoing
   * edge -- the bitrate ladder of a real encode pipeline. Each finished
   * job hands `renditions` detached uploads to every node wired after the
   * farm; nothing waits on them. Storage therefore sees `renditions` times
   * the job rate, the write amplification every video pipeline budgets
   * for. Floored to >= 1; defaults to 3 when unset.
   */
  renditions?: number;

  /* ---- edgecompute: the CPU budget ------------------------------------ */

  /**
   * Edge compute only: hard per-request CPU budget in ms. An edge runtime
   * is not a server: a request whose execution runs past this budget is
   * killed at the edge and passed through to the origin path instead, even
   * when `edgeShare` says the code could have answered it. 0 or unset
   * means no budget.
   */
  cpuMsCap?: number;
}

export interface SimNode {
  id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  config: NodeConfig;
}

export interface SimEdge {
  id: string;
  from: string;
  to: string;
  /** Share of traffic leaving `from` that takes this edge (relative weight). */
  weight: number;

  /**
   * This edge is a CONTROL relationship, not a request path.
   *
   * A control edge says "`from` acts on `to`" -- an autoscaler driving the
   * node it resizes. It looks like a wire and it is drawn like one, but no
   * request ever crosses it: the engine leaves control edges out of every
   * node's routing set entirely, so fan-out, load-balancer edge selection and
   * region indices never see them. A student who wires an autoscaler beside a
   * service is stating a supervisory relationship, and previously that was
   * indistinguishable from wiring traffic INTO the controller -- which is a
   * mistake the topology had no way to express, let alone show.
   *
   * Absent or false means an ordinary request edge, so every topology written
   * before this field existed keeps its exact meaning.
   *
   * The engine also treats it as control when the SOURCE is a kind that only
   * ever supervises (an autoscaler), regardless of this flag -- see
   * `ComponentBehaviour.controlsTarget`. The flag is what lets the renderer
   * and the topology be explicit about it, and what would let some future
   * kind have a control edge and a request edge at the same time.
   */
  control?: boolean;

  /* ---- link characteristics (networking phase) ---------------------- *
   * All optional and absent from every preset, so nothing changes until one
   * is set. latencyMs and lossRate are implemented; bandwidthRps is declared
   * now so the shape does not have to churn later.
   * ------------------------------------------------------------------- */

  /**
   * Propagation delay across this link, in ms. A request crossing the edge
   * waits this long before it is offered to the target node. Undefined or 0
   * means an instantaneous hop, which is what every current preset uses.
   */
  latencyMs?: number;
  /**
   * DECLARED BUT UNUSED. Link capacity in requests/sec. The networking phase
   * will use this to queue and delay traffic once an edge is saturated;
   * today the engine ignores it entirely.
   */
  bandwidthRps?: number;
  /**
   * Fraction of crossings the link drops, 0..1. Each request offered to the
   * edge is lost with this probability, drawn from the seeded RNG, and the
   * CALLER sees it fail as 'packet-loss' at once, the way it sees a cut edge. A
   * retry is a fresh crossing with a fresh draw. Undefined, 0 or not a
   * number means a perfect link, and draws nothing, so the run is the same
   * one it was before the field was read. 1 or more drops everything.
   */
  lossRate?: number;
}

export interface Topology {
  nodes: SimNode[];
  edges: SimEdge[];
  /**
   * Canvas notes and sections. Documentation only: the engine never reads
   * this field, annotations carry no traffic and affect no metric. Optional
   * so every existing topology and saved design stays valid unchanged. The
   * shape lives in annotations.ts, which is where the engine-free reasoning
   * for it belongs.
   */
  annotations?: import('./annotations').Annotation[];
  /**
   * A timed fault schedule: crashes, slowdowns, error bursts and cut links,
   * each pinned to a moment of simulated time. The engine plays it from the
   * event loop, so the same seed, topology and schedule replay the same run
   * however the frames happen to fall. Optional, and absent from every
   * topology written before it existed, which therefore runs exactly as it
   * always did. See `FaultEvent`.
   */
  faults?: FaultEvent[];
  /**
   * The seed for the run's random draws (arrival gaps, service times, cache
   * hits), a whole number from 0 to 2^32 - 1. Saved with a design so that a
   * shared run replays exactly; the engine uses it when it is not handed a
   * seed of its own. Optional, and a topology without one runs on seed 1, as
   * every topology did before the field existed.
   */
  seed?: number;
}

/** Rolling stats for one node over the last window. */
export interface NodeStats {
  /**
   * Requests currently being served: doing this node's own work. A slot held
   * while waiting on a downstream call is not in it; see waitingOnDownstream.
   */
  inFlight: number;
  /**
   * Requests whose own work is done but which still hold a slot, because this
   * node blocks on its downstream calls and they have not all answered yet: a
   * thread sitting in a call to a slow database. These slots count against
   * capacity, so a node can queue and shed with a low utilisation.
   *
   * Present only on a kind that blocks (service, worker, lambda) and has at
   * least one outgoing request edge, and absent everywhere else, where it
   * could only ever read zero. `inFlight + waitingOnDownstream` is how many
   * slots are taken; a lambda's `runningNow` is the same total.
   */
  waitingOnDownstream?: number;
  /** Requests waiting for a slot. */
  queued: number;
  /** Completed requests per second. */
  throughput: number;
  /** Offered load per second (including those later dropped). */
  arrivalRate: number;
  /**
   * Fraction of slots doing work, 0..1, smoothed over about a second. Can
   * exceed 1 conceptually if oversubscribed. Work only: a slot waiting on a
   * downstream call (waitingOnDownstream) is not counted. A lambda reports
   * its concurrency instead, waiting invocations included, because that is
   * what it throttles and bills on.
   */
  utilization: number;
  p50: number;
  p95: number;
  p99: number;
  /** Fraction of requests that errored or were shed, 0..1. */
  errorRate: number;
  /** Requests dropped due to a full queue, per second. */
  shedRate: number;
  /** Requests that exceeded the caller's timeout, per second. */
  timeoutRate: number;
  /** Cache hit fraction observed this window (cache nodes only). */
  hitRate: number;
  /** Total completed since sim start. */
  totalCompleted: number;
  /** Total failed since sim start. */
  totalFailed: number;

  /* ================================================================== *
   * INSTANCE MODEL -- what this node is actually made of
   *
   * Every field above describes a node as ONE thing with one meter. Several
   * kinds are not one thing: a service scaled to 5 is five machines, a shard
   * with 4 partitions is four independent queue-and-server units, a replica
   * set is a primary plus N read replicas. The engine has always known this;
   * these three fields are how it says so, and they are what lets the canvas
   * draw a stack of instances or a row of partitions instead of a box.
   *
   * ------------------------------------------------------------------
   * WHAT ONE UNIT MEANS, PER KIND -- the decision, so the next agent
   * follows it rather than inventing a second interpretation:
   *
   *   service, worker, db, cache, lb, cdn
   *     ONE UNIT = ONE INSTANCE -- one machine, pod or container, holding
   *     `capacity` request slots. `instances` is `config.instances` (1 when
   *     unset), and the node's real parallelism is `instances * capacity`.
   *
   *     This is a DELIBERATE REVISION of the earlier reading, which made one
   *     unit one capacity slot. That reading was chosen because `capacity`
   *     was the knob the autoscaler wrote, and it had the fatal property that
   *     the drawn stack meant "threads" while every student read it as
   *     "servers". The slots-per-machine knob it complained did not exist now
   *     does: it is `capacity` itself, and `instances` is the fleet size the
   *     controller moves. The stack and the controller's steps still line up
   *     exactly -- the controller adds 1 instance and the picture gains 1
   *     card -- but now they line up on the quantity the student meant.
   *
   *     perInstance is a WATERLINE, not a per-machine busy flag. The engine
   *     integrates one smoothed utilisation per node, not one per instance,
   *     and requests are dispatched to whichever slot is free -- instance 3
   *     has no identity that outlives a request. So `utilization * instances`
   *     busy-instance-equivalents are filled from index 0: full units read 1,
   *     one boundary unit carries the remainder, the rest read 0. A stack
   *     drawn from this shows "3 of 5 busy" truthfully without inventing
   *     per-machine state the simulation does not have.
   *
   *   shard
   *     ONE UNIT = ONE PARTITION. perInstance[i] is shard i's own smoothed
   *     utilisation -- genuinely independent numbers, because a partition
   *     has its own slots and its own backlog. This is the kind where the
   *     vector carries the whole lesson: with a hot key one entry pins at
   *     1.0 while the others sit near 0 and the node-level mean looks fine.
   *
   *   replica
   *     ONE UNIT = ONE MEMBER OF THE SET, ordered [primary, replica 0,
   *     replica 1, ...], so instances === replicaCount + 1. Index 0 is the
   *     primary and reports the WRITE pool's utilisation; the rest share the
   *     read pool's utilisation, which is the honest reading because a read
   *     is served by whichever replica is free and the engine pools them.
   *     Drawing the primary distinctly from the read set is the point: the
   *     write pool saturating while the read set idles is why adding read
   *     replicas does not fix a write bottleneck.
   *
   *   client, queue, autoscaler, region, ratelimiter, breaker
   *     NOT an instance model. These report `instances` undefined. A queue is
   *     a buffer (draw its depth against queueLimit), a breaker and a limiter
   *     are gates, an autoscaler and a region are controllers. Giving them a
   *     stack would say something false about what they are.
   *
   * A consumer must treat `instances === undefined` as "this kind is one
   * thing" and fall back to the scalar meters, never as "zero instances".
   * ------------------------------------------------------------------ */

  /**
   * How many units this node currently represents, >= 1. Undefined for kinds
   * that are genuinely one thing (see the table above). For a kind whose unit
   * is an instance this equals the live `config.instances`, which is exactly
   * what an autoscaler writes.
   */
  instances?: number;
  /**
   * Units that have been DECIDED but are not serving yet -- an autoscaler's
   * scale-up during its `warmupMs`. Present and > 0 only while the watched
   * node has instances booked and still booting.
   *
   * These are NOT included in `instances`, and deliberately so: they cannot
   * take a request, so counting them as live would overstate the node and
   * would make the drawn stack claim capacity the system does not have. The
   * UI draws `instances` solid and `instancesPending` ghosted, and the
   * interval where the ghosts sit there while the queue builds behind them is
   * the whole teaching point of warm-up lag.
   */
  instancesPending?: number;
  /**
   * Machines that are down because of a 'crash-instance' fault. Present only
   * while one is, so a healthy snapshot is unchanged. The first
   * `instancesDown` entries of `perInstance` are those machines and read 0;
   * the waterline is poured into the rest. Counted inside `instances`, which
   * stays the fleet size the design asked for.
   */
  instancesDown?: number;
  /**
   * Utilisation per unit, 0..1, with `length === instances`. Undefined
   * whenever `instances` is. Index meaning is per-kind and fixed by the table
   * above -- partition i for a shard, [primary, ...replicas] for a replica
   * set, an anonymous waterline over interchangeable slots for the rest.
   *
   * OWNERSHIP: this array belongs to the snapshot that produced it. The
   * engine hands out a fresh array whenever the contents changed, so a
   * memoised React consumer comparing the previous NodeStats by reference (or
   * this field by reference) sees a new identity exactly when there is
   * something new to draw. Do not mutate it, and do not retain it across
   * snapshots expecting it to update in place -- it will not.
   */
  perInstance?: number[];

  /**
   * The node's queue limit in requests, mirrored from config so a drawable
   * `queued / queueLimit` fill needs only the snapshot. Always >= 0, and
   * always the same integer the engine actually sheds against -- reading
   * `config.queueLimit` instead would show the raw slider value rather than
   * the floored one the simulation enforces.
   *
   * For a shard this is the limit PER PARTITION, matching the per-shard
   * backlogs the behaviour keeps; for a replica set it is the one shared
   * backlog reads and writes both draw from.
   */
  queueLimit: number;

  /* ---- autoscaler readouts ---------------------------------------- *
   * Everything needed to narrate the controller's decision in words, without
   * the reader having to open the config panel:
   *
   *   "watching <watchedId>: it is at <watchedUtil> against my setpoint of
   *    <setpoint>. I want <targetInstances> instances, it has
   *    <watchedInstances>, <pendingInstances> are booting (<phase>)."
   * ------------------------------------------------------------------ */

  /**
   * Autoscaler only: instance count the controller has decided the watched
   * node should have. Differs from the watched node's live instance count for
   * `warmupMs` after a scale-up, which is exactly the lag worth seeing.
   */
  targetInstances?: number;
  /** Autoscaler only: the watched node's live instance count right now. */
  watchedInstances?: number;
  /**
   * Autoscaler only: true when the watched node has no fleet to resize, so
   * the controller can read the load correctly and still be unable to act.
   *
   * An object store is the case that prompted this: it is modelled as one
   * managed service rather than a pool of machines, exactly as S3 is, so
   * there is no instance count for a controller to move. Without this flag
   * the panel showed a healthy-looking readout beside a fleet that never
   * changed, and the only reasonable conclusion for a reader was that the
   * autoscaler was broken. That it cannot help here is the lesson: when a
   * blob store melts there is no "add servers" knob to reach for.
   */
  watchedUnscalable?: boolean;
  /**
   * Autoscaler only: instances decided but still booting. Equal to
   * `targetInstances - watchedInstances` while warming up, else 0. The same
   * number is attached to the WATCHED node as `instancesPending`, so the
   * stack that is about to grow can draw its own ghosts.
   */
  pendingInstances?: number;
  /**
   * Autoscaler only: id of the node this controller drives, or '' when it is
   * not wired to one. Resolved from its control edge, so a UI can name the
   * target without re-walking the topology.
   */
  watchedId?: string;
  /** Autoscaler only: the utilisation it is reacting to, 0..1. */
  watchedUtil?: number;
  /** Autoscaler only: the setpoint it is holding that utilisation against, 0..1. */
  setpoint?: number;
  /**
   * Autoscaler only: what the controller is doing right now.
   *
   *  - 'observing' gathering its first metric window on a target it has just
   *                been pointed at; it will not act yet.
   *  - 'warming'   a scale-up is booked and its instances are still booting.
   *  - 'cooldown'  it acted recently and is waiting out `cooldownMs`.
   *  - 'steady'    free to act, and the utilisation does not call for it.
   *
   * This is the field that turns the component from a silent box into
   * something a student can read a sentence off.
   */
  scalePhase?: 'observing' | 'warming' | 'cooldown' | 'steady';
  /**
   * Autoscaler only: ms until the current phase ends -- until observation
   * completes, until booked instances land, or until the cooldown expires.
   * 0 in 'steady'. Lets a UI draw a countdown rather than a frozen label.
   */
  phaseRemainingMs?: number;
  /**
   * Autoscaler only: true while a scale-up decision is booked but its
   * instances have not warmed up yet. Equivalent to `scalePhase === 'warming'`
   * and kept because it reads well as a boolean at a call site.
   */
  scaling?: boolean;

  /* ---- region readouts -------------------------------------------- */

  /** Region only: index of the region serving traffic right now, 0-based. */
  activeRegion?: number;
  /** Region only: true while mid-failover, when traffic is being dropped. */
  failingOver?: boolean;
  /**
   * Region only: ms of dark window left before the failover lands and the
   * next region starts serving. 0 whenever no failover is in progress, so a
   * UI can draw a countdown exactly while `failingOver` is true.
   */
  failoverRemainingMs?: number;
  /** Region only: how many of the declared regions are reachable right now. */
  regionsHealthy?: number;
  /** Region only: how many regions the node is switching between. */
  regionsTotal?: number;
  /**
   * Region only: the id of the outgoing edge traffic is actually taking right
   * now, or undefined when none is -- every region down, or mid-failover.
   * The standby edges are the node's other outgoing edges; they are also
   * marked individually in SimSnapshot.edgeState.
   */
  liveEdgeId?: string;
  /**
   * Fraction of reads served from a replica that had not yet caught up with
   * the latest write to that key, 0..1, over the current window. Replica
   * nodes only. Rises with replicationLagMs and with write volume.
   */
  staleReadRate: number;
  /**
   * Utilisation of the single busiest shard, 0..1. Shard nodes only. With a
   * hot key this pins at 1 while `utilization` (the mean across shards)
   * still looks healthy -- that gap is the lesson.
   */
  maxShardUtilization: number;
  /** Utilisation of the least busy shard, 0..1. Shard nodes only. */
  minShardUtilization: number;
  /**
   * Per-shard utilisation, 0..1, indexed by shard number. Shard nodes only;
   * empty for every other kind. Length tracks shardCount.
   */
  shardUtilization: number[];

  /* ---- cdn readouts ------------------------------------------------ */

  /**
   * CDN only: requests per second this edge cache had to fetch from origin
   * because they missed. This is the load that actually reaches your
   * servers; offered minus this is what the CDN absorbed. The observed hit
   * fraction is reported in the shared `hitRate` field above.
   */
  originFetchRate?: number;

  /* ---- ratelimiter readouts ---------------------------------------- */

  /** Rate limiter only: requests per second admitted (a token was spent). */
  admittedRate?: number;
  /** Rate limiter only: requests per second rejected as 'throttled'. */
  throttledRate?: number;
  /** Rate limiter only: tokens sitting in the bucket right now. */
  tokens?: number;

  /* ---- breaker readouts -------------------------------------------- */

  /** Breaker only: the circuit's current state. */
  breakerState?: 'closed' | 'open' | 'half-open';
  /**
   * Breaker only: downstream error fraction measured over the trailing
   * `windowMs`, 0..1. This is the quantity compared against
   * `errorThreshold` to decide whether to trip.
   */
  breakerErrorRate?: number;
  /** Breaker only: requests per second failed fast without calling downstream. */
  rejectedRate?: number;
  /** Breaker only: times the circuit has tripped OPEN since sim start. */
  breakerTrips?: number;
  /**
   * Breaker only: ms left before an OPEN circuit moves to half-open and
   * starts probing. 0 whenever the circuit is not open, so a UI can draw a
   * countdown on exactly the phase that has one.
   */
  openRemainingMs?: number;

  /* ---- searchindex readouts ----------------------------------------- */

  /**
   * Search index only: fraction of searches over the current window that
   * hit a key whose latest write had committed but was NOT yet searchable
   * (still inside `indexLagMs`), 0..1. This is the indexing lag made
   * visible: it rises with the lag and with write volume.
   */
  staleSearchRate?: number;
  /** Search index only: searches served per second over the window. */
  searchRate?: number;
  /** Search index only: writes (documents indexed) per second over the window. */
  indexWriteRate?: number;

  /* ---- timeseriesdb readouts ---------------------------------------- */

  /** Time-series store only: appends served per second over the window. */
  appendRate?: number;
  /** Time-series store only: range queries served per second over the window. */
  rangeQueryRate?: number;

  /* ---- graphdb readouts ---------------------------------------------- */

  /**
   * Graph database only: MEASURED mean service milliseconds per traversal
   * over the current window, including the depth multiplier. Compare it to
   * `serviceMs` to see what the configured depth is actually costing.
   */
  traversalCostMs?: number;

  /* ---- vectordb readouts ---------------------------------------------- */

  /**
   * Vector database only: MEASURED mean service milliseconds per query over
   * the current window, including the index-size and recall multipliers.
   * This is the number that moves when the recall slider does.
   */
  queryCostMs?: number;

  /* ---- streambroker readouts ---------------------------------------- */

  /**
   * Stream broker only: how many messages the WORST consumer group is
   * behind the head of the log, in messages, including deliveries still in
   * flight. This is the headline metric of a partitioned log: it grows
   * while a group's consumers are slower than the producers and drains
   * back toward zero when they catch up. Also mirrored into `queued` so
   * the generic backlog meter shows it against `queueLimit` (retention).
   */
  consumerLag?: number;
  /**
   * Stream broker only: lag per consumer group, in messages, indexed by
   * the group's outgoing-edge order. Length tracks the number of non-cut
   * outgoing edges; groups are independent, which is the point.
   */
  consumerLagByGroup?: number[];
  /** Stream broker only: messages delivered to consumers per second, all groups. */
  deliveryRate?: number;
  /**
   * Stream broker only: messages per second a lagging group SKIPPED because
   * they aged out of retention (`queueLimit`) before it reached them. Data
   * loss for that group, invisible to the producer. Nonzero means a consumer
   * is not merely behind; it is losing data.
   */
  retentionDropRate?: number;

  /* ---- pubsub readouts ----------------------------------------------- */

  /** Pub/sub only: subscriber edges currently fanned out to. */
  fanout?: number;
  /**
   * Pub/sub only: deliveries per second across all subscribers. With N
   * subscribers this reads N times the publish rate, and that
   * amplification is the entire lesson of the component.
   */
  publishAmplification?: number;

  /* ---- websocket readouts -------------------------------------------- */

  /** Websocket only: connections held open right now. */
  connectionsOpen?: number;
  /** Websocket only: the connection ceiling, `instances * capacity`. */
  maxConnections?: number;
  /** Websocket only: connections accepted per second over the window. */
  connectRate?: number;
  /** Websocket only: connections refused per second because the ceiling was hit. */
  connectionRejectRate?: number;

  /* ---- apigateway readouts ------------------------------------------- */

  /**
   * API gateway only: requests per second refused as 'unauthorized'. The
   * gateway's throttle readouts reuse `admittedRate`, `throttledRate` and
   * `tokens` above.
   */
  authRejectRate?: number;

  /* ---- sidecar readouts ----------------------------------------------- *
   * The sidecar's circuit readouts reuse `breakerState` and `rejectedRate`
   * above; its policy differs (consecutive failures, not a windowed rate)
   * but the states mean the same thing.
   * -------------------------------------------------------------------- */

  /** Sidecar only: consecutive downstream failures observed right now. */
  consecutiveFails?: number;
  /** Sidecar only: downstream call failures per second it observed. */
  upstreamFailRate?: number;

  /* ---- lambda readouts ------------------------------------------------ */

  /**
   * Lambda only: fraction of invocations over the window that paid a cold
   * start, 0..1. High after idling (the pool went cold) and during bursts
   * (arrivals outrun the warm pool); near zero under steady traffic.
   */
  coldStartRate?: number;
  /** Lambda only: cold starts per second over the window. */
  coldStartsPerSec?: number;
  /** Lambda only: warm instances sitting idle, ready to serve instantly. */
  warmIdle?: number;
  /**
   * Lambda only: invocations running right now, against `maxConcurrency`,
   * including those waiting on a call they made (waitingOnDownstream).
   */
  runningNow?: number;

  /* ---- cron readouts --------------------------------------------------- */

  /** Cron only: ms until the job fires next. */
  nextFireInMs?: number;
  /** Cron only: total requests emitted since sim start, all firings. */
  batchEmitted?: number;
  /**
   * Cron only: requests the next firing will emit, summed across every
   * outgoing edge. `batchSize x edges`, mirrored so a readout can state the
   * size of the burst without re-deriving it from config and wiring.
   */
  burstSize?: number;

  /* ---- bulkhead readouts ---------------------------------------------- */

  /** Bulkhead only: downstream calls in flight through the pool right now. */
  bulkheadInFlight?: number;
  /** Bulkhead only: the pool's concurrency ceiling, mirrored from config. */
  bulkheadLimit?: number;
  /** Bulkhead only: requests per second refused because the pool was full. */
  bulkheadRejectedRate?: number;
  /** Bulkhead only: requests currently waiting to acquire a pool slot. */
  bulkheadWaiting?: number;
  /** Bulkhead only: most recent measured wait before acquiring a pool slot. */
  bulkheadAcquireLatencyMs?: number;
  /** Bulkhead only: acquire attempts per second that reached their deadline. */
  bulkheadAcquireTimeoutRate?: number;

  /* ---- retryqueue readouts --------------------------------------------- */

  /** Retry queue only: messages per second delivered downstream successfully. */
  deliveredRate?: number;
  /**
   * Retry queue only: failed delivery attempts per second that were given
   * another try. Rises before dead letters do, so it is the early warning.
   */
  redeliveryRate?: number;
  /** Retry queue only: messages per second exhausting their retries. */
  deadLetterRate?: number;
  /**
   * Retry queue only: messages that exhausted every retry since sim start.
   * This is the dead letter shelf: failures with somewhere to go, counted
   * instead of vanished.
   */
  deadLetters?: number;

  /* ---- writebehind readouts -------------------------------------------- */

  /**
   * Write-behind cache only: acknowledged writes sitting dirty in the
   * buffer right now (buffered plus mid-flush). Every one of these is a
   * write the caller believes is safe and a crash of this node would lose.
   */
  dirtyWrites?: number;
  /** Write-behind cache only: writes per second landing on the backing store. */
  flushedRate?: number;
  /**
   * Write-behind cache only: flushes per second that FAILED at the backing
   * store. The caller was told "saved" long ago, so every one of these is a
   * silently lost write, which is the risk the component trades for latency.
   */
  flushFailRate?: number;

  /* ---- edgecompute readouts -------------------------------------------- */

  /** Edge compute only: requests per second answered entirely at the edge. */
  edgeHandledRate?: number;
  /** Edge compute only: requests per second passed through to the origin path. */
  passedThroughRate?: number;

  /* ---- loadshedder readouts --------------------------------------------- *
   * The shedder's bucket readouts reuse `admittedRate` and `tokens` above;
   * the fields below split admissions and drops by priority, which is the
   * readout that shows graceful degradation actually happening.
   * ---------------------------------------------------------------------- */

  /** Load shedder only: high-priority requests per second admitted. */
  highAdmittedRate?: number;
  /** Load shedder only: low-priority requests per second admitted. */
  lowAdmittedRate?: number;
  /** Load shedder only: high-priority requests per second dropped ('throttled'). */
  highSheddedRate?: number;
  /** Load shedder only: low-priority requests per second dropped ('deprioritized'). */
  lowSheddedRate?: number;

  /* ---- db readouts ------------------------------------------------------ *
   * The database's own mechanism is the write lock: reads share the pool,
   * writes also serialise against each other. These three numbers are that
   * mechanism measured, and they are why "add more instances" fixes a slow
   * read path but does nothing for a slow write path.
   * ---------------------------------------------------------------------- */

  /** Database only: reads per second entering service. */
  readRate?: number;
  /** Database only: writes per second entering service. */
  writeRate?: number;
  /**
   * Database only: mean extra milliseconds a write spent waiting on lock
   * contention, measured over the window. Grows with concurrent writers, not
   * with fleet size, which is the whole lesson.
   */
  lockWaitMs?: number;

  /* ---- objectstore readouts --------------------------------------------- */

  /**
   * Object storage only: requests per second refused because one key prefix
   * exceeded its per-prefix rate ceiling. The pool can be nearly idle while
   * this is nonzero: the limit is per prefix, not per store, which is why
   * hot-prefix layouts melt and spread ones do not.
   */
  slowdownRate?: number;

  /* ---- coldstorage readouts --------------------------------------------- *
   * Cold storage reuses `throttledRate` above for restore requests refused
   * because every retrieval slot was taken; `inFlight` is restore jobs
   * currently running. There is no queue: that absence is the component.
   * ---------------------------------------------------------------------- */

  /* ---- transcoder readouts ---------------------------------------------- */

  /**
   * Transcoder only: finished renditions per second handed downstream as
   * detached uploads. `renditions` output files leave per finished job, so
   * this runs at `renditions * jobRate`: the write amplification a video
   * pipeline pays for its quality ladder.
   */
  outputRate?: number;

  /* ---- edgecompute readouts --------------------------------------------- */

  /**
   * Edge compute only: requests per second the edge WOULD have answered but
   * could not, because their execution exceeded the per-request CPU budget
   * (`cpuMsCap`); they fell through to the origin path instead. The hard CPU
   * ceiling is what separates an edge runtime from a real server.
   */
  cpuExceededRate?: number;
}

/** End-to-end results measured at the client. */
export interface SystemStats {
  timeMs: number;
  offeredRps: number;
  goodputRps: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  totalRequests: number;
  totalFailed: number;
}

/**
 * How a client's offered rate varies over time.
 *
 * Each pattern scales the client's `rps` baseline; none of them replaces it.
 * The shapes are the ones a student meets first, and each one breaks a system
 * a different way:
 *
 * - `steady`   flat. The default, and the only one that was possible before.
 * - `ramp`     climbs from nothing to the baseline over one period, then
 *              holds. A launch, or traffic arriving as a region wakes up.
 * - `spike`    quiet at a tenth of the baseline, then a short burst well
 *              above it. This is the one that finds queue limits.
 * - `diurnal`  a smooth day: a trough overnight, a peak in the afternoon.
 *              Teaches that a system sized for the average is undersized for
 *              half the day.
 *
 * A thundering herd is deliberately NOT here. The other four are rate curves,
 * but a herd is correlated ARRIVALS: many callers retrying at the same instant
 * after a recovery. That is a different mechanism, not a different curve, and
 * modelling it as a tall thin spike would be a plausible-looking lie.
 */
export type TrafficPattern = 'steady' | 'ramp' | 'spike' | 'diurnal';

export const TRAFFIC_PATTERNS: readonly TrafficPattern[] = [
  'steady',
  'ramp',
  'spike',
  'diurnal',
];

/**
 * How a bulkhead answers a request it has no free slot for.
 *
 * `reject` fails it there and then, which is what a bulkhead has always
 * done. `wait` holds it until a slot frees or the acquire timeout fires,
 * which is how a client connection pool behaves and is the whole point of
 * modelling one.
 */
export type BulkheadMode = 'reject' | 'wait';

/**
 * The same list at runtime, for the validators that cannot read a type.
 * Written out beside the type rather than derived from it, for the reason
 * TRAFFIC_PATTERNS is: a union and an array cannot be generated from one
 * another in TypeScript, so the pairing is checked by a test instead.
 */
export const BULKHEAD_MODES: readonly BulkheadMode[] = ['reject', 'wait'];

/**
 * Seconds for one cycle when a client does not say.
 *
 * 60 is chosen so a reader watching in real time sees a whole cycle without
 * waiting: a full ramp, or a gap between two spikes, inside a minute.
 */
export const DEFAULT_TRAFFIC_PERIOD_S = 60;

export type FailureReason =
  | 'error'
  | 'shed'
  | 'timeout'
  | 'no-route'
  | 'depth'
  /** Refused by a rate limiter: no token was available in its bucket. */
  | 'throttled'
  /** Refused by an open circuit breaker: failed fast without calling downstream. */
  | 'rejected'
  /** The node is crashed by an injected failure, or was in flight when it crashed. */
  | 'crashed'
  /** The edge the call needed is cut by an injected network partition. */
  | 'partitioned'
  /** Lost crossing an edge with a lossRate: the link dropped it. */
  | 'packet-loss'
  /** No region was serving: the active one is down and failover has not landed. */
  | 'region-down'
  /** Refused by a websocket gateway: every connection slot was already held. */
  | 'conn-refused'
  /** Refused by an API gateway: the request failed authentication. */
  | 'unauthorized'
  /** Refused by a bulkhead: its concurrency pool was already full. */
  | 'bulkhead-full'
  /** A bulkhead waiter exceeded its acquire deadline before a slot opened. */
  | 'acquire-timeout'
  /** Dropped by a load shedder protecting higher-priority traffic. */
  | 'deprioritized';

/**
 * Lifetime failure counts by reason. `packet-loss` is the one optional key: it
 * appears only once a lossy edge has dropped a request, so a design with no
 * lossRate snapshots byte for byte as it did before the reason existed.
 * Read it with `?? 0`.
 */
export type FailureCounts = Record<Exclude<FailureReason, 'packet-loss'>, number> & {
  'packet-loss'?: number;
};

/* ------------------------------------------------------------------ *
 * Failure injection
 *
 * A chaos control, not a component: any node can be given a fault without
 * rewiring the topology, and clearing it restores the node exactly.
 * ------------------------------------------------------------------ */

export type FailureKind =
  /** The node is dead: in-flight work fails now, new work fails on arrival. */
  | 'crash'
  /**
   * One machine of the node is dead and the rest keep serving. The work that
   * machine held fails now, including threads parked on its downstream calls,
   * and its slots are gone until the fault is cleared, so the node runs at
   * `(instances - 1) * capacity` slots. Requests waiting in the node's line
   * are not on any one machine and stay in it. With a single instance there
   * is nothing left to serve, so it is exactly 'crash'. Only a kind that
   * scales by `instances` and holds slots only while it works can lose one;
   * see `canCrashOneInstance`.
   */
  | 'crash-instance'
  /** The node still works, but every service time is multiplied by `factor`. */
  | 'slow'
  /** The node returns errors at `rate`, on top of its configured errorRate. */
  | 'errors'
  /** Named edges are cut: a request offered to one fails as 'partitioned'. */
  | 'partition';

/**
 * The same list at runtime, for the validators that cannot read a type.
 * Written out beside the type for the reason TRAFFIC_PATTERNS is.
 */
export const FAILURE_KINDS: readonly FailureKind[] = [
  'crash',
  'slow',
  'errors',
  'partition',
  'crash-instance',
];

/** Knobs for an injected failure. Which ones apply depends on the kind. */
export interface FailureOpts {
  /**
   * 'slow' only: multiplier applied to the node's service time. 3 means
   * every request there takes three times as long. Values below 1 are
   * clamped to 1, since a fault may not make a node faster.
   */
  factor?: number;
  /**
   * 'errors' only: fraction of requests forced to fail at this node, 0..1.
   * Rolled independently of, and in addition to, config.errorRate.
   */
  rate?: number;
  /**
   * 'partition' only: ids of the edges to cut. Omitted or empty means every
   * edge leaving the node, which is the "unplug this box" case.
   */
  edgeIds?: string[];
}

/**
 * One entry in a topology's fault schedule.
 *
 * `atMs` is simulated time, never wall clock. An entry lands after every
 * event already due at that same millisecond, which is exactly where a fault
 * the student clicks in between two frames lands too, so a recorded run and
 * its replay agree. Entries sharing an `atMs` apply in list order.
 *
 *   inject   attach a fault to a node, as `Engine.injectFailure` does. It
 *            replaces whatever fault that node already had.
 *   clear    heal the node, as `Engine.clearFailure` does.
 *   cut      sever one edge, as `Engine.cutEdge` does. Independent of any
 *            node fault, so a node can be slow AND have one wire cut.
 *   restore  reconnect an edge that a `cut` severed. An edge cut by a
 *            node's 'partition' fault stays cut until that fault is cleared.
 */
export type FaultEvent =
  | {
      atMs: number;
      action: 'inject';
      nodeId: string;
      kind: FailureKind;
      opts?: FailureOpts;
    }
  | { atMs: number; action: 'clear'; nodeId: string }
  | { atMs: number; action: 'cut'; edgeId: string }
  | { atMs: number; action: 'restore'; edgeId: string };

/** An injected failure as reported back to the UI. */
export interface ActiveFailure {
  /** Node the failure is attached to. */
  nodeId: string;
  kind: FailureKind;
  /** Simulated time in ms at which it was injected. */
  sinceMs: number;
  /** 'slow' only: the service-time multiplier in force. */
  factor?: number;
  /** 'errors' only: the forced failure fraction, 0..1. */
  rate?: number;
  /** 'partition' only: the edge ids actually cut. */
  edgeIds?: string[];
}

/**
 * Why an edge is or is not carrying traffic right now.
 *
 * `edgeFlow` alone cannot answer this. An edge at 0 rps because a breaker in
 * front of it is OPEN and an edge at 0 rps because nobody happens to be
 * calling look identical as numbers, and they mean opposite things: the first
 * is a component doing its job, the second is an idle link. Drawing them the
 * same is precisely the dishonesty this field exists to remove -- a severed
 * wire should look severed.
 *
 * Exactly one state applies per edge, resolved in the order listed here:
 * a cut link is reported as 'cut' even if a breaker upstream is also open,
 * because the injected fault is the more specific truth about that wire.
 */
export type EdgeState =
  /** Cut by an injected 'partition' failure. Nothing crosses it at all. */
  | 'cut'
  /**
   * The source node is refusing to send: a breaker OPEN or half-open past its
   * probe budget. The link is fine; the component decided not to use it.
   */
  | 'blocked'
  /**
   * A region node's non-active edge. Wired, healthy, deliberately unused --
   * this is the standby region, and it must not look like a dead link.
   */
  | 'standby'
  /** Carrying traffic now. */
  | 'live'
  /** Wired and permitted, but nothing is flowing. Ordinary idleness. */
  | 'idle';

export interface SimSnapshot {
  system: SystemStats;
  nodes: Record<string, NodeStats>;
  /** Recent history for sparklines, newest last. */
  history: HistoryPoint[];
  /** Per-edge requests/sec, keyed by edge id. */
  edgeFlow: Record<string, number>;
  /**
   * Why each edge is in the state it is, keyed by edge id -- one entry per
   * edge in the topology, always populated. Read alongside `edgeFlow`: the
   * rate says how much, this says whether the wire is even usable.
   *
   * 'live' vs 'idle' is decided from the edge's own rate, so it flickers with
   * traffic and is only a hint; 'cut', 'blocked' and 'standby' are structural
   * assertions the engine stands behind, and are the ones worth drawing
   * differently.
   */
  edgeState: Record<string, EdgeState>;
  failuresByReason: FailureCounts;
  /**
   * Injected failures in force right now, one entry per faulted node. Empty
   * on a healthy system, so the UI can render a chaos indicator from this
   * alone without asking the engine anything else.
   */
  activeFailures: ActiveFailure[];
  /**
   * The most recent completed request, hop by hop, or null before one has
   * finished.
   *
   * Every other number in this snapshot is an aggregate: a rate, a
   * percentile, a mean. Those say latency ROSE without saying where it went,
   * and a student reading "p99 400ms" cannot tell whether the work got slower
   * or whether the request simply stood in line. This is the one place the
   * simulator answers that, which is why it is a single traced request rather
   * than a statistic: an average of queueing tells you less than one honest
   * example of it.
   */
  trace: RequestTrace | null;
}

/** One request's path, sampled and recorded end to end. */
export interface RequestTrace {
  /** Simulated ms at which the client issued it. */
  startMs: number;
  /** End-to-end latency the client measured. */
  totalMs: number;
  ok: boolean;
  /** Why it failed, when it did. */
  reason: FailureReason | null;
  hops: TraceHop[];
}

/**
 * One node on a traced request's path.
 *
 * `queuedMs` and `serviceMs` are kept apart deliberately. They are the whole
 * point: under load the second stays roughly flat while the first grows
 * without bound, and seeing those two bars move differently is the lesson
 * that no p99 reading can teach.
 */
export interface TraceHop {
  nodeId: string;
  /** Hop depth from the client, 0 for the client itself. */
  depth: number;
  /** Waiting in line before a server slot was free. */
  queuedMs: number;
  /** Doing the work, once a slot was held. */
  serviceMs: number;
}

export interface HistoryPoint {
  t: number;
  p50: number;
  p95: number;
  p99: number;
  goodput: number;
  offered: number;
  errorRate: number;
}

/**
 * Every client request that settled inside a tally window, as
 * `Engine.readTally()` reports it.
 *
 * The snapshot's percentiles come from a ring of the last 5 seconds, which is
 * the right thing to draw and the wrong thing to grade: a verdict has to see
 * every request in its window, not the ones that happened to fit. This is
 * that record, kept only while a tally is running.
 *
 * `arrived` counts requests the clients sent inside the window. `completed`
 * and `failed` count requests that finished inside it, wherever they started,
 * so the two halves need not add up to `arrived`: work still in flight at
 * either edge of the window is the difference.
 */
export interface RunTally {
  /** Simulated ms the tally started. */
  fromMs: number;
  /** Simulated ms it stopped, or the current time while it runs. */
  toMs: number;
  /** Client requests sent inside the window, the engine's own sheds included. */
  arrived: number;
  /** Client requests that succeeded inside the window. */
  completed: number;
  /** Client requests that failed inside the window. */
  failed: number;
  /** `failed`, split by why. A reason that never happened is absent. */
  failuresByReason: Partial<Record<FailureReason, number>>;
  /**
   * End-to-end ms of every success, in the order they finished, measured as
   * the client measured it. `length === completed`. A copy the caller owns.
   */
  latencies: Float64Array;
  /** Writes a write-behind cache acknowledged inside the window. */
  writesAcked: number;
  /**
   * How many of `writesAcked` have landed at the store so far, counted past
   * the window's end for as long as the engine has run since.
   */
  writesLanded: number;
  /** Jobs a queue accepted inside the window. */
  jobsQueued: number;
  /**
   * How many of `jobsQueued` failed once a worker took them, counted past the
   * window's end. The client heard yes for each, so none shows in `failed`.
   */
  jobsFailed: number;
  /**
   * The same counts split by the client that sent each request, keyed by the
   * client's node id. A client that sent nothing and had nothing settle in
   * the window is absent. The routes add up to the totals above.
   */
  byRoute: Record<string, RouteTally>;
}

/** One client's share of a `RunTally`. */
export interface RouteTally {
  arrived: number;
  completed: number;
  failed: number;
  failuresByReason: Partial<Record<FailureReason, number>>;
  /** End-to-end ms of this client's successes, in the order they finished. */
  latencies: Float64Array;
}

/**
 * How the requests one client sends are doing, end to end.
 *
 * Each client node is a route: the people behind it send their requests
 * through the system, and some of them can be failing while the others are
 * fine. The system figures average that away. These are measured from the
 * outcome of each of this client's own requests, as the client saw it, with
 * the same windows the system figures use.
 *
 * Read from `Engine.routes()`, not the snapshot, so a snapshot carries
 * exactly the bytes it always did.
 */
export interface RouteStats {
  /** The client node the route starts at. */
  clientId: string;
  /** Requests this client sent per second, the engine's own sheds included. */
  offeredRps: number;
  /** Its requests that succeeded, per second. */
  goodputRps: number;
  /** Its requests that failed, per second, for any reason. */
  failedRps: number;
  /**
   * Failed over settled in the rate window, 0..1, or 0 when nothing settled.
   * Check `goodputRps + failedRps` before reading a 0 as healthy.
   */
  errorRate: number;
  /**
   * End-to-end percentiles of its successes over the latency window, in ms,
   * from a ring of real latencies. 0 when nothing succeeded in it.
   */
  p50: number;
  p95: number;
  p99: number;
  /** Failures per second in the rate window, by why. Only reasons above 0. */
  failureRates: Partial<Record<FailureReason, number>>;
  /** Lifetime counts since the last reset. */
  totalRequests: number;
  totalCompleted: number;
  totalFailed: number;
  /** Lifetime failure counts by why. Only reasons that happened. */
  failuresByReason: Partial<Record<FailureReason, number>>;
  /**
   * Samples for the charts, oldest first, on the same 250ms clock as
   * `SimSnapshot.history`. This is the engine's live array: it is appended
   * to and trimmed in place, so a consumer that memoises has to key on its
   * length and newest `t`, as the charts do for the system history.
   */
  history: readonly RoutePoint[];
}

/** One chart sample for a route. */
export interface RoutePoint {
  t: number;
  goodput: number;
  /** 0..1, or NaN when nothing settled in the window, which is not 0%. */
  errorRate: number;
  /** ms, or NaN when nothing succeeded in the window, which is not 0ms. */
  p99: number;
}
