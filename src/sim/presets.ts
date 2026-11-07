import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from './types';
import type { Note, Section } from './annotations';

export interface Preset {
  id: string;
  name: string;
  /**
   * One short line for the palette row, under the name.
   *
   * Separate from `description` because the two are read in different
   * places at different moments: this is the six-word promise a student
   * scans down a list of twenty-three, while `description` is the full
   * paragraph they get once the preset is loaded and they want to know
   * what to watch. Deriving one from the other was tried and does not
   * work — the company presets all open with the same sourcing boilerplate,
   * so their first sentences are indistinguishable from each other.
   *
   * Required, so a new preset cannot silently ship without one. The map
   * this replaced was keyed by id and hand-maintained, and by the time it
   * was found seven of twenty-three presets had no note at all.
   */
  tagline: string;
  description: string;
  topology: Topology;
}

/**
 * Defaults for config fields that only some kinds read.
 *
 * Every `case` below returns a literal for the knobs that kind actually
 * exposes; these fill in the rest. Keeping them in one spread means adding a
 * field to NodeConfig does not force an edit to all the existing cases.
 */
const EXTRA_DEFAULTS = {
  // Every scalable kind starts as a single machine. Present explicitly rather
  // than left undefined so the Inspector has something to show and a student
  // can see that "1" is a choice, not an absence -- the engine treats the two
  // identically.
  instances: 1,
  // replica: a 3-node read replica set, 50ms behind, mostly-read traffic.
  replicaCount: 3,
  replicationLagMs: 50,
  readFraction: 0.9,
  // shard: 4 partitions, keys spread evenly (no hot key) until you make one.
  shardCount: 4,
  shardCapacity: 4,
  hotKeyFraction: 0,
} satisfies Partial<NodeConfig>;

/** Sensible starting knobs for a freshly dropped node of each kind. */
export function defaultConfig(kind: NodeKind): NodeConfig {
  return { ...EXTRA_DEFAULTS, ...baseConfig(kind) };
}

/** Per-kind knobs. Fields a kind does not care about come from EXTRA_DEFAULTS. */
function baseConfig(kind: NodeKind): Omit<NodeConfig, keyof typeof EXTRA_DEFAULTS> {
  switch (kind) {
    case 'client':
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 1000,
        retries: 0,
        rps: 50,
      };
    case 'lb':
      return {
        capacity: 256,
        serviceMs: 0.5,
        serviceCv: 0.2,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'service':
      return {
        capacity: 8,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'cache':
      return {
        capacity: 32,
        serviceMs: 3,
        serviceCv: 0.4,
        queueLimit: 256,
        hitRate: 0.8,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'db':
      // Reads share the 6 slots; writes (10% at the default readFraction
      // 0.9) also pay 15ms of lock wait per concurrent writer. At the
      // default mix that is a barely-visible tax; raise the write share and
      // watch lockWaitMs climb while adding instances fixes nothing.
      return {
        capacity: 6,
        serviceMs: 30,
        serviceCv: 0.7,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        lockMs: 15,
      };
    case 'queue':
      return {
        capacity: 1,
        serviceMs: 1,
        serviceCv: 0.2,
        queueLimit: 5000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'worker':
      return {
        capacity: 4,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'replica':
      // Reads fan across the replicas, so per-replica capacity is modest.
      return {
        capacity: 4,
        serviceMs: 20,
        serviceCv: 0.6,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'shard':
      // Per-shard slots live in shardCapacity; `capacity` is unused here.
      return {
        capacity: 4,
        serviceMs: 25,
        serviceCv: 0.6,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'cdn':
      // An edge PoP: very fast, very high hit rate, lots of concurrency.
      // At hitRate 0.92 the origin behind it sees 8% of the offered load.
      return {
        capacity: 256,
        serviceMs: 2,
        serviceCv: 0.3,
        queueLimit: 2048,
        hitRate: 0.92,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'ratelimiter':
      // A doorman: refusing costs nothing, so no service time and no slots.
      // 100 rps sustained with one second of burst headroom.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rateLimitRps: 100,
        burst: 100,
      };
    case 'breaker':
      // Trips once half the downstream calls in a 5s window fail, stays open
      // 3s, then lets 3 probes decide whether to close.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        errorThreshold: 0.5,
        windowMs: 5000,
        openMs: 3000,
        halfOpenProbes: 3,
      };
    case 'autoscaler':
      // Adds and removes INSTANCES to hold its target at 70% utilisation,
      // stepping by half the current fleet.
      //
      // THE TIMINGS, on a human scale. A student drags the load slider up and
      // this is what they should see, measured rather than guessed:
      //
      //   t+0.0s  load arrives; utilisation climbs and pins at 1.0
      //   t+~3s   cooldown expires, the controller decides and books machines
      //           (phase 'cooldown' -> 'warming', ghost instances appear)
      //   t+~7s   the machines boot and start serving (warmupMs=4000 later);
      //           utilisation falls back toward the setpoint
      //
      // So: something visibly happens within about three seconds, and the
      // whole arc completes in under ten. 4s of warmup is the balance point.
      // Shorter and the lag stops being legible -- capacity looks like it
      // answers instantly, which teaches the opposite of the truth. Much
      // longer (the previous default was 10s) and a student watching a live
      // graph concludes the component is broken before it ever acts.
      //
      // cooldownMs 3000 < warmupMs 4000 is deliberate and is the documented
      // oscillation regime: the controller can want a second step while the
      // first is still booting. It does not thrash, because a booked scale-up
      // blocks further decisions, but the fleet does hunt around the setpoint
      // rather than settling dead on it -- which is what real ones do.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        targetUtil: 0.7,
        // In INSTANCES, not slots: between 1 and 12 machines.
        minCapacity: 1,
        maxCapacity: 12,
        cooldownMs: 3000,
        scaleStepPct: 0.5,
        warmupMs: 4000,
      };
    case 'region':
      // Two regions, serving from the first. The 5s failover is long enough
      // to see as a real outage on the error graph and short enough that a
      // student does not think the simulation has hung.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        regions: 2,
        activeRegion: 0,
        failoverMs: 5000,
      };
    case 'objectstore':
      // Blob storage: every request pays a high flat latency, but the pool
      // is wide. 64 slots / 90ms -> ~710 rps of ceiling at ~90ms each,
      // which is "effectively unlimited" next to any database in this app.
      // The real limit is PER PREFIX: 150 rps on each of the 8 key
      // prefixes (~1200 rps spread evenly), and a hot prefix gets SlowDown
      // refusals while the rest of the store idles.
      return {
        capacity: 64,
        serviceMs: 90,
        serviceCv: 0.4,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        prefixRps: 150,
      };
    case 'searchindex':
      // Searches are cheap (8ms); a write pays +60ms of indexing on top and
      // becomes searchable only 1.5s after it commits. At the default 90/10
      // read mix the mean cost is ~14ms -> 12 slots gives ~850 rps.
      return {
        capacity: 12,
        serviceMs: 8,
        serviceCv: 0.5,
        queueLimit: 128,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        indexMs: 60,
        indexLagMs: 1500,
      };
    case 'timeseriesdb':
      // Appends cost 1.5ms; a range query pays +120ms. At 5% range queries
      // the mean is ~7.5ms -> 16 slots gives ~2100 rps of mixed traffic,
      // which is the "metrics firehose" headroom the kind exists to show.
      return {
        capacity: 16,
        serviceMs: 1.5,
        serviceCv: 0.4,
        queueLimit: 1024,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rangeQueryFraction: 0.05,
        rangeQueryMs: 120,
      };
    case 'graphdb':
      // Depth 2 (friends-of-friends) costs 3x the base 6ms -> 18ms mean,
      // 8 slots -> ~440 rps. Each extra hop of depth divides that by 3.
      return {
        capacity: 8,
        serviceMs: 6,
        serviceCv: 0.5,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        traversalDepth: 2,
      };
    case 'coldstorage':
      // Archival: SECONDS per restore JOB, a hard quota of 24 concurrent
      // jobs (24 / 2.8s is ~8.5 rps of ceiling), and NO queue: a restore
      // beyond the quota is refused on the spot, not queued. Fine for a
      // trickle of restores, hopeless for anything shaped like online
      // traffic. Callers need a long timeout. queueLimit is ignored.
      return {
        capacity: 24,
        serviceMs: 2800,
        serviceCv: 0.3,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'vectordb':
      // Mean query cost is serviceMs * log2(2 + indexSizeK) / (1 - recall):
      // 0.5ms * ~10 * 10 = ~50ms at one million vectors and 0.9 recall, so
      // 16 slots gives ~320 rps. Pushing recall to 0.99 costs 10x that.
      return {
        capacity: 16,
        serviceMs: 0.5,
        serviceCv: 0.4,
        queueLimit: 128,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        indexSizeK: 1000,
        recallTarget: 0.9,
      };
    case 'streambroker':
      // A partitioned log: 1ms producer ack, 4 partitions, and queueLimit is
      // RETENTION in messages. Per consumer group the parallelism ceiling is
      // the partition count, so throughput per group = 4 x (1000/consumerMs).
      return {
        capacity: 1,
        serviceMs: 1,
        serviceCv: 0.2,
        queueLimit: 2000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        partitions: 4,
      };
    case 'pubsub':
      // A topic: near-instant ack, then one delivery per subscriber edge.
      // No knobs of its own; the amplification comes from the wiring.
      return {
        capacity: 1,
        serviceMs: 0.5,
        serviceCv: 0.2,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
    case 'websocket':
      // Capacity is CONNECTIONS HELD: 400 per instance, held ~30s each, so
      // by Little's law it saturates at about 13 new connections/sec per
      // instance. The 5ms serviceMs is only the handshake.
      return {
        capacity: 400,
        serviceMs: 5,
        serviceCv: 0.4,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        connectionMs: 30000,
      };
    case 'apigateway':
      // The front door: 2ms of auth/routing work per request, a 300 rps
      // token bucket with one second of burst headroom, and 1% bad auth.
      return {
        capacity: 64,
        serviceMs: 2,
        serviceCv: 0.3,
        queueLimit: 256,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rateLimitRps: 300,
        burst: 300,
        authFailRate: 0.01,
      };
    case 'sidecar':
      // The proxy tax: 2ms on every request, in exchange for 2 retries, a
      // 500ms per-attempt deadline, and outlier ejection after 5 straight
      // downstream failures (3s ejection, matching the breaker's openMs).
      return {
        capacity: 32,
        serviceMs: 2,
        serviceCv: 0.2,
        queueLimit: 64,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 500,
        retries: 2,
        rps: 0,
        outlierAfter: 5,
        openMs: 3000,
      };
    case 'lambda':
      // Serverless: 25ms of work when warm, +350ms cold start, instances kept
      // warm 12s, at most 40 running at once (beyond that the platform
      // throttles; there is no queue). `capacity` is unused here.
      return {
        capacity: 1,
        serviceMs: 25,
        serviceCv: 0.5,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        coldStartMs: 350,
        keepWarmMs: 12000,
        maxConcurrency: 40,
      };
    case 'cron':
      // A batch job: every 20s it dumps 50 requests down each outgoing edge
      // at once. Not a request path; requests wired INTO it are refused.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        intervalMs: 20000,
        batchSize: 50,
      };
    case 'bulkhead':
      // A pool of 8 concurrent calls. Refusing is free, so no slots, no
      // queue, no service time: the pool count is the whole component.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        bulkheadMax: 8,
        bulkheadMode: 'reject',
        acquireQueueMax: 100,
        acquireTimeoutMs: 1000,
      };
    case 'retryqueue':
      // Delivery concurrency of 8 at ~3ms dispatch cost. Each failed
      // delivery gets 2 redeliveries with backoff before it dead-letters;
      // the 1s per-attempt deadline is what turns a hung consumer into a
      // retryable failure instead of a stuck message.
      return {
        capacity: 8,
        serviceMs: 3,
        serviceCv: 0.3,
        queueLimit: 2000,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 1000,
        retries: 2,
        rps: 0,
      };
    case 'transcoder':
      // Batch regime: 1.2 SECONDS per job, two jobs per box. One instance
      // is 2 * (1000/1200) = ~1.7 jobs/s; feed it from a queue and size the
      // farm against the arrival rate, because a structural deficit grows
      // the backlog forever. Each finished job hands 3 renditions (the
      // quality ladder) downstream as detached uploads, so storage sees 3x
      // the job rate.
      return {
        capacity: 2,
        serviceMs: 1200,
        serviceCv: 0.4,
        queueLimit: 8,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        renditions: 3,
      };
    case 'edgecompute':
      // A PoP function: ~1ms, lots of concurrency, and it can fully answer
      // 30% of requests without the origin ever hearing about them -- as
      // long as the execution fits the 2ms CPU budget; the tail that runs
      // past it is killed and passed to the origin anyway.
      return {
        capacity: 64,
        serviceMs: 1,
        serviceCv: 0.3,
        queueLimit: 512,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        edgeShare: 0.3,
        cpuMsCap: 2,
      };
    case 'writebehind':
      // `capacity` is the dirty buffer (memory, not threads): up to 256
      // acknowledged writes held at once. At the 200ms flush residence
      // that supports ~1280 writes/s before the buffer itself fills.
      // Every write in it is lost if this node crashes.
      return {
        capacity: 256,
        serviceMs: 1,
        serviceCv: 0.3,
        queueLimit: 512,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        flushDelayMs: 200,
      };
    case 'loadshedder':
      // Admits 300 rps sustained. 30% of the key space is best-effort
      // traffic, and 30% of the bucket is reserved for the rest, so under
      // saturation the best-effort tier is dropped first.
      return {
        capacity: 1,
        serviceMs: 0,
        serviceCv: 0,
        queueLimit: 0,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
        rateLimitRps: 300,
        burst: 300,
        lowPriorityShare: 0.3,
        priorityReserve: 0.3,
      };
    default:
      return {
        capacity: 1,
        serviceMs: 10,
        serviceCv: 0.5,
        queueLimit: 32,
        hitRate: 0,
        errorRate: 0,
        timeoutMs: 0,
        retries: 0,
        rps: 0,
      };
  }
}

const DEFAULT_LABEL: Record<NodeKind, string> = {
  client: 'Client',
  lb: 'Load Balancer',
  service: 'Service',
  cache: 'Cache',
  db: 'Database',
  queue: 'Queue',
  worker: 'Worker',
  replica: 'Read Replicas',
  shard: 'Sharded Store',
  cdn: 'CDN',
  ratelimiter: 'Rate Limiter',
  breaker: 'Circuit Breaker',
  autoscaler: 'Autoscaler',
  region: 'Region',
  objectstore: 'Object Storage',
  searchindex: 'Search Index',
  timeseriesdb: 'Time-Series DB',
  graphdb: 'Graph Database',
  coldstorage: 'Cold Storage',
  vectordb: 'Vector Database',
  streambroker: 'Stream Broker',
  pubsub: 'Pub/Sub Topic',
  websocket: 'WebSocket Gateway',
  apigateway: 'API Gateway',
  sidecar: 'Sidecar Proxy',
  lambda: 'Lambda',
  cron: 'Cron Job',
  bulkhead: 'Bulkhead',
  retryqueue: 'Retry Queue',
  transcoder: 'Transcoder',
  edgecompute: 'Edge Compute',
  writebehind: 'Write-Behind Cache',
  loadshedder: 'Load Shedder',
};

let nodeCounter = 0;

/**
 * Mint a node for the canvas.
 *
 * `taken` is the set of ids already on the canvas. It has to be consulted:
 * the counter above restarts at zero on every page load, while the ids it
 * minted in earlier sessions come back through localStorage, share links
 * and design files. Without the check the eleventh service added after a
 * reload is `service-1` again, and two nodes then share one id: selecting
 * either selects both, the inspector reads "2 components", edges drawn to
 * one land on both, and a config change applies to both. The paste path
 * already dedupes this way (clipboard.ts freshId); the add path did not.
 */
export function makeNode(
  kind: NodeKind,
  x: number,
  y: number,
  label?: string,
  taken?: ReadonlySet<string>,
): SimNode {
  let id: string;
  do {
    nodeCounter += 1;
    id = `${kind}-${nodeCounter}`;
  } while (taken !== undefined && taken.has(id));
  return {
    id,
    kind,
    label: label ?? DEFAULT_LABEL[kind],
    x,
    y,
    config: defaultConfig(kind),
  };
}

/* ------------------------------------------------------------------ *
 * Preset construction helpers
 * ------------------------------------------------------------------ */

function node(
  id: string,
  kind: NodeKind,
  label: string,
  x: number,
  y: number,
  overrides: Partial<NodeConfig> = {},
): SimNode {
  return {
    id,
    kind,
    label,
    x,
    y,
    config: { ...defaultConfig(kind), ...overrides },
  };
}

function edge(from: string, to: string, weight = 1): SimEdge {
  return { id: `${from}->${to}`, from, to, weight };
}

/**
 * A CONTROL edge: "`from` acts on `to`". Carries no requests -- the engine
 * leaves control edges out of every routing set -- and exists so a
 * supervisory relationship is stated in the topology rather than inferred
 * from a wire that looks exactly like a traffic path.
 */
function control(from: string, to: string): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1, control: true };
}

/* ------------------------------------------------------------------ *
 * 1. Single Server
 *    service: 64 slots / 25ms -> 2560 rps of its own work. Each slot is
 *             also held while its database call is out, so the pool is
 *             sized to outlast the database's 6 slots and 48 in line.
 *    db:      6 slots / 30ms  -> 200 rps  <- first bottleneck
 *    default 50 rps, knee around 4x.
 * ------------------------------------------------------------------ */

const singleServer: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 50, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 340, 200, {
      capacity: 64,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('db', 'db', 'Database', 660, 200, {
      capacity: 6,
      serviceMs: 30,
      serviceCv: 0.7,
      queueLimit: 48,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db')],
  annotations: [
    note(
      'ss-note-db',
      40,
      320,
      'One server, one database. The database is the smaller of the two: 6 requests at a time at 30ms each, so it runs out near 200 a second. Drag the load past 4x and the wait builds there first, not at the API.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 2. Load Balanced
 *    3 services: 3 x (44 slots / 25ms) = 5280 rps of their own work, with
 *                room for each one's share of the database's slots and
 *                line while they wait on it
 *    shared db:  12 slots / 25ms       = 480 rps <- bottleneck anyway
 *    default 140 rps, db bites around 3.4x.
 * ------------------------------------------------------------------ */

const loadBalanced: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 220, { rps: 140, timeoutMs: 2000 }),
    node('lb', 'lb', 'Load Balancer', 260, 220, { capacity: 512, serviceMs: 0.5 }),
    node('api1', 'service', 'API 1', 500, 80, {
      capacity: 44,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('api2', 'service', 'API 2', 500, 220, {
      capacity: 44,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('api3', 'service', 'API 3', 500, 360, {
      capacity: 44,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('db', 'db', 'Database', 800, 220, {
      capacity: 12,
      serviceMs: 25,
      serviceCv: 0.7,
      queueLimit: 96,
    }),
  ],
  edges: [
    edge('client', 'lb'),
    edge('lb', 'api1'),
    edge('lb', 'api2'),
    edge('lb', 'api3'),
    edge('api1', 'db'),
    edge('api2', 'db'),
    edge('api3', 'db'),
  ],
  annotations: [
    note(
      'lb-note-db',
      40,
      480,
      'Three servers share one database. That triples the API capacity and does nothing for the database, which still tops out near 480 a second. Adding servers only helps when the servers were the problem.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 3. Cache Aside
 *    cache: 64 slots / 2ms -> effectively unlimited
 *    db:    4 slots / 30ms -> 133 rps, but only (1 - hitRate) reaches it.
 *    At hitRate 0.85 and 200 rps offered the db sees ~30 rps.
 *    Drop hitRate to ~0.3 and the db is instantly over its 133 rps ceiling.
 * ------------------------------------------------------------------ */

const cacheAside: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 200, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 280, 200, {
      capacity: 64,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('cache', 'cache', 'Cache', 550, 200, {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.85,
      queueLimit: 512,
    }),
    node('db', 'db', 'Database', 820, 200, {
      capacity: 4,
      serviceMs: 30,
      serviceCv: 0.7,
      queueLimit: 32,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'cache'), edge('cache', 'db')],
  annotations: [
    note(
      'ca-note-miss',
      40,
      320,
      'The database only ever sees the misses. At an 85 percent hit rate it takes about 30 requests a second out of 200. Drag the hit rate down to 0.3 and it is instantly over its 133 a second ceiling, with no change in load at all.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 4. Async Workers
 *    api:     24 slots / 8ms  -> 3000 rps (never the bottleneck)
 *    queue:   ack ~1ms, 5000 deep
 *    workers: 10 slots, each held for 30ms of work and a ~20ms database
 *             call -> 200 rps drain rate <- the real ceiling
 *    default 120 rps drains fine; push past 200 and the backlog grows
 *    without the client ever seeing an error, until the buffer fills.
 * ------------------------------------------------------------------ */

const asyncWorkers: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 120, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', 260, 200, {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('queue', 'queue', 'Message Queue', 500, 200, {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('worker', 'worker', 'Workers', 730, 200, {
      capacity: 10,
      serviceMs: 30,
      serviceCv: 0.6,
    }),
    node('db', 'db', 'Database', 860, 380, {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.7,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('client', 'api'),
    edge('api', 'queue'),
    edge('queue', 'worker'),
    edge('worker', 'db'),
  ],
  annotations: [
    note(
      'aw-note-queue',
      40,
      520,
      'The workers drain 200 a second. Push the load past that and the client still gets an instant yes, because the queue is absorbing the difference. Nothing looks wrong until the queue fills, so the graph to watch is the queue depth, not the error rate.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 5. Retry Storm
 *    db: 4 slots / 40ms -> 100 rps ceiling.
 *    The api timeout (250ms) sits comfortably above the db's uncongested
 *    tail latency (~110ms at low load), so retries fire only once real
 *    queueing develops -- not from service-time variance alone. Below the
 *    ceiling each request needs one attempt and load passes through 1:1.
 *    Once queueing pushes past 250ms, every request starts issuing all 3
 *    attempts, tripling the offered load onto a db already at its limit,
 *    and the system collapses. Stable to 80 rps (1.8x); collapse begins at
 *    85 (1.9x) and is total by 90 (2x).
 *
 *    Measured, not estimated, and the onset is genuinely stochastic: at 85
 *    rps four seeds give 39.6%, 59.1%, 93.0% and 95.0% failures, because
 *    whether the queue tips depends on the timing of the first slow batch.
 *    An earlier note here claimed collapse at 2.4x, which is well past the
 *    interesting part: by then it is uniformly dead.
 * ------------------------------------------------------------------ */

const retryStorm: Topology = {
  nodes: [
    node('client', 'client', 'Client', 40, 200, { rps: 45, timeoutMs: 3000 }),
    node('api', 'service', 'API Server', 340, 200, {
      capacity: 64,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
      timeoutMs: 250,
      retries: 2,
    }),
    node('db', 'db', 'Database', 680, 200, {
      capacity: 4,
      serviceMs: 40,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db')],
  annotations: [
    note(
      'rt-note-storm',
      40,
      320,
      'The database handles 100 a second. Once waiting passes the 250ms timeout on the API, every request starts retrying three times, so the load triples onto a database that was already full. It is steady at 80 a second. Push to 85 and it starts losing most of its traffic; by 90 almost none gets through.',
      340,
    ),
  ],
};

/* ================================================================== *
 * Grid geometry for the presets below.
 *
 * Canvas draws a node as NODE_W=184 x NODE_H=88 anchored at (x, y). A column
 * pitch of 260 leaves 76px of horizontal gutter for the edge to be visible,
 * and a row pitch of 130 leaves 42px vertically. Every preset places nodes on
 * COL(i) / ROW(j) so no two boxes can overlap by construction, and the
 * verifier asserts it rather than trusting the arithmetic.
 * ================================================================== */

const COL0 = 40;
const COL_PITCH = 260;
const ROW0 = 60;
const ROW_PITCH = 130;

/** x of grid column i (0-based), left-to-right. */
const COL = (i: number) => COL0 + i * COL_PITCH;
/** y of grid row j (0-based), top-to-bottom. */
const ROW = (j: number) => ROW0 + j * ROW_PITCH;

/* ================================================================== *
 * Annotation helpers for the presets below.
 *
 * These build the Section and Note literals directly rather than calling
 * makeSection/makeNote from annotations.ts, because those mint ids from a
 * mutating module counter. A preset's annotation ids would then depend on
 * module evaluation order, which is exactly the kind of thing that is stable
 * in a test run and different in a share link. Ids here are written down.
 *
 * The frame helpers take grid cells rather than pixels so a section is
 * described the way the layout is: "columns 0 to 3, rows 0 to 1". Sections
 * are padded evenly; the room that padding needs is bought at the lane
 * boundary by LANE_GAP rather than by squeezing the frames.
 * presets.annotations.test.ts asserts none of them collide.
 * ================================================================== */

const SEC_PAD_X = 28;
const SEC_PAD_T = 16;
const SEC_PAD_B = 16;

/**
 * Extra vertical space inserted at a lane boundary, on top of ROW_PITCH.
 *
 * Two stacked sections need NODE_H + pad + label plate + pad = 148px between
 * their row tops, and ROW_PITCH is 130. Without this the frames either touch
 * or the lower one's label plate lands inside the upper frame. Rather than
 * shaving the padding down until it fits (which is what made the first pass
 * look cramped), the layout gives the boundary the room it actually needs.
 */
const LANE_GAP = 64;

/** y of grid row j, pushed down by `lane` lane boundaries above it. */
const LROW = (j: number, lane = 0) => ROW(j) + lane * LANE_GAP;

/**
 * A section framing grid cells c0..c1 by r0..r1 inclusive.
 *
 * `tight` drops the bottom padding to zero, freeing the row gutter for the
 * label plate of whatever section sits underneath.
 */
function sectionOver(
  id: string,
  label: string,
  tone: number,
  c0: number,
  c1: number,
  r0: number,
  r1: number,
  lane = 0,
): Section {
  const x = COL(c0) - SEC_PAD_X;
  const y = LROW(r0, lane) - SEC_PAD_T;
  return {
    id,
    kind: 'section',
    label,
    x,
    y,
    width: COL(c1) + NODE_W + SEC_PAD_X - x,
    height: LROW(r1, lane) + NODE_H + SEC_PAD_B - y,
    tone,
  };
}

/**
 * A note at an explicit world point.
 *
 * Presets set `font: 'hand'` on their commentary so it reads as something
 * written in the margin rather than as another label belonging to the
 * diagram. Colour is left unset: a note with no colour follows the theme,
 * which is what keeps the examples legible when the palette changes.
 */
function note(
  id: string,
  x: number,
  y: number,
  text: string,
  width = 220,
  size: Note['size'] = 'md',
  font: Note['font'] = 'hand',
): Note {
  return { id, kind: 'note', text, x, y, width, size, font };
}

/** Node box, mirrored from Canvas so the frame helpers can do arithmetic. */
const NODE_W = 184;
const NODE_H = 88;

/* ------------------------------------------------------------------ *
 * 6. CDN + Origin
 *    cdn:    256 slots / 2ms  -> effectively unbounded
 *    origin:   4 slots, each held for 23ms of its own work plus ~10ms
 *              waiting on the database -> ~120 rps ceiling
 *    At hitRate 0.90 and 400 rps offered the origin sees ~40 rps: a third of
 *    its ceiling. At 4x it sees ~160 rps and is over the ceiling, which is
 *    the same collapse a student can trigger at 1x just by dragging the hit
 *    rate down -- the point being that the origin was never sized for the
 *    traffic the CDN was absorbing.
 * ------------------------------------------------------------------ */

const cdnOrigin: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 400, timeoutMs: 2000 }),
    node('cdn', 'cdn', 'CDN Edge', COL(1), ROW(1), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 2048,
    }),
    node('origin', 'service', 'Origin Server', COL(2), ROW(1), {
      capacity: 4,
      serviceMs: 23,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('db', 'db', 'Database', COL(3), ROW(1), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
  ],
  edges: [edge('client', 'cdn'), edge('cdn', 'origin'), edge('origin', 'db')],
  annotations: [
    note(
      'co-note-miss',
      40,
      320,
      'The origin only ever sees what the cache misses. It handles 120 a second, and the cache is currently hiding 90 percent of the traffic from it. Drag the hit rate down and the origin gets a load nobody ever sized it for.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 7. Rate Limited API
 *    limiter: 200 rps sustained, 200-token burst
 *    api:       9 slots, each held ~37ms (25ms of its own work plus the
 *               database call) -> ~240 rps ceiling
 *    The limiter is set just under what the api can actually serve, so at 1x
 *    (150 rps) every request is admitted and nothing is refused: the limiter
 *    is invisible until it is needed.
 *
 *    What it buys is NOT extra goodput -- measured at 600 rps offered, the
 *    limiter serves 200 rps where removing it serves 234. It buys LATENCY for
 *    the requests that do get through:
 *
 *      600 rps    goodput   p50     p99    api queue
 *      limiter     200.0    36ms    80ms      0
 *      no limiter  234.4   235ms   292ms     46
 *
 *    Without the limiter every caller waits behind a 46-deep queue for an
 *    answer that mostly arrives too late to be useful. With it, the system
 *    says no quickly to some so it can say yes quickly to the rest. That
 *    trade -- a lower ceiling in exchange for a flat, predictable latency --
 *    is the whole argument for admission control, and it is why the honest
 *    comparison is p50, not throughput.
 * ------------------------------------------------------------------ */

const rateLimitedApi: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 150, timeoutMs: 2000 }),
    node('limiter', 'ratelimiter', 'Rate Limiter', COL(1), ROW(1), {
      rateLimitRps: 200,
      burst: 200,
    }),
    node('api', 'service', 'API Server', COL(2), ROW(1), {
      capacity: 9,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    node('db', 'db', 'Database', COL(3), ROW(1), {
      capacity: 12,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
  ],
  edges: [edge('client', 'limiter'), edge('limiter', 'api'), edge('api', 'db')],
  annotations: [
    note(
      'rl-note-trade',
      40,
      320,
      'The limiter does not add capacity. It refuses some requests quickly so the rest are answered quickly: at 600 offered it serves 200 at 36ms, where removing it serves 234 at 235ms. Saying no fast is what buys the predictable wait.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 8. Circuit Breaker
 *    payments: 4 slots / 30ms -> 133 rps ceiling, and it is the dependency
 *    that goes bad. The breaker trips once half the calls in a 4s window
 *    fail, stays open 3s, then probes.
 *    At 1x (100 rps) the dependency is inside its ceiling and the circuit
 *    stays closed all run. At 4x it is 3x oversubscribed, its queue fills,
 *    the shed rate crosses the error threshold and the breaker trips -- after
 *    which requests fail in microseconds instead of waiting out a timeout.
 *    Injecting a `crash` or raising errorRate on payments trips it on demand.
 * ------------------------------------------------------------------ */

const circuitBreaker: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 100, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 48,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
      timeoutMs: 600,
    }),
    node('breaker', 'breaker', 'Circuit Breaker', COL(2), ROW(1), {
      errorThreshold: 0.5,
      windowMs: 4000,
      openMs: 3000,
      halfOpenProbes: 3,
    }),
    node('payments', 'service', 'Payments API', COL(3), ROW(1), {
      capacity: 4,
      serviceMs: 30,
      serviceCv: 0.6,
      queueLimit: 32,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'breaker'), edge('breaker', 'payments')],
  annotations: [
    note(
      'cb-note-trip',
      40,
      320,
      'Select the payments API and press Crash in the inspector. Once half the calls in a four second window fail, the breaker opens and the rest fail in microseconds instead of waiting out a timeout. After three seconds it closes and probes again.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 9. Read Replicas
 *    api:     192 slots / 5ms. Each slot is also held while its read or
 *             write waits on the replica set, so the pool is sized to
 *             outlast the set's slots and its 128 in line.
 *    replicas: 3 x 4 slots / 20ms -> 600 rps of READ capacity
 *    primary:      4 slots / 20ms -> 200 rps of WRITE capacity
 *    At 85% reads and 300 rps offered that is 255 reads against 600 and 45
 *    writes against 200: comfortable. At 4x the reads blow past 600 while the
 *    writes are still inside their own ceiling, so adding replicas is the fix
 *    for one and does nothing at all for the other.
 *    The 60ms replication lag is what makes stale reads visible without
 *    needing an unrealistic write rate.
 * ------------------------------------------------------------------ */

const readReplicas: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 300, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 192,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('replicas', 'replica', 'Replica Set', COL(2), ROW(1), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 128,
      replicaCount: 3,
      replicationLagMs: 60,
      readFraction: 0.85,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'replicas')],
  annotations: [
    note(
      'rr-note-writes',
      40,
      320,
      'Copies give you read capacity and nothing else: 600 reads a second across three of them, but still only 200 writes against the one primary. Adding copies fixes one of those and does nothing at all for the other.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 10. Sharded Database
 *     4 shards x 4 slots / 25ms -> 160 rps PER SHARD, 640 rps total.
 *     At 400 rps spread evenly by key each shard carries ~100 of its 160 and
 *     the store is fine. The whole lesson is in hotKeyFraction: push it to
 *     0.8 and shard 0 alone is offered 320 rps against its own 160, so it
 *     pins at 100% and sheds while the node-level utilisation meter -- the
 *     mean across shards -- still reads comfortable.
 * ------------------------------------------------------------------ */

const shardedDatabase: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 400, timeoutMs: 2000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      capacity: 192,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('shards', 'shard', 'Sharded Store', COL(2), ROW(1), {
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 4,
      hotKeyFraction: 0,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'shards')],
  annotations: [
    note(
      'sd-note-hot',
      40,
      320,
      'Four shards carry 160 a second each. Push the hot key share to 0.8 and one shard alone is offered 320 against its own 160, so it pins and sheds while the utilisation meter, an average across all four, still looks comfortable.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 11. Autoscaling Service
 *     api: 3 INSTANCES x 3 slots each = 9 slots, each held for 23ms of its
 *     own work plus ~2.5ms on the database call -> ~350 rps, against 250 rps
 *     offered. The controller scales on work-only utilisation, which at 1x
 *     is 250 x 23ms / 9 = 64%: inside the band just under its 70% setpoint
 *     where it holds still, so the system is stable and the student sees a
 *     controller at rest.
 *
 *     RETUNED for the instance model. It used to be one node with `capacity:
 *     9` and the controller moved that 9 up and down -- arithmetically the
 *     same system, but the thing being added was a thread, which is invisible
 *     and is not what "autoscaling" means to anyone. The fleet is now three
 *     machines of three slots: same 9 slots, same ceiling, same reading at 1x,
 *     but now the number the controller moves is a number of MACHINES and the
 *     canvas can draw them appearing.
 *
 *     The lesson is what happens when you MOVE the load. Raise the client's
 *     rps and capacity does not follow immediately: the controller waits out
 *     its 3s cooldown, decides, and then the new machines take a further 4s
 *     to boot. Requests fail in that gap, and the gap is the whole point --
 *     an autoscaler is a lagging controller, not a shield. Scale-DOWN is
 *     instant, as it is in reality, which is why the recovery looks nothing
 *     like the climb.
 *
 *     maxCapacity 5 instances -> 15 slots held ~25.5ms each -> ~590 rps
 *     ceiling, so 4x (1000 rps) outruns the autoscaler no matter how patient
 *     it is: past some point the answer is not more of the same box. (Under
 *     the old slot-based reading this bound was `maxCapacity: 16` slots, a
 *     640 rps ceiling; it is the ceiling that carried over, not the integer.)
 * ------------------------------------------------------------------ */

const autoscalingService: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 250, timeoutMs: 3000 }),
    node('api', 'service', 'API Server', COL(1), ROW(1), {
      // Three slots on one machine; three machines running right now.
      capacity: 3,
      instances: 3,
      serviceMs: 23,
      serviceCv: 0.5,
      queueLimit: 256,
    }),
    node('db', 'db', 'Database', COL(2), ROW(1), {
      capacity: 24,
      serviceMs: 2,
      serviceCv: 0.6,
      queueLimit: 128,
    }),
    // The controller sits below the node it scales, joined to it by a CONTROL
    // edge. That edge names its target and carries no requests -- the engine
    // keeps control edges out of routing entirely, so this is a supervisory
    // relationship the topology states outright rather than something a
    // student has to infer from a wire that looks like every other wire.
    node('scaler', 'autoscaler', 'Autoscaler', COL(1), ROW(2), {
      targetUtil: 0.7,
      // In INSTANCES: never fewer than 2 machines, never more than 5.
      minCapacity: 2,
      maxCapacity: 5,
      cooldownMs: 3000,
      scaleStepPct: 0.5,
      warmupMs: 4000,
    }),
  ],
  edges: [edge('client', 'api'), edge('api', 'db'), control('scaler', 'api')],
  annotations: [
    note(
      'as-note-lag',
      40,
      456,
      'Raise the load and capacity does not follow. The controller waits out three seconds of cooldown, decides, and the new machines take four more to boot. Requests fail in that gap, and the gap is the point: an autoscaler lags, it does not shield.',
      340,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 12. Multi-Region Failover
 *     Two regions, each 15 slots, every slot held for 25ms of work plus
 *     ~12ms on the database call -> ~400 rps. Only ONE serves traffic at a
 *     time, so the pair buys availability and not one request per second of
 *     extra capacity -- which is why 4x (1000 rps) melts the active region
 *     while the standby sits at zero.
 *     Crash `us-api` (or cut the edge to it) and traffic lands on `eu-api`
 *     after the 5s failover window, during which every request fails as
 *     'region-down'. Set failoverMs to 0 to see the cutover no real system
 *     gets, or to 30000 to feel what a slow one costs.
 * ------------------------------------------------------------------ */

const multiRegion: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 250, timeoutMs: 2000 }),
    node('router', 'region', 'Region Router', COL(1), ROW(1), {
      regions: 2,
      activeRegion: 0,
      failoverMs: 5000,
    }),
    node('us-api', 'service', 'US API', COL(2), ROW(0), {
      capacity: 15,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('eu-api', 'service', 'EU API', COL(2), ROW(2), {
      capacity: 15,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('us-db', 'db', 'US Database', COL(3), ROW(0), {
      capacity: 16,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
    node('eu-db', 'db', 'EU Database', COL(3), ROW(2), {
      capacity: 16,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
  ],
  // Edge ORDER is region index: the first edge out of the router is region 0.
  edges: [
    edge('client', 'router'),
    edge('router', 'us-api'),
    edge('router', 'eu-api'),
    edge('us-api', 'us-db'),
    edge('eu-api', 'eu-db'),
  ],
  annotations: [
    sectionOver('mr-sec-us', 'United States, taking traffic', 0, 2, 3, 0, 0),
    sectionOver('mr-sec-eu', 'Europe, idle until it is needed', 3, 2, 3, 2, 2),
    note(
      'mr-note-fail',
      1064,
      40,
      'Crash the US API. For five seconds every request fails while the router notices, then Europe picks it all up. Only one region takes traffic at a time, so this pair buys you survival, not extra capacity: at 4x the active region melts while the standby sits at zero.',
      300,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 13. Full Stack
 *     The showcase. Every tier in one picture, each sized so that the thing
 *     that breaks first is the thing a real system breaks first.
 *
 *     600 rps offered, and here is where it goes:
 *       cdn     hitRate 0.70   -> 30% miss, so ~180 rps reach the LB
 *       lb      -> 2 api, ~90 rps each
 *       api     2 x 24 slots, each held for 8ms plus the cache and shard
 *               call -> still never the bottleneck at 4x
 *       cache   hitRate 0.60   -> 40% miss, so ~72 rps reach the shards
 *       shards  4 x 2 slots / 25ms  -> 320 rps total, 80 rps per shard
 *       queue   -> workers 6 / 25ms -> 240 rps of async drain
 *
 *     Both paths are sized to have real headroom at 1x and to run out of it
 *     by 4x, but they run out DIFFERENTLY, and that contrast is the lesson:
 *
 *       - the synchronous path (cache -> shards) fails LOUDLY. The shards
 *         saturate, sheds start, and the client sees errors and a fat tail.
 *       - the asynchronous path (queue -> workers) fails QUIETLY. The workers
 *         saturate too, but the queue absorbs the excess, so the client is
 *         still acknowledged instantly while an invisible backlog grows.
 *
 *     A student who watches only the error rate sees half the failure. The
 *     queue depth is the other half, and it is the half that takes hours to
 *     drain after the spike is over.
 * ------------------------------------------------------------------ */

const fullStack: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 600, timeoutMs: 3000 }),
    node('cdn', 'cdn', 'CDN Edge', COL(1), ROW(1), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.7,
      queueLimit: 2048,
    }),
    node('lb', 'lb', 'Load Balancer', COL(2), ROW(1), {
      capacity: 512,
      serviceMs: 0.5,
    }),
    node('api1', 'service', 'API 1', COL(3), ROW(0), {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('api2', 'service', 'API 2', COL(3), ROW(2), {
      capacity: 24,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('cache', 'cache', 'Cache', COL(4), ROW(0), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.6,
      queueLimit: 512,
    }),
    node('shards', 'shard', 'Sharded Store', COL(5), ROW(0), {
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('queue', 'queue', 'Job Queue', COL(4), ROW(2), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('workers', 'worker', 'Workers', COL(5), ROW(2), {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
    }),
  ],
  edges: [
    edge('client', 'cdn'),
    edge('cdn', 'lb'),
    edge('lb', 'api1'),
    edge('lb', 'api2'),
    // Each api reads through the cache AND books async work. Both edges are
    // taken for every request: a 'service' fans out to all its downstreams.
    edge('api1', 'cache'),
    edge('api1', 'queue'),
    edge('api2', 'cache'),
    edge('api2', 'queue'),
    edge('cache', 'shards'),
    edge('queue', 'workers'),
  ],
  annotations: [
    // Only the two ends are framed. The point of this example is the
    // contrast between them, and boxing the middle would bury it.
    sectionOver('fs-sec-sync', 'Answered while you wait', 0, 4, 5, 0, 0),
    sectionOver('fs-sec-async', 'Answered later', 3, 4, 5, 2, 2),
    note(
      'fs-note-cdn',
      1584,
      40,
      'Two thirds of the traffic never gets past the edge cache. Only the misses reach anything below, which is why everything behind it looks so lightly loaded at rest.',
      236,
    ),
    // The lesson. Both halves run out of room at 4x; only one of them
    // tells you about it.
    note(
      'fs-note-lesson',
      16,
      336,
      'Take the load to 4x and watch both halves. The sharded store saturates and the client sees errors straight away. The workers saturate too, but the queue swallows the excess, so the client is still told everything is fine while a backlog builds that takes hours to drain.',
      300,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 14. Specialised Stores
 *     Every request finds the store built for it, and the arithmetic of
 *     WHY each store exists is visible in the meters.
 *
 *     240 rps offered, split three ways by the LB (~80 rps per API):
 *       search-api -> searchindex   80 rps at a 90/10 search/write mix.
 *                     Mean cost ~14ms against 12 slots -> ~850 rps ceiling.
 *                     Writes pay +60ms of indexing and are searchable only
 *                     1.5s after commit; the stale-search rate IS that lag.
 *       recs-api   -> vectordb + graphdb. The vector index costs ~50ms per
 *                     query at 1M vectors and 0.9 recall (16 slots ->
 *                     320 rps ceiling: the knee of this preset), the graph
 *                     runs friend-of-friend at depth 2 (~18ms -> 440 rps).
 *       media-api  -> objectstore. 90ms flat, 64 slots -> ~710 rps: high
 *                     latency, near-unlimited throughput. Not a database.
 *       every api  -> timeseriesdb. All 240 rps of metrics appends land
 *                     there and use ~11% of it; range queries are the only
 *                     thing that can hurt it, and that is a slider.
 *
 *     A separate 6 rps batch client archives through a queue into cold
 *     storage (24 slots / 2.8s -> ~8.5 rps ceiling, ~70% busy at 1x).
 *
 *     At 4x the two paths fail in character: the vector index saturates
 *     LOUDLY (sheds, client errors) while the archive pipeline fails
 *     QUIETLY -- the batch client is still acknowledged instantly while
 *     cold storage sheds the restores behind the queue.
 * ------------------------------------------------------------------ */

const specialisedStores: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 240, timeoutMs: 3000 }),
    node('batch', 'client', 'Batch Jobs', COL(0), LROW(3, 1), {
      rps: 6,
      timeoutMs: 2000,
    }),
    node('lb', 'lb', 'Load Balancer', COL(1), ROW(1), {
      capacity: 512,
      serviceMs: 0.5,
    }),
    node('archive-q', 'queue', 'Archive Queue', COL(1), LROW(3, 1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('search-api', 'service', 'Search API', COL(2), ROW(0), {
      capacity: 16,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('recs-api', 'service', 'Recs API', COL(2), ROW(1), {
      capacity: 160,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('media-api', 'service', 'Media API', COL(2), ROW(2), {
      capacity: 48,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('archiver', 'worker', 'Archiver', COL(2), LROW(3, 1), {
      capacity: 32,
      serviceMs: 40,
      serviceCv: 0.4,
    }),
    node('search', 'searchindex', 'Search Index', COL(3), ROW(0)),
    // 12 slots at ~50ms per query is a 240 rps ceiling: a third used at 1x,
    // and the first thing to saturate at 4x, which makes the vector index
    // the knee of the whole preset.
    node('vectors', 'vectordb', 'Vector Index', COL(3), ROW(1), { capacity: 12 }),
    node('blobs', 'objectstore', 'Object Storage', COL(3), ROW(2)),
    node('glacier', 'coldstorage', 'Cold Storage', COL(3), LROW(3, 1)),
    node('social', 'graphdb', 'Social Graph', COL(4), ROW(0)),
    node('metrics', 'timeseriesdb', 'Metrics Store', COL(4), ROW(2)),
  ],
  edges: [
    edge('client', 'lb'),
    // Unequal on purpose: equal weights make the LB route least-loaded, and
    // it would steer recs traffic onto the other APIs once the vectors slow.
    edge('lb', 'search-api', 33),
    edge('lb', 'recs-api', 34),
    edge('lb', 'media-api', 33),
    // Each API talks to its own store AND emits a metric append; a service
    // fans out to all its downstreams, so the metrics edge is taken for
    // every request, which is exactly what instrumentation does.
    edge('search-api', 'search'),
    edge('search-api', 'metrics'),
    edge('recs-api', 'vectors'),
    edge('recs-api', 'social'),
    edge('recs-api', 'metrics'),
    edge('media-api', 'blobs'),
    edge('media-api', 'metrics'),
    // The archive path: acknowledged at the queue, drained at the
    // archiver's pace, paid for in seconds at the cold tier.
    edge('batch', 'archive-q'),
    edge('archive-q', 'archiver'),
    edge('archiver', 'glacier'),
  ],
  annotations: [
    sectionOver('ss-sec-stores', 'A different store for each question', 0, 2, 4, 0, 2),
    sectionOver('ss-sec-arch', 'Moving old data somewhere cheaper', 2, 0, 3, 3, 3, 1),
    note(
      'ss-note-stores',
      1320,
      40,
      'One general purpose database would do all of this badly. A text index, a vector index and a graph each answer a question the others are slow at, and the price is four stores to run instead of one.',
      300,
    ),
    // The lesson: the same overload, told two different ways depending on
    // whether the caller is still waiting for an answer.
    note(
      'ss-note-lesson',
      1320,
      296,
      'Take the load to 4x. The vector index saturates and the client sees the errors immediately. The archive path saturates too and says nothing: the batch client is still acked while cold storage sheds behind the queue.',
      300,
    ),
    note(
      'ss-note-cold',
      16,
      296,
      'Cold storage is slow on purpose, seconds per restore, because almost nothing is ever read back. Paying for fast storage you never read is the mistake this avoids.',
      236,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 15. Event-Driven Backend
 *
 * The messaging tier in one picture, with the arithmetic worked out:
 *
 *   client 60 rps -> apigateway (300 rps bucket, 1% bad auth, 2ms)
 *     routes 3:1 -> api service (16 slots / 10ms = 1600 rps ceiling) ~44 rps
 *                -> lambda (25ms warm, +350ms cold, 40 concurrent)   ~15 rps
 *   api fans out to:
 *     stream broker (4 partitions, retention 2000):
 *       group A -> indexer  (4 slots / 55ms -> ~72/s; 4 partitions x
 *                  1000/55 = ~72/s -- keeps up at 1x, lags visibly at 2x+)
 *       group B -> billing  (4 slots / 12ms -> ~330/s; never behind)
 *     pub/sub topic -> push, audit, metrics (1 publish = 3 deliveries;
 *       audit is deliberately slow (2 slots / 40ms = 50/s) so at ~44 rps it
 *       runs hot without touching the other subscribers)
 *   chat client 30 conn/s -> websocket gateway (400 connection slots,
 *       8s sessions -> ~240 held, 60% full at 1x; 4x offers 120 conn/s =
 *       960 wanted and the gateway refuses everything past 400)
 *       -> sidecar (2ms tax, 2 retries, eject after 5) -> chat service
 *   cron: every 15s, 40 requests at once -> lambda -> shared db. The warm
 *       pool (~1-2 instances) cannot cover a burst of 40, so nearly every
 *       burst invocation pays the cold start, and the db (8 slots / 20ms =
 *       400/s) absorbs a spike that shows up in interactive latency.
 * ------------------------------------------------------------------ */

const eventDriven: Topology = {
  nodes: [
    node('client', 'client', 'API Clients', 40, 140, { rps: 60, timeoutMs: 2500 }),
    node('gw', 'apigateway', 'API Gateway', 250, 140, {
      capacity: 64,
      serviceMs: 2,
      // 60 rps of interactive traffic fits comfortably; at 4x the door is
      // exactly what refuses the excess, which is its job and its lesson.
      rateLimitRps: 150,
      burst: 150,
      authFailRate: 0.01,
    }),
    node('api', 'service', 'API Service', 470, 140, {
      capacity: 16,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('broker', 'streambroker', 'Event Stream', 700, 60, {
      serviceMs: 1,
      partitions: 4,
      queueLimit: 2000,
    }),
    node('indexer', 'service', 'Search Indexer', 930, 20, {
      capacity: 4,
      serviceMs: 55,
      serviceCv: 0.6,
      queueLimit: 32,
    }),
    node('billing', 'service', 'Billing', 930, 130, {
      capacity: 4,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('topic', 'pubsub', 'Fan-out Topic', 700, 230, { serviceMs: 0.5 }),
    node('push', 'service', 'Push Notifs', 930, 240, {
      capacity: 4,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('audit', 'service', 'Audit Log', 930, 350, {
      capacity: 2,
      serviceMs: 40,
      serviceCv: 0.6,
      queueLimit: 24,
    }),
    node('metrics', 'service', 'Metrics', 930, 460, {
      capacity: 4,
      serviceMs: 5,
      serviceCv: 0.4,
      queueLimit: 32,
    }),
    node('chat', 'client', 'Chat Clients', 40, 420, { rps: 30, timeoutMs: 2000 }),
    node('ws', 'websocket', 'WS Gateway', 250, 420, {
      capacity: 400,
      serviceMs: 5,
      connectionMs: 8000,
    }),
    node('mesh', 'sidecar', 'Chat Sidecar', 470, 420, {
      capacity: 32,
      serviceMs: 2,
      timeoutMs: 500,
      retries: 2,
      outlierAfter: 5,
      openMs: 3000,
    }),
    node('chatsvc', 'service', 'Chat Service', 690, 420, {
      capacity: 8,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('cron', 'cron', 'Nightly Report', 40, 560, {
      intervalMs: 15000,
      batchSize: 40,
    }),
    node('fn', 'lambda', 'Report Fn', 300, 560, {
      serviceMs: 25,
      serviceCv: 0.5,
      coldStartMs: 350,
      keepWarmMs: 10000,
      maxConcurrency: 30,
    }),
    node('db', 'db', 'Database', 560, 560, {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('client', 'gw'),
    // The gateway's route table: 3 parts interactive API, 1 part function.
    edge('gw', 'api', 3),
    edge('gw', 'fn', 1),
    edge('api', 'broker'),
    edge('api', 'topic'),
    // Each broker edge is an independent consumer group.
    edge('broker', 'indexer'),
    edge('broker', 'billing'),
    // Each topic edge is one more delivery per publish.
    edge('topic', 'push'),
    edge('topic', 'audit'),
    edge('topic', 'metrics'),
    edge('chat', 'ws'),
    edge('ws', 'mesh'),
    edge('mesh', 'chatsvc'),
    edge('cron', 'fn'),
    edge('fn', 'db'),
  ],
  // Notes only, no sections. These nodes are hand-placed rather than on the
  // COL/ROW grid, and the twelve pixels between Billing and the fan-out
  // topic cannot hold two frames plus a label plate. Nudging the layout to
  // make room would cost more than the frames are worth here.
  annotations: [
    note(
      'ed-note-sync',
      16,
      248,
      'Everything on the left is a caller waiting for an answer. Everything on the right runs after that answer was already sent.',
      236,
    ),
    // The lesson. Five consumers, one of which quietly cannot keep up.
    note(
      'ed-note-fanout',
      1160,
      16,
      'One event becomes five pieces of work here, each read by its own consumer. Turn the load up and watch the audit log: it takes 40ms a message and falls behind while the four beside it keep up, and nobody calling the API sees a thing.',
      300,
    ),
    note(
      'ed-note-cold',
      16,
      680,
      'The report function starts cold. The first call after a quiet spell pays 350ms of startup, then stays warm for ten seconds. Watch the first burst after the timer fires.',
      236,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * Resilient Delivery
 *     The resilience tier in one picture: every way a system can fail
 *     ON PURPOSE instead of by surprise.
 *
 *     Sync path, 240 rps offered:
 *       shedder   admits 700 rps sustained; 30% of keys are best-effort.
 *                 Invisible at 1x, and at 4x it drops the best-effort tier
 *                 first while the important traffic keeps its tokens.
 *       api       16 slots / 6ms -> 2600 rps, never the bottleneck.
 *       bulkhead  12 concurrent calls around recommendations. At 240 rps
 *                 a 15ms dependency holds ~3.6 in flight on average, and
 *                 the pool is sized at 3x that mean because concurrency is
 *                 Poisson: a pool at the mean would clip ordinary bursts.
 *                 Slow the dependency (inject 'slow') and the pool fills
 *                 within one round trip, after which the excess fails in
 *                 microseconds instead of queueing.
 *       recs      6 slots / 15ms -> 400 rps ceiling behind the bulkhead.
 *       writebehind  acks every write in ~1ms and holds it dirty for
 *                 200ms before the flush lands on the db: a standing
 *                 population of ~50 acknowledged-but-unwritten rows.
 *                 Crash it and watch exactly that many failures appear.
 *       retryqueue -> notify   the notification service fails 15% of
 *                 calls, so ~40/s are redelivered with backoff and only
 *                 the 0.34% that fail three straight attempts dead-letter:
 *                 failures with somewhere to go, counted on the shelf.
 *
 *     Batch path, 3 uploads/s:
 *       encode queue -> transcoder farm, 2 boxes x 2 jobs / 1.2s = 3.3
 *       jobs/s of drain against 3.0 offered. ~90% utilised at 1x; at 4x
 *       the 12 jobs/s deficit grows the backlog by ~9 jobs every second,
 *       and no amount of waiting drains it. Scale `instances` to fix it.
 * ------------------------------------------------------------------ */

const resilientDelivery: Topology = {
  nodes: [
    node('client', 'client', 'Client', COL(0), ROW(1), { rps: 240, timeoutMs: 2500 }),
    node('shedder', 'loadshedder', 'Load Shedder', COL(1), ROW(1), {
      rateLimitRps: 700,
      burst: 700,
      lowPriorityShare: 0.3,
      priorityReserve: 0.3,
    }),
    node('api', 'service', 'API Server', COL(2), ROW(1), {
      capacity: 16,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('bulkhead', 'bulkhead', 'Recs Bulkhead', COL(3), ROW(0), {
      bulkheadMax: 12,
    }),
    node('recs', 'service', 'Recommendations', COL(4), ROW(0), {
      capacity: 6,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('writebuf', 'writebehind', 'Write-Behind Cache', COL(3), ROW(1), {
      capacity: 256,
      serviceMs: 1,
      serviceCv: 0.3,
      queueLimit: 512,
      flushDelayMs: 200,
    }),
    node('db', 'db', 'Database', COL(4), ROW(1), {
      capacity: 12,
      serviceMs: 15,
      serviceCv: 0.6,
      queueLimit: 96,
    }),
    node('retryq', 'retryqueue', 'Notify Queue', COL(3), ROW(2), {
      capacity: 8,
      serviceMs: 3,
      serviceCv: 0.3,
      queueLimit: 2000,
      timeoutMs: 1000,
      retries: 2,
    }),
    node('notify', 'service', 'Notification Service', COL(4), ROW(2), {
      capacity: 6,
      serviceMs: 12,
      serviceCv: 0.5,
      errorRate: 0.15,
      queueLimit: 48,
    }),
    node('uploader', 'client', 'Upload Client', COL(0), LROW(3, 1), {
      rps: 3,
      timeoutMs: 4000,
    }),
    node('encodeq', 'queue', 'Encode Queue', COL(1), LROW(3, 1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('transcoder', 'transcoder', 'Transcoder Farm', COL(2), LROW(3, 1), {
      instances: 2,
      capacity: 2,
      serviceMs: 1200,
      serviceCv: 0.3,
    }),
  ],
  edges: [
    edge('client', 'shedder'),
    edge('shedder', 'api'),
    // The api fans out to all three: recommendations behind their own
    // bulkhead, writes into the write-behind buffer, and a notification
    // job into the retry queue. Both delivery nodes ack instantly, so
    // the client's fate rides on the recommendations path alone.
    edge('api', 'bulkhead'),
    edge('api', 'writebuf'),
    edge('api', 'retryq'),
    edge('bulkhead', 'recs'),
    edge('writebuf', 'db'),
    edge('retryq', 'notify'),
    edge('uploader', 'encodeq'),
    edge('encodeq', 'transcoder'),
  ],
  annotations: [
    sectionOver('rd-sec-live', 'Failing on purpose, not by surprise', 0, 1, 4, 0, 2),
    sectionOver('rd-sec-batch', 'Work that can wait', 2, 0, 2, 3, 3, 1),
    note(
      'rd-note-shed',
      16,
      16,
      'At 4x the shedder drops the traffic marked best effort and keeps serving the rest. Choosing what to drop beats letting a queue choose for you.',
      236,
    ),
    // The lesson. A bulkhead is the one protection whose effect you can
    // trigger by hand and see in a single round trip.
    note(
      'rd-note-bulkhead',
      1320,
      40,
      "Select recommendations and press Slow in the inspector. The bulkhead in front fills within one round trip, and after that the extra calls fail in microseconds instead of queueing. One slow feature stops being everyone else's problem.",
      300,
    ),
    note(
      'rd-note-writebuf',
      1320,
      264,
      'The write cache acks in about a millisecond and flushes 200ms later, so roughly 50 rows are always acknowledged but not yet stored. Crash it and exactly that many writes are gone.',
      300,
    ),
    note(
      'rd-note-batch',
      800,
      496,
      'The transcoders drain about 3.3 jobs a second against 3 arriving, so they are already 90 percent busy at rest. Turn the load up and the backlog grows about 9 jobs every second and never drains on its own. Raise the number of instances to fix it.',
      300,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * Discord: Real-Time Chat
 *
 * A simplified public reconstruction, not insider knowledge. It is based
 * on what Discord has published:
 *
 *   - "How Discord Stores Trillions of Messages" (discord.com/blog):
 *     messages partitioned BY CHANNEL in Cassandra, later ScyllaDB, and
 *     the hot-partition problem when one channel gets very active. The
 *     `scylla` shard node models exactly that: shards are channel
 *     partitions and hotKeyFraction is "one huge channel".
 *   - "How Discord Scaled Elixir to 5,000,000 Concurrent Users" and
 *     "Real time communication at scale with Elixir at Discord"
 *     (discord.com/blog, elixir-lang.org/blog): a gateway tier holding
 *     millions of persistent websockets, session processes per client,
 *     one guild process fanning every message out to every connected
 *     session. The fan-out topic and the Gateway Push pods model the
 *     guild-process-to-gateway leg of that fan-out.
 *   - "How Discord Handles Two and Half Million Concurrent Voice Users
 *     using WebRTC" (discord.com/blog): voice is its own fleet of SFU
 *     servers, discovered separately, on a path that never touches the
 *     text pipeline.
 *
 * What it leaves out: presence updates (a larger firehose than messages),
 * the Rust data services and request coalescing in front of ScyllaDB,
 * permission checks, and the true fan-out multiplier (a delivery per
 * MEMBER, not per gateway pod). Every number is illustrative, chosen to
 * reproduce the relative behaviour, and none is a Discord figure.
 *
 * The arithmetic at 1x:
 *
 *   CONNECTIONS  30 conn/s x 40s sessions = 1200 held against a ceiling
 *                of 4 instances x 400 = 1600 (75%). The gateway's meter
 *                is CONNECTIONS, not requests: at 2x it wants 2400 held
 *                and refuses everything past 1600 as conn-refused. That
 *                difference is the whole lesson of the gateway tier.
 *   MESSAGES     80 msg/s -> rate limiter (200 rps, Discord's API rate
 *                limits are famous) -> message API -> three children:
 *                  scylla   6 channel shards x 2 slots / 40ms = 50/s per
 *                           shard, 300/s total; ~13/s per shard at 1x.
 *                           Set hotKeyFraction to ~0.7 and one shard is
 *                           offered 56/s against its own 50: the hot
 *                           channel melts while the mean looks fine.
 *                  fan-out  one publish becomes one delivery per gateway
 *                           push pod (3 today), all detached: the sender
 *                           is long gone. Each pod does 15ms of push work
 *                           per message (2 slots -> 133/s); at 2x the
 *                           admitted 160 msg/s exceed that and the push
 *                           tier sheds deliveries LOUDLY on its own
 *                           meters while the senders' error rate shows
 *                           NOTHING. Members just stop seeing messages;
 *                           that silence is why fan-out is hard.
 *                  search   acked into a queue, indexed asynchronously
 *                           (writes pay ~68ms each at the index).
 *   MEDIA        120 fetch/s, 90% absorbed by the CDN; the object store
 *                sees ~12/s of misses.
 *   VOICE        20 joins/s across 2 SFU servers (400/s each): a
 *                separate path that stays healthy while text melts.
 * ------------------------------------------------------------------ */

const discord: Topology = {
  nodes: [
    // Connection lane: capacity here is held connections, not rps.
    node('conn', 'client', 'New Connections', COL(0), ROW(0), {
      rps: 30,
      timeoutMs: 3000,
    }),
    node('gateway', 'websocket', 'Gateway (WS)', COL(1), ROW(0), {
      capacity: 400,
      instances: 4,
      serviceMs: 5,
      serviceCv: 0.4,
      connectionMs: 40000,
    }),
    node('sessions', 'service', 'Session Servers', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),

    // Message lane.
    node('senders', 'client', 'Message Senders', COL(0), ROW(2), {
      rps: 80,
      timeoutMs: 2500,
    }),
    node('limiter', 'ratelimiter', 'API Rate Limit', COL(1), ROW(2), {
      rateLimitRps: 200,
      burst: 200,
    }),
    node('msg-api', 'service', 'Message API', COL(2), ROW(2), {
      capacity: 48,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('fanout', 'pubsub', 'Guild Fan-out', COL(3), ROW(1), { serviceMs: 0.5 }),
    node('push-a', 'service', 'Gateway Push A', COL(4), ROW(0), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('push-b', 'service', 'Gateway Push B', COL(4), ROW(1), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('push-c', 'service', 'Gateway Push C', COL(4), ROW(2), {
      capacity: 2,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    // Messages are partitioned by channel; a shard here IS a channel range.
    node('scylla', 'shard', 'Message Store', COL(3), ROW(2), {
      serviceMs: 40,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 6,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('search-q', 'queue', 'Index Queue', COL(3), LROW(3, 1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('indexer', 'worker', 'Search Indexer', COL(4), LROW(3, 1), {
      capacity: 16,
      serviceMs: 12,
      serviceCv: 0.5,
    }),
    node('search', 'searchindex', 'Message Search', COL(5), LROW(3, 1), {
      readFraction: 0.15,
    }),

    // Media lane: attachments behind a CDN.
    node('media', 'client', 'Media Fetch', COL(0), LROW(4, 1), {
      rps: 120,
      timeoutMs: 2000,
    }),
    node('cdn', 'cdn', 'Media CDN', COL(1), LROW(4, 1), {
      capacity: 256,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 2048,
    }),
    node('blobs', 'objectstore', 'Attachments', COL(2), LROW(4, 1)),

    // Voice lane: a separate fleet entirely.
    node('voice', 'client', 'Voice Joins', COL(0), LROW(5, 2), {
      rps: 20,
      timeoutMs: 3000,
    }),
    node('rtc', 'lb', 'RTC Discovery', COL(1), LROW(5, 2), {
      capacity: 256,
      serviceMs: 0.5,
    }),
    node('sfu-a', 'service', 'Voice Server A', COL(2), LROW(5, 2), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('sfu-b', 'service', 'Voice Server B', COL(2), LROW(6, 2), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('conn', 'gateway'),
    edge('gateway', 'sessions'),
    edge('senders', 'limiter'),
    edge('limiter', 'msg-api'),
    // A message write fans to all three: the store decides the sender's
    // fate; the fan-out and the index pipeline ack instantly and fail,
    // when they fail, where the sender cannot see it.
    edge('msg-api', 'scylla'),
    edge('msg-api', 'fanout'),
    edge('msg-api', 'search-q'),
    edge('fanout', 'push-a'),
    edge('fanout', 'push-b'),
    edge('fanout', 'push-c'),
    edge('search-q', 'indexer'),
    edge('indexer', 'search'),
    edge('media', 'cdn'),
    edge('cdn', 'blobs'),
    edge('voice', 'rtc'),
    edge('rtc', 'sfu-a'),
    edge('rtc', 'sfu-b'),
  ],
  annotations: [
    // Four independent paths that share a company. Only the message path
    // and the push tier are coupled, and the coupling is the lesson.
    sectionOver('dc-sec-conn', 'Holding the sockets open', 0, 0, 2, 0, 0),
    sectionOver('dc-sec-msg', 'Writing a message', 1, 0, 2, 2, 2),
    sectionOver('dc-sec-push', 'Pushing it out', 2, 4, 4, 0, 2),
    sectionOver('dc-sec-search', 'Indexed later, off to the side', 3, 3, 5, 3, 3, 1),
    sectionOver('dc-sec-media', 'Attachments', 4, 0, 2, 4, 4, 1),
    sectionOver('dc-sec-voice', 'Voice, on its own hardware', 5, 0, 2, 5, 6, 2),
    note(
      'dc-note-conn',
      1320,
      48,
      'The gateway counts open connections, not requests. 30 new a second, each held for 40 seconds, is 1200 sockets against a ceiling of 1600. Double the load and it starts refusing connections outright.',
      300,
    ),
    // The lesson. Placed clear of every frame so it reads as commentary on
    // the whole message path rather than as a label on one box.
    note(
      'dc-note-fanout',
      1608,
      272,
      'Drag the message rate up and watch the push servers. One message becomes one delivery per pod, and each pod can only do about 130 a second. Past that, members stop seeing messages while the senders see no errors at all. That silence is what makes fan-out hard.',
      320,
    ),
    note(
      'dc-note-hot',
      792,
      760,
      'Messages are split across six channel shards. Give the message store a hot key and one busy channel takes far more than its share, so that shard melts while the average still looks healthy.',
      300,
    ),
    note(
      'dc-note-voice',
      792,
      976,
      'Voice runs on its own servers and never touches the text path, so chat can be on fire while calls stay up.',
      300,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * Uber: Ride Dispatch
 *
 * A simplified public reconstruction, not insider knowledge. Based on
 * what Uber has published:
 *
 *   - "H3: Uber's Hexagonal Hierarchical Spatial Index" (uber.com/blog/h3)
 *     and their dispatch talks: driver locations land in a geospatial
 *     index sharded by cell/region, and matching reads the cells around
 *     the rider. The `geo` shard node is that index; hotKeyFraction is
 *     "everyone is downtown on Friday night".
 *   - "Real-time Data Infrastructure at Uber" (arxiv.org/abs/2104.00087):
 *     Kafka carries the event firehose; the surge pricing pipeline
 *     consumes trip and status events through Kafka into a streaming job
 *     and writes multipliers to a key-value sink store that pricing
 *     reads; M3 is the metrics store consuming the same stream.
 *   - "Brief History of Scaling Uber" (highscalability.com) and Uber's
 *     own posts on DISCO and Ringpop: a dispatch service split from an
 *     edge gateway, matching as its own latency-critical system, trip
 *     state in Schemaless (a replicated MySQL-backed store).
 *
 * What it leaves out: Ringpop's peer sharding, ETA routing graphs, the
 * ML inside surge, driver session state, and several dozen real
 * services. Every number is illustrative, not an Uber figure.
 *
 * The arithmetic at 1x:
 *
 *   WRITE SIDE   400 location pings/s from drivers, acked by ingest in
 *                ~3ms and published to the stream. Three consumer groups
 *                read it independently:
 *                  geo writer  keeps the location index fresh. Ceiling
 *                              ~750/s (12 partitions x ~16ms per update
 *                              including the shard write): comfortable at
 *                              430/s, hopeless at 4x (1630/s), where its
 *                              CONSUMER LAG grows and eventually ages out
 *                              of retention. A lagging geo writer means
 *                              dispatch is matching on stale positions,
 *                              and nothing on the rider path says so.
 *                  surge       recomputes multipliers into the surge KV
 *                              store that pricing reads.
 *                  M3          the metrics firehose, appends are cheap.
 *   READ SIDE    30 rider requests/s through the edge gateway, 3:1 to
 *                dispatch vs trip status. Dispatch fans to the geo index
 *                (2 slots x 6 region shards / 10ms = 200/s per shard),
 *                ETA, pricing and the offer push. Raise hotKeyFraction
 *                on the geo index to pile the city into one region cell.
 *   TRIPS        trip writes go to a replicated store (reads scale,
 *                writes do not) and to the payment processor: 4 slots at
 *                ~200ms is a 20/s ceiling against ~7.5/s at 1x. At 4x it
 *                saturates and the breaker in front of it trips, failing
 *                fast instead of queueing behind a 200ms dependency.
 * ------------------------------------------------------------------ */

const uber: Topology = {
  nodes: [
    // Rider read side.
    node('riders', 'client', 'Rider Apps', COL(0), ROW(1), {
      rps: 30,
      timeoutMs: 3000,
    }),
    node('gw', 'apigateway', 'Edge Gateway', COL(1), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      rateLimitRps: 200,
      burst: 200,
      authFailRate: 0.005,
    }),
    node('match', 'service', 'Dispatch', COL(2), ROW(0), {
      capacity: 8,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('eta', 'service', 'Maps ETA', COL(3), ROW(0), {
      capacity: 8,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('push', 'service', 'Offer Push', COL(4), ROW(0), {
      capacity: 4,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 32,
    }),
    node('pricing', 'service', 'Dynamic Pricing', COL(3), ROW(1), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    // The sink store the surge pipeline writes and pricing reads.
    node('surge-kv', 'db', 'Surge KV Store', COL(4), ROW(1), {
      capacity: 16,
      serviceMs: 4,
      serviceCv: 0.5,
      queueLimit: 128,
    }),

    // Trip state and payments.
    node('trips', 'service', 'Trip Service', COL(2), LROW(2, 1), {
      capacity: 32,
      serviceMs: 12,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('trip-db', 'replica', 'Trip Store', COL(3), LROW(2, 1), {
      capacity: 4,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
      replicaCount: 2,
      replicationLagMs: 50,
      readFraction: 0.7,
    }),
    node('pay-brk', 'breaker', 'Payment Breaker', COL(3), LROW(3, 1), {
      errorThreshold: 0.5,
      windowMs: 4000,
      openMs: 3000,
      halfOpenProbes: 3,
    }),
    node('payments', 'service', 'Payments', COL(4), LROW(3, 1), {
      capacity: 4,
      serviceMs: 200,
      serviceCv: 0.5,
      queueLimit: 16,
      errorRate: 0.01,
    }),

    // Driver write side: the firehose.
    node('drivers', 'client', 'Driver Pings', COL(0), LROW(4, 2), {
      rps: 400,
      timeoutMs: 2000,
    }),
    node('ingest', 'service', 'Location Ingest', COL(1), LROW(4, 2), {
      capacity: 24,
      serviceMs: 3,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    node('kafka', 'streambroker', 'Kafka Event Bus', COL(2), LROW(4, 2), {
      serviceMs: 0.5,
      serviceCv: 0.2,
      partitions: 12,
      queueLimit: 4000,
    }),
    node('geo-upd', 'service', 'Geo Updater', COL(3), LROW(4, 2), {
      capacity: 12,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    // Sharded by region cell: one shard is one slice of the city.
    node('geo', 'shard', 'Geo Index (H3)', COL(4), LROW(4, 2), {
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 32,
      shardCount: 6,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('surge-w', 'service', 'Surge Pipeline', COL(3), LROW(5, 2), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('m3', 'timeseriesdb', 'M3 Metrics', COL(3), LROW(6, 2), {
      rangeQueryFraction: 0.02,
      rangeQueryMs: 120,
    }),
  ],
  edges: [
    edge('riders', 'gw'),
    // The gateway's route table: 3 parts dispatch, 1 part trip state.
    edge('gw', 'match', 3),
    edge('gw', 'trips', 1),
    // Matching fans to everything it needs to answer one request.
    edge('match', 'geo'),
    edge('match', 'eta'),
    edge('match', 'pricing'),
    edge('match', 'push'),
    edge('pricing', 'surge-kv'),
    edge('trips', 'trip-db'),
    edge('trips', 'pay-brk'),
    // Trip events join the same stream the location pings ride.
    edge('trips', 'kafka'),
    edge('pay-brk', 'payments'),
    edge('drivers', 'ingest'),
    edge('ingest', 'kafka'),
    // Each broker edge is an independent consumer group with its own lag.
    edge('kafka', 'geo-upd'),
    edge('kafka', 'surge-w'),
    edge('kafka', 'm3'),
    edge('geo-upd', 'geo'),
    edge('surge-w', 'surge-kv'),
  ],
  annotations: [
    sectionOver('ub-sec-match', 'Finding a driver', 0, 2, 4, 0, 1),
    sectionOver('ub-sec-trip', 'The trip, and getting paid', 1, 2, 4, 2, 3, 1),
    sectionOver(
      'ub-sec-fire',
      'Where the drivers are, updated constantly',
      2,
      0,
      4,
      4,
      6,
      2,
    ),
    note(
      'ub-note-fan',
      1320,
      40,
      'One rider request touches four services before an offer comes back. The slowest of them sets the wait, so a match happens at the speed of the weakest link here.',
      300,
    ),
    // The lesson. Payments is the only node in the diagram whose ceiling is
    // low enough to hit at 4x, and the breaker's reaction is the point.
    note(
      'ub-note-pay',
      1320,
      368,
      'Drag the load to 4x and watch payments. Each charge takes 200ms and only four run at once, so it tops out near 20 a second. The breaker in front notices and starts failing fast, which beats every trip request piling up behind a slow card network.',
      300,
    ),
    note(
      'ub-note-geo',
      1320,
      696,
      'The location index is split by map cell. Give it a hot key and the whole city crowds into one cell, so that one shard saturates while the rest sit idle.',
      300,
    ),
    note(
      'ub-note-lag',
      16,
      336,
      '400 driver pings a second go onto one stream, and three readers consume it on their own clocks. If the map updater falls behind, dispatch quietly matches on stale positions and nothing on the rider path shows an error.',
      236,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 17. Netflix (public reconstruction)
 *
 * A simplified model built from what Netflix has published, not insider
 * knowledge. Sources a student can read:
 *   - Open Connect: openconnect.netflix.com and the APNIC write-up
 *     (blog.apnic.net/2018/06/20/netflix-content-distribution-through-
 *     open-connect/). Netflix states ~95% of its traffic is served from
 *     OCA appliances peered directly with residential ISPs.
 *   - Zuul 2 gateway and prioritised load shedding at the gateway:
 *     netflixtechblog.com ("Open Sourcing Zuul 2", "Keeping Netflix
 *     Reliable Using Prioritized Load Shedding").
 *   - EVCache (memcached tier) in front of Cassandra for viewing data:
 *     netflixtechblog.com EVCache posts.
 *   - Hystrix circuit breakers and bulkheads: github.com/Netflix/Hystrix.
 *   - Cosmos / VES encoding pipeline: netflixtechblog.com ("The Netflix
 *     Cosmos Platform", "Rebuilding Netflix Video Processing Pipeline
 *     with Microservices").
 * Left out: Eureka discovery, the hundreds of real microservices, A/B
 * infra, per-title encode ladders. All numbers are illustrative, chosen
 * for believable relative behaviour, not Netflix production figures.
 *
 * The traffic picture, 1x:
 *   STREAMING  1500 rps of segment fetches -> OCA at hitRate 0.96, so
 *              only ~60 rps ever touch the S3 fill origin. This lane is
 *              ~86% of all offered traffic and it never enters "the
 *              cloud" at all, which is the whole point of Open Connect.
 *   CONTROL    240 rps of device API calls -> Zuul (auth + route table,
 *              3:2 play vs browse).
 *     play     PlayAPI fans to: Hystrix breaker -> DRM licensing
 *              (5 slots / 18ms = 278 rps ceiling: the knee), EVCache at
 *              0.9 in front of a 4-shard Cassandra ring, the Keystone
 *              stream (viewing history consumer: 6 partitions x
 *              1000/20ms = 300/s ceiling), and Atlas telemetry appends.
 *     browse   Browse API -> a 10-wide Hystrix bulkhead ->
 *              Personalisation (8 slots / 20ms = 400 rps) -> precomputed
 *              recs out of EVCache (0.97; the offline recompute is not
 *              modelled).
 *   ENCODING   2 masters/s -> Cosmos queue -> VES farm (2 boxes x 2
 *              jobs / 1.5s = 2.7 jobs/s) -> encodes land in the same S3
 *              origin the OCAs fill from. Completely separate from
 *              serving, exactly as published.
 *
 * What breaks, and how:
 *   4x: licensing sheds ~50%, the breaker trips and flaps, and PlayAPI
 *   fails fast (loud). Personalisation saturates and the bulkhead caps
 *   it (loud but contained). Keystone's history consumer lags ~270
 *   msg/s and then drops out of retention (quiet). The VES backlog
 *   grows without bound (quiet). Meanwhile the OCA lane, 6000 rps of
 *   it, shrugs: streaming keeps working while the control plane burns.
 *   At 1x, drag the OCA hit rate down instead and watch the fill origin
 *   absorb a load it was never sized for.
 * ------------------------------------------------------------------ */

const netflix: Topology = {
  nodes: [
    // Streaming lane: the bytes. Most of the system's traffic, none of
    // its cloud. An OCA is an ISP-embedded cache; its misses fill from S3.
    node('viewers', 'client', 'Stream Viewers', COL(0), ROW(0), {
      rps: 1500,
      timeoutMs: 2500,
    }),
    node('oca', 'cdn', 'Open Connect OCA', COL(1), ROW(0), {
      capacity: 512,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.96,
      queueLimit: 4096,
    }),
    node('s3', 'objectstore', 'S3 Origin (fill)', COL(3), ROW(0)),
    // Encoding lane: one master in, many encodes out, fed by a queue and
    // priced in seconds. Its output lands in the same S3 the OCAs fill from.
    node('studio', 'client', 'Studio Ingest', COL(0), ROW(1), {
      rps: 2,
      timeoutMs: 3000,
    }),
    node('cosmosq', 'queue', 'Cosmos Job Queue', COL(1), ROW(1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    node('ves', 'transcoder', 'VES Encode Farm', COL(2), ROW(1), {
      instances: 2,
      capacity: 2,
      serviceMs: 1500,
      serviceCv: 0.3,
    }),
    node('atlas', 'timeseriesdb', 'Atlas Telemetry', COL(3), ROW(1), {
      capacity: 16,
      serviceMs: 1.5,
      serviceCv: 0.4,
      queueLimit: 1024,
      rangeQueryFraction: 0.03,
      rangeQueryMs: 120,
    }),
    // Control plane: the API calls. Two orders of magnitude less traffic
    // than streaming, and where all the complexity lives.
    node('capi', 'client', 'Device API Calls', COL(0), LROW(3, 1), {
      rps: 240,
      timeoutMs: 2500,
    }),
    node('zuul', 'apigateway', 'Zuul 2 Gateway', COL(1), LROW(3, 1), {
      capacity: 96,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
      rateLimitRps: 1200,
      burst: 600,
      authFailRate: 0.005,
    }),
    node('playapi', 'service', 'PlayAPI', COL(2), LROW(2, 1), {
      capacity: 48,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
      timeoutMs: 600,
    }),
    node('hystrix', 'breaker', 'Hystrix Breaker', COL(3), LROW(2, 1), {
      errorThreshold: 0.4,
      windowMs: 4000,
      openMs: 4000,
      halfOpenProbes: 3,
    }),
    // 5 slots / 18ms = 278 rps: the deliberate knee of the play path.
    node('license', 'service', 'DRM License Svc', COL(4), LROW(2, 1), {
      capacity: 5,
      serviceMs: 18,
      serviceCv: 0.5,
      queueLimit: 24,
    }),
    node('evcache', 'cache', 'EVCache (viewing)', COL(3), LROW(3, 1), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 512,
    }),
    node('cassandra', 'shard', 'Cassandra Ring', COL(4), LROW(3, 1), {
      serviceMs: 35,
      serviceCv: 0.6,
      queueLimit: 32,
      shardCount: 4,
      shardCapacity: 2,
      hotKeyFraction: 0,
    }),
    node('keystone', 'streambroker', 'Keystone Pipeline', COL(3), LROW(4, 1), {
      serviceMs: 1,
      partitions: 6,
      queueLimit: 4000,
    }),
    node('history', 'service', 'Viewing History', COL(4), LROW(4, 1), {
      capacity: 6,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    node('browse', 'service', 'Browse API', COL(2), LROW(5, 2), {
      capacity: 16,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('recsbh', 'bulkhead', 'Recs Bulkhead', COL(3), LROW(5, 2), {
      bulkheadMax: 10,
    }),
    node('recs', 'service', 'Personalisation', COL(4), LROW(5, 2), {
      capacity: 8,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 48,
    }),
    // Precomputed offline; the read path almost never misses. The
    // recompute pipeline itself is deliberately out of frame.
    node('evrecs', 'cache', 'EVCache (recs)', COL(5), LROW(5, 2), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.97,
      queueLimit: 256,
    }),
  ],
  edges: [
    edge('viewers', 'oca'),
    edge('oca', 's3'),
    edge('studio', 'cosmosq'),
    edge('cosmosq', 'ves'),
    edge('ves', 's3'),
    edge('capi', 'zuul'),
    // Zuul's route table: 3 parts playback control, 2 parts browsing.
    edge('zuul', 'playapi', 3),
    edge('zuul', 'browse', 2),
    // PlayAPI fans out to everything a real playback start touches:
    // entitlement/licensing behind its breaker, viewing state through
    // EVCache, an event onto Keystone, a telemetry append into Atlas.
    edge('playapi', 'hystrix'),
    edge('hystrix', 'license'),
    edge('playapi', 'evcache'),
    edge('evcache', 'cassandra'),
    edge('playapi', 'keystone'),
    edge('playapi', 'atlas'),
    // Keystone's one modelled consumer group: the history writer.
    edge('keystone', 'history'),
    edge('browse', 'recsbh'),
    edge('recsbh', 'recs'),
    edge('recs', 'evrecs'),
  ],
  annotations: [
    // Three regions, because the diagram is really three systems that happen
    // to share a company. The top one moves almost all the bytes and has
    // almost none of the logic, which is the first surprising thing about it.
    sectionOver('nf-sec-bytes', 'Moving the video', 0, 0, 3, 0, 1),
    sectionOver('nf-sec-edge', 'Where API calls arrive', 1, 0, 1, 3, 3, 1),
    sectionOver('nf-sec-play', 'Starting a stream', 2, 2, 4, 2, 4, 1),
    sectionOver('nf-sec-recs', 'Browsing, kept separate', 3, 2, 5, 5, 5, 2),
    note(
      'nf-note-bytes',
      1080,
      64,
      '1500 requests a second of video, and 240 of everything else. The video almost never reaches Netflix: the edge cache answers 96 percent of it from inside your ISP.',
      380,
    ),
    note(
      'nf-note-encode',
      1080,
      216,
      'Encoding is slow and that is fine. Jobs wait in a queue and nobody is watching a spinner, so seconds here cost nothing.',
      380,
    ),
    // The lesson, placed in the empty column beside the play path rather
    // than above the API tier, where a reader would attach it to the wrong
    // group of boxes.
    note(
      'nf-note-license',
      40,
      360,
      'The bottleneck is the licence service, not the video. It has 5 slots at 18ms, so it runs out at about 280 requests a second. Raise the load and watch it fill before anything else does.',
      440,
      'md',
    ),
    note(
      'nf-note-breaker',
      40,
      648,
      'The breaker in front of it is what stops one slow service from holding every request open. Trip it and playback fails fast instead of hanging.',
      440,
    ),
    note(
      'nf-note-recs',
      40,
      840,
      'Recommendations sit behind a bulkhead, so if they get slow the play path is untouched. Browsing breaking is survivable; playback breaking is not.',
      440,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * 18. Spotify (public reconstruction)
 *
 * A simplified model built from what Spotify has published, not insider
 * knowledge. Sources a student can read:
 *   - Event delivery: engineering.atspotify.com "Spotify's Event
 *     Delivery - The Road to the Cloud" (2016): ~700k events/s through
 *     Kafka, later Google Cloud Pub/Sub.
 *   - Personalisation: engineering.atspotify.com "Personalization at
 *     Spotify using Cassandra" (2015): Kafka logs, batch pipelines,
 *     Cassandra profile/metadata stores feeding Discover Weekly.
 *   - Playlists and libraries on Cassandra; search on Elasticsearch;
 *     audio from object storage via CDN (various Spotify engineering
 *     posts and talks).
 * Left out: the real GCP migration, Ogg/bitrate ladders, P2P history,
 * hundreds of squads' services. All numbers are illustrative, chosen
 * for believable relative behaviour, not Spotify production figures.
 *
 * The traffic picture, 1x:
 *   AUDIO      1100 rps of segment fetches -> CDN at hitRate 0.82 (a
 *              music catalogue has a long tail), so ~200 rps fall
 *              through to GCS audio storage (64 slots / 90ms = 710 rps
 *              ceiling). Fully separate from the metadata path.
 *   METADATA   220 rps of app calls -> gateway (700 rps bucket, 1% bad
 *              auth) -> route table: 35% metadata (cache 0.9 over a
 *              240 rps DB), 20% search (Elasticsearch-style index:
 *              searches 8ms, writes +60ms and searchable 2s late), 25%
 *              playlists, 20% home/recs.
 *   PLAYLISTS  the write-heavy path. 45% of playlist traffic is writes
 *              against a replica set whose primary has 3 slots / 30ms =
 *              100 writes/s, while reads spread over 3 replicas
 *              (300 rps). Replication lag 150ms: add a song, read the
 *              playlist back, and it is not there yet.
 *   RECS       Home/Discover reads Taste Vectors (a 1M-vector ANN index
 *              at 0.9 recall: ~50ms/query, 320 rps ceiling). Every 20s
 *              the Discover Weekly batch (cron -> queue -> feature
 *              pipeline, ~266 jobs/s for about a second) WRITES the
 *              same index, driving it to ~97% while the burst drains,
 *              so online p99 spikes on the batch clock. Batch and
 *              serving sharing a store is the lesson.
 *   EVENTS     600 events/s fired at the Event Delivery broker
 *              (8 partitions). Royalty & Reporting can drain 8 x
 *              1000/6ms = 1333/s; the analytics store drains in ~1.5ms
 *              appends. Both keep up at 1x.
 *
 * What breaks, and how:
 *   4x: 4400 rps of audio pushes ~790 rps of misses into a 710 rps GCS
 *   ceiling, and the audio path saturates and sheds (loud). The gateway bucket
 *   refuses ~180 rps of app calls (loud, at the front door). Playlist
 *   WRITES pin the primary at 100% while its read replicas idle, the
 *   replica lesson in company clothing. Events run at 2400/s against a
 *   1333/s consumer: Royalty lags, then loses data out of retention,
 *   while Analytics next to it keeps up (quiet). At 1x, crash the CDN,
 *   or watch p99 on the recs path breathe with the 20s batch cycle.
 * ------------------------------------------------------------------ */

const spotify: Topology = {
  nodes: [
    // Audio lane: bytes from blob storage through an edge cache.
    node('listeners', 'client', 'Listeners (audio)', COL(0), ROW(0), {
      rps: 1100,
      timeoutMs: 2500,
    }),
    node('audiocdn', 'cdn', 'Audio CDN', COL(1), ROW(0), {
      capacity: 384,
      serviceMs: 3,
      serviceCv: 0.3,
      hitRate: 0.82,
      queueLimit: 4096,
    }),
    // A shortish queue on purpose: when misses outrun the 710 rps
    // ceiling the store should refuse loudly, not buffer for seconds.
    node('gcs', 'objectstore', 'GCS Audio Storage', COL(2), ROW(0), {
      queueLimit: 256,
    }),
    // Metadata/control lane: the app's API calls.
    node('app', 'client', 'App Clients', COL(0), LROW(2, 1), {
      rps: 220,
      timeoutMs: 2500,
    }),
    node('gw', 'apigateway', 'API Gateway', COL(1), LROW(2, 1), {
      capacity: 96,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
      rateLimitRps: 700,
      burst: 350,
      authFailRate: 0.01,
    }),
    node('meta', 'service', 'Metadata Service', COL(2), LROW(1, 1), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('metacache', 'cache', 'Metadata Cache', COL(3), LROW(1, 1), {
      capacity: 48,
      serviceMs: 1,
      serviceCv: 0.3,
      hitRate: 0.9,
      queueLimit: 512,
    }),
    node('cassmeta', 'db', 'Track Metadata DB', COL(4), LROW(1, 1), {
      capacity: 6,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 48,
    }),
    node('search', 'service', 'Search API', COL(2), LROW(2, 1), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    node('es', 'searchindex', 'Search Index (ES)', COL(3), LROW(2, 1), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 128,
      indexMs: 60,
      indexLagMs: 2000,
      readFraction: 0.95,
    }),
    node('playlist', 'service', 'Playlist Service', COL(2), LROW(3, 1), {
      capacity: 24,
      serviceMs: 7,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    // Write-heavy: 45% writes serialise through a 3-slot / 30ms primary
    // (100 writes/s) while reads spread across 3 replicas (300 reads/s).
    node('pldb', 'replica', 'Playlist Store', COL(3), LROW(3, 1), {
      capacity: 3,
      serviceMs: 30,
      serviceCv: 0.6,
      queueLimit: 64,
      replicaCount: 3,
      replicationLagMs: 150,
      readFraction: 0.55,
    }),
    node('recs', 'service', 'Home & Discover Feed', COL(2), LROW(4, 1), {
      capacity: 32,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('vecs', 'vectordb', 'Taste Vectors', COL(3), LROW(4, 1), {
      capacity: 16,
      serviceMs: 0.5,
      serviceCv: 0.4,
      queueLimit: 128,
      indexSizeK: 1000,
      recallTarget: 0.9,
    }),
    // Discover Weekly: a batch pipeline that exists entirely outside the
    // request path, except that its output lands in the store the online
    // path reads. The cron burst every 20s is the weekly job on a clock a
    // student can actually watch.
    node('wkcron', 'cron', 'Discover Weekly Batch', COL(0), LROW(5, 2), {
      intervalMs: 20000,
      batchSize: 300,
    }),
    node('featq', 'queue', 'Feature Job Queue', COL(1), LROW(5, 2), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 5000,
    }),
    // 2 x 16 slots, each held for its 22ms and then for the vector write
    // it waits on, drain a burst at ~270 writes/s: deliberately faster than
    // the vector store can absorb on top of its online reads, so each
    // burst briefly queues the store and the online path feels it.
    node('featwork', 'worker', 'Feature Pipeline', COL(2), LROW(5, 2), {
      instances: 2,
      capacity: 16,
      serviceMs: 22,
      serviceCv: 0.4,
    }),
    // Event lane: the firehose. Producers are acked in ~1ms; each
    // outgoing edge of the broker is an independent consumer group.
    node('events', 'client', 'Event Firehose', COL(0), LROW(6, 3), {
      rps: 600,
      timeoutMs: 1500,
    }),
    node('kafka', 'streambroker', 'Event Delivery', COL(1), LROW(6, 3), {
      serviceMs: 1,
      partitions: 8,
      queueLimit: 6000,
    }),
    node('royalty', 'service', 'Royalty & Reporting', COL(2), LROW(6, 3), {
      capacity: 12,
      serviceMs: 6,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    node('analytics', 'timeseriesdb', 'Analytics Store', COL(2), LROW(7, 3), {
      capacity: 16,
      serviceMs: 1.5,
      serviceCv: 0.4,
      queueLimit: 1024,
      // Pure ingest: appends only. A range query costs ~80x an append
      // here, and with the broker delivering at most `partitions`
      // messages at once, per-delivery cost is exactly what sets a
      // consumer group's ceiling. Keeping this group cheap is what lets
      // it keep up while Royalty, at 6ms per message, falls behind.
      rangeQueryFraction: 0,
      rangeQueryMs: 120,
    }),
  ],
  edges: [
    edge('listeners', 'audiocdn'),
    edge('audiocdn', 'gcs'),
    edge('app', 'gw'),
    // The gateway's route table: metadata 35%, search 20%, playlists
    // 25%, home/recs 20%.
    edge('gw', 'meta', 7),
    edge('gw', 'search', 4),
    edge('gw', 'playlist', 5),
    edge('gw', 'recs', 4),
    edge('meta', 'metacache'),
    edge('metacache', 'cassmeta'),
    edge('search', 'es'),
    edge('playlist', 'pldb'),
    edge('recs', 'vecs'),
    edge('wkcron', 'featq'),
    edge('featq', 'featwork'),
    edge('featwork', 'vecs'),
    edge('events', 'kafka'),
    // Two independent consumer groups: royalties, and raw analytics.
    edge('kafka', 'royalty'),
    edge('kafka', 'analytics'),
  ],
  annotations: [
    sectionOver('sp-sec-audio', 'Playing the music', 0, 0, 2, 0, 0),
    sectionOver('sp-sec-app', 'Everything else the app asks for', 1, 2, 4, 1, 4, 1),
    sectionOver(
      'sp-sec-batch',
      'Recomputing recommendations offline',
      2,
      0,
      2,
      5,
      5,
      2,
    ),
    sectionOver('sp-sec-ev', 'What was played, counted twice', 3, 0, 2, 6, 7, 3),
    note(
      'sp-note-audio',
      1320,
      40,
      'Audio and everything else are separate systems. 1100 song fetches a second go to a cache near the listener, but a music catalogue has a long tail, so nearly one in five still reaches storage.',
      300,
    ),
    note(
      'sp-note-playlist',
      1320,
      240,
      'Adding a song is a write, and writes only go to the one main copy of the playlist store. It manages about 100 a second while its two read copies sit idle. Reads also run up to 150ms behind, so a song you just added can be missing when the playlist loads back.',
      300,
    ),
    // The lesson. Batch and serving sharing one store is the thing this
    // example exists to show, and it is visible at 1x on a 20 second clock.
    note(
      'sp-note-batch',
      1320,
      528,
      'Watch the taste vectors. Every 20 seconds the recommendation batch writes into the same index the home feed reads from, and the slow tail on the feed rises and falls on that clock. Turn the load up and the two fight over one store.',
      300,
    ),
    note(
      'sp-note-events',
      800,
      1024,
      'Two readers share one event stream. Turn the load up and the royalty job cannot keep up while the analytics store beside it does fine. Royalty falls behind silently, and eventually the oldest events expire before it reaches them.',
      300,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * Twitter/X: the timeline fan-out
 *
 * Based on: Raffi Krikorian, "Timelines at Scale" (QCon 2012,
 * infoq.com/presentations/Twitter-Timeline-Scalability) and the Twitter
 * engineering blog ("The Infrastructure Behind Twitter: Scale"). The
 * published design: a home timeline is PRECOMPUTED. Writing a tweet
 * fans out, one Redis timeline insert per follower, so that reading a
 * timeline is one cheap cache fetch. Roughly 300k timeline reads/s were
 * served against ~4.6k tweet writes/s, and the write path, not the
 * read path, is where the machines went. Celebrity accounts break the
 * scheme: one tweet by an account with millions of followers is
 * millions of timeline writes, so celebrities are EXCLUDED from fanout
 * and merged in at read time instead (the hybrid). Left out: the
 * hybrid read merge itself (here a cache miss rebuilds from the graph
 * and tweet store, which is the same shape), ranking, ads, DMs. All
 * numbers are illustrative, scaled to this simulator, not Twitter's.
 *
 * The traffic picture, 1x:
 *   READ   300 rps -> gateway -> timeline service -> timeline cache at
 *          hitRate 0.92. A miss rebuilds: social graph (who do I
 *          follow) + sharded tweet store, joined. Reads are CHEAP.
 *   SEARCH 1/6 of gateway traffic -> blender -> Earlybird-style index,
 *          which also ingests every tweet from the firehose group.
 *   WRITE  30 rps of tweets through a per-account rate limit (90 rps)
 *          -> write API -> sharded tweet store + the firehose broker.
 *          The fanout group is the expensive half: each delivery costs
 *          ~120ms (look up followers in the graph, insert into every
 *          follower's timeline), and the broker's 8 partitions cap the
 *          group at 8 in flight, ~55/s of drain.
 *   CELEB  every 20s a cron drops a 200-message celebrity burst
 *          straight onto the firehose: one famous tweet, 200 fanout
 *          jobs. At 1x the group drains it (~12s) just before the next.
 *
 * What breaks, and how:
 *   2x: tweets 60/s + bursts exceed the ~55/s fanout ceiling. Consumer
 *   lag on the fanout group grows and never drains: timelines go STALE
 *   while every read still returns fast and green. That is the fanout
 *   trade: reads cannot tell you the write path is drowning; only the
 *   lag can. 4x: the write limiter starts refusing tweets (loud), the
 *   search index saturates, and retention eventually starts dropping
 *   fanout messages entirely. The read row barely notices any of it.
 * ------------------------------------------------------------------ */

const twitter: Topology = {
  nodes: [
    // Read row: the cheap half. The whole point of fanout-on-write is
    // that this row is one cache hit deep for 92% of requests.
    node('readers', 'client', 'Timeline Readers', COL(0), ROW(1), {
      rps: 300,
      timeoutMs: 2000,
    }),
    node('gw', 'apigateway', 'API Gateway', COL(1), ROW(1), {
      capacity: 64,
      serviceMs: 1.5,
      serviceCv: 0.3,
      rateLimitRps: 2500,
      burst: 2500,
      authFailRate: 0,
    }),
    node('tlsvc', 'service', 'Timeline Service', COL(2), ROW(1), {
      capacity: 16,
      serviceMs: 5,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    node('tlcache', 'cache', 'Timeline Cache (Redis)', COL(3), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.4,
      hitRate: 0.92,
      queueLimit: 256,
    }),
    // A miss rebuilds the timeline the slow way: fetch the follow graph
    // and the tweets, join both. This is also the shape of the hybrid
    // celebrity merge, so it stands in for that too.
    node('tweetstore', 'shard', 'Tweet Store (sharded)', COL(4), ROW(1), {
      shardCount: 4,
      shardCapacity: 4,
      serviceMs: 12,
      serviceCv: 0.6,
      queueLimit: 64,
    }),
    node('socialgraph', 'graphdb', 'Social Graph', COL(5), ROW(2), {
      capacity: 8,
      serviceMs: 6,
      serviceCv: 0.5,
      traversalDepth: 2,
      queueLimit: 64,
    }),
    // Search: the blender fans queries to the index the firehose feeds.
    // readFraction 0.6 approximates the query:ingest mix it sees.
    node('searchsvc', 'service', 'Search Blender', COL(2), ROW(0), {
      capacity: 64,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('searchindex', 'searchindex', 'Earlybird Index', COL(4), ROW(0), {
      capacity: 8,
      serviceMs: 8,
      indexMs: 60,
      indexLagMs: 800,
      readFraction: 0.6,
      queueLimit: 64,
    }),
    // Write row: the expensive half. A per-account limiter (write rate
    // limits are real and visible on the platform), the write API
    // persisting to the shard ring, and the firehose broker.
    node('tweeters', 'client', 'Tweet Writers', COL(0), LROW(3, 1), {
      rps: 30,
      timeoutMs: 2500,
    }),
    node('wlimit', 'ratelimiter', 'Write Rate Limit', COL(1), LROW(3, 1), {
      rateLimitRps: 90,
      burst: 120,
    }),
    node('writeapi', 'service', 'Tweet Write API', COL(2), LROW(3, 1), {
      capacity: 8,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
    node('firehose', 'streambroker', 'Tweet Firehose', COL(3), LROW(3, 1), {
      serviceMs: 1,
      partitions: 8,
      queueLimit: 4000,
    }),
    // The fanout group. 120ms per delivery is the follower-list lookup
    // plus one timeline insert per follower, priced as one job. The
    // broker's 8 partitions cap the group at 8 deliveries in flight,
    // which is the ceiling that matters, not this node's slot count.
    node('fanout', 'service', 'Fanout Workers', COL(4), LROW(3, 1), {
      instances: 4,
      capacity: 4,
      serviceMs: 120,
      serviceCv: 0.4,
      queueLimit: 64,
    }),
    node('tlstore', 'service', 'Timeline Store (Redis)', COL(5), LROW(3, 1), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.3,
      queueLimit: 512,
    }),
    // One celebrity tweet is not one message: it is a burst of fanout
    // jobs. 200 every 20s here; the real number would be millions,
    // which is exactly why the real system stopped fanning them out.
    node('celebrity', 'cron', 'Celebrity Tweet', COL(2), LROW(4, 1), {
      intervalMs: 20000,
      batchSize: 200,
    }),
    node('pushsvc', 'service', 'Push Notifications', COL(4), LROW(4, 1), {
      capacity: 6,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 64,
    }),
  ],
  edges: [
    edge('readers', 'gw'),
    // The gateway's route table: 5 parts timeline, 1 part search.
    edge('gw', 'tlsvc', 5),
    edge('gw', 'searchsvc', 1),
    edge('tlsvc', 'tlcache'),
    edge('tlcache', 'tweetstore'),
    edge('tlcache', 'socialgraph'),
    edge('searchsvc', 'searchindex'),
    edge('tweeters', 'wlimit'),
    edge('wlimit', 'writeapi'),
    edge('writeapi', 'tweetstore'),
    edge('writeapi', 'firehose'),
    edge('celebrity', 'firehose'),
    // Each broker edge is an independent consumer group: fanout is the
    // expensive one, search ingest and push notifications keep up.
    edge('firehose', 'fanout'),
    edge('firehose', 'searchindex'),
    edge('firehose', 'pushsvc'),
    edge('fanout', 'socialgraph'),
    edge('fanout', 'tlstore'),
  ],
  annotations: [
    // The whole design is one trade: make reading cheap by making writing
    // expensive. Two frames, one for each half of that bargain.
    sectionOver('tw-sec-read', 'Reading a timeline', 0, 2, 5, 0, 2),
    sectionOver('tw-sec-write', 'Writing one, which costs far more', 1, 2, 5, 3, 4, 1),
    note(
      'tw-note-read',
      1584,
      40,
      'Reading a timeline is cheap because the answer was written in advance. 300 reads a second are almost all served straight from cache; only a miss goes back to look up who you follow and rebuild it.',
      300,
    ),
    // The lesson. The point is that the read side stays green throughout,
    // so the only place the failure is visible is the lag on this group.
    note(
      'tw-note-fanout',
      1584,
      496,
      'Turn the load up to 2x and watch the fan-out workers. One tweet means one insert into every follower timeline, about 120ms each, and only eight run at once. They fall behind and never catch up, so timelines go stale while every read still comes back fast and green.',
      300,
    ),
    note(
      'tw-note-celeb',
      16,
      632,
      'Every 20 seconds a famous account tweets, and that one tweet becomes 200 fan-out jobs at once. This is why very large accounts get handled differently from everyone else.',
      236,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * Stripe: correctness over availability
 *
 * Based on: Stripe's published engineering posts, "Scaling your API
 * with rate limiters" (stripe.com/blog/rate-limiters: request rate
 * limiters plus load shedders that keep critical methods working while
 * non-critical traffic is dropped), "Designing robust and predictable
 * APIs with idempotency" (stripe.com/blog/idempotency), the Stripe
 * docs on webhook retries with exponential backoff, and their ledger
 * writeups (a double-entry, append-only ledger as the source of
 * truth). Left out: the payment-intent state machine, settlement and
 * payouts clearing, multi-region, Radar's real feature stores. All
 * numbers are illustrative, not Stripe production figures.
 *
 * The shape of the lesson: a payments API is the one system in this
 * app where "just retry it" and "just shed it" are both wrong on the
 * money path. So every protection here is about REFUSING CLEANLY:
 *   - duplicate retries hit the idempotency store (a cache at
 *     hitRate 0.08: ~8% of arriving charges are retried duplicates
 *     answered from the stored response, never charged twice),
 *   - the external card networks live behind a circuit breaker; when
 *     they brown out, charges fail FAST and DEFINITIVELY instead of
 *     hanging in a state nobody can bill from,
 *   - webhooks are delivered off a retry queue with backoff; endpoints
 *     fail 12% of the time and the failures land on a dead-letter
 *     shelf instead of vanishing,
 *   - dashboards read LEDGER REPLICAS through their own limiter, so
 *     reporting load can never queue behind the money.
 *
 * The traffic picture, 1x: 100 rps of charges (gateway limiter at
 * 250), ~92 reach the payment service; each charge joins fraud check
 * (30ms) -> breaker -> card networks (250ms, the slow external truth),
 * a ledger write (15ms), and an event onto the broker. 120 rps of
 * dashboard reads fan over 3 ledger replicas. Every 25s a payout batch
 * of 150 jobs shares the ledger primary: watch its queue breathe.
 *
 * What breaks, and how: at 4x the gateway sheds ~150 rps of charges at
 * the door (loud, clean, and exactly what the rate-limiter post says
 * to do), the card-network pool runs ~90% hot so p99 stretches, and
 * dashboards are throttled to their 150 rps budget while the ledger
 * never queues. Inject an 'errors' fault on Card Networks and the breaker trips:
 * charges fail fast, nothing double-bills, webhooks drain the failures
 * with retries. Crash the Ledger and charges stop entirely while
 * dashboards keep serving off the replicas: availability is the thing
 * this system is DESIGNED to give up first.
 * ------------------------------------------------------------------ */

const stripe: Topology = {
  nodes: [
    node('merchants', 'client', 'Merchant API Calls', COL(0), ROW(1), {
      rps: 100,
      timeoutMs: 4000,
    }),
    // The front door from the rate-limiter post: a token bucket that
    // sheds excess API traffic before it can queue behind the money.
    node('gw', 'apigateway', 'API Gateway', COL(1), ROW(1), {
      capacity: 64,
      serviceMs: 2,
      serviceCv: 0.3,
      rateLimitRps: 250,
      burst: 250,
      authFailRate: 0.01,
    }),
    // Idempotency-Key dedupe: a hit is a retried duplicate answered
    // from the stored response. The 8% hit rate is the duplicate share.
    node('idem', 'cache', 'Idempotency Keys', COL(2), ROW(1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.08,
      queueLimit: 128,
    }),
    node('paysvc', 'service', 'Payment Service', COL(3), ROW(1), {
      capacity: 96,
      serviceMs: 10,
      serviceCv: 0.5,
      queueLimit: 128,
    }),
    // Radar runs IN the charge path: scoring is worth 30ms of latency
    // on every charge because the alternative is charging fraudsters.
    node('fraud', 'service', 'Radar Fraud Check', COL(4), ROW(0), {
      capacity: 96,
      serviceMs: 30,
      serviceCv: 0.5,
      timeoutMs: 1500,
      queueLimit: 64,
    }),
    node('breaker', 'breaker', 'Network Breaker', COL(5), ROW(0), {
      errorThreshold: 0.5,
      windowMs: 5000,
      openMs: 4000,
      halfOpenProbes: 3,
    }),
    // The slow external truth: a card authorisation is a quarter of a
    // second somewhere you do not control and cannot blindly retry.
    node('cardnet', 'service', 'Card Networks (external)', COL(6), ROW(0), {
      capacity: 72,
      serviceMs: 250,
      serviceCv: 0.35,
      errorRate: 0.01,
      queueLimit: 128,
    }),
    node('ledger', 'db', 'Ledger (double-entry)', COL(4), ROW(1), {
      capacity: 8,
      serviceMs: 15,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('events', 'streambroker', 'Payment Events', COL(4), ROW(3), {
      serviceMs: 1,
      partitions: 4,
      queueLimit: 4000,
    }),
    // Webhooks, per the docs: redeliver with backoff, then give up
    // onto a shelf you can inspect, because merchant endpoints fail.
    node('webhookq', 'retryqueue', 'Webhook Delivery', COL(5), ROW(3), {
      capacity: 8,
      serviceMs: 3,
      serviceCv: 0.3,
      timeoutMs: 1000,
      retries: 2,
      queueLimit: 2000,
    }),
    node('merchantep', 'service', 'Merchant Endpoints', COL(6), ROW(3), {
      capacity: 8,
      serviceMs: 40,
      serviceCv: 0.6,
      errorRate: 0.12,
      queueLimit: 64,
    }),
    node('tsdb', 'timeseriesdb', 'Billing Metrics', COL(5), LROW(4, 1), {
      capacity: 16,
      rangeQueryFraction: 0.02,
      rangeQueryMs: 120,
    }),
    // Payouts arrive on a clock, not on demand, and share the ledger
    // primary with live charges: watch its queue breathe every 25s.
    node('payoutcron', 'cron', 'Payout Batch', COL(2), ROW(3), {
      intervalMs: 25000,
      batchSize: 150,
    }),
    node('payoutsvc', 'service', 'Payout Jobs', COL(3), ROW(3), {
      capacity: 16,
      serviceMs: 20,
      serviceCv: 0.5,
      queueLimit: 256,
    }),
    // Reporting reads never touch the primary: replicas plus their own
    // limiter mean dashboard load is structurally unable to slow money.
    node('dashboards', 'client', 'Dashboard Readers', COL(0), LROW(4, 1), {
      rps: 120,
      timeoutMs: 2000,
    }),
    node('dlimit', 'ratelimiter', 'Reporting Limiter', COL(1), LROW(4, 1), {
      rateLimitRps: 150,
      burst: 200,
    }),
    node('reportsvc', 'service', 'Reporting API', COL(2), LROW(4, 1), {
      capacity: 12,
      serviceMs: 8,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('replica', 'replica', 'Ledger Replicas', COL(3), LROW(4, 1), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.6,
      replicaCount: 3,
      replicationLagMs: 400,
      readFraction: 1,
      queueLimit: 96,
    }),
  ],
  edges: [
    edge('merchants', 'gw'),
    edge('gw', 'idem'),
    edge('idem', 'paysvc'),
    // A charge is a JOIN of three branches: the authorisation chain,
    // the ledger write, and the event publish. All must land.
    edge('paysvc', 'fraud'),
    edge('paysvc', 'ledger'),
    edge('paysvc', 'events'),
    edge('fraud', 'breaker'),
    edge('breaker', 'cardnet'),
    edge('events', 'webhookq'),
    edge('events', 'tsdb'),
    edge('webhookq', 'merchantep'),
    edge('payoutcron', 'payoutsvc'),
    edge('payoutsvc', 'ledger'),
    edge('dashboards', 'dlimit'),
    edge('dlimit', 'reportsvc'),
    edge('reportsvc', 'replica'),
  ],
  annotations: [
    sectionOver('sr-sec-charge', 'Taking one payment', 0, 2, 6, 0, 1),
    sectionOver('sr-sec-after', 'What happens after the money moves', 1, 2, 6, 3, 3),
    sectionOver('sr-sec-report', 'Reading the money back out', 2, 2, 5, 4, 4, 1),
    note(
      'sr-note-idem',
      16,
      320,
      'A payment is the one thing you must never do twice. Each charge carries a key, and a retry of a charge already made gets the stored answer back instead of a second charge.',
      236,
    ),
    // The lesson. Every protection in this example is about refusing
    // cleanly, and the breaker is where a student can watch that happen.
    note(
      'sr-note-breaker',
      1840,
      40,
      'Select the card networks and press Glitch in the inspector. The breaker beside them opens, and charges start failing immediately instead of hanging. A payment that fails cleanly can be retried; one left in the air while a slow network times out is the one nobody can account for.',
      300,
    ),
    note(
      'sr-note-report',
      16,
      776,
      'Dashboards read copies of the ledger, behind their own limit. Someone loading a big report can never make a payment wait, because the two never share a queue.',
      236,
    ),
  ],
};

/* ------------------------------------------------------------------ *
 * WhatsApp: store-and-forward at absurd scale
 *
 * Based on: Rick Reed's Erlang Factory talks ("1 Million is so 2011",
 * "That's Billion with a B: scaling to the next level") and the
 * HighScalability writeup of them. The published facts this models:
 * a famously TINY system (hundreds of servers for hundreds of millions
 * of users), Erlang gateways holding about 2 MILLION tcp connections
 * per box, message routing that does almost nothing per message (with
 * end-to-end encryption the server cannot even read them), and
 * STORE-AND-FORWARD as the whole reliability story: a message to an
 * offline phone is not an error, it parks in that user's offline queue
 * (Mnesia) and is delivered when they reconnect. Media rides a
 * completely separate HTTP path into blob storage. Left out: group
 * fanout (priced into routing cost here), multi-device, presence
 * broadcast, the real Mnesia partitioning. Numbers are illustrative,
 * scaled to this simulator.
 *
 * The traffic picture, 1x:
 *   SEND    400 rps -> the Erlang router (1.5ms: the chat core idles
 *           at ~1% busy, which IS the famous lesson: simple beats big)
 *           -> recipient lookup: 70% online, pushed immediately; 30%
 *           offline, acked and parked in the offline store. The drain
 *           worker (200/s ceiling) redelivers as phones reconnect.
 *   CONNECT 45 conn/s held ~30s: ~1350 of the gateway's 1800 held
 *           connections in use. Connections, not requests, are the
 *           scarce thing, exactly as at Discord, and this box is run
 *           deliberately hot because that was the whole cost model.
 *   MEDIA   uploads and downloads on their own HTTP lane: blob store
 *           behind a cache, never touching the chat core.
 *   MIDNIGHT every 30s a 600-message burst (everyone texting at once,
 *           the published New Year's Eve peak pattern) hits the router.
 *
 * What breaks, and how: senders essentially CANNOT fail; that is what
 * store-and-forward means. At 4x the offline share (~490/s) outruns
 *   the 200/s reconnect drain and undelivered messages pile up by the
 * hundreds per second with zero sender-visible errors: the graph to
 * watch is the offline queue depth, not the error rate. Meanwhile the
 * gateway hits its connection ceiling and REFUSES new phones (loud,
 * conn-refused), the one place this system says no. Crash the offline
 * store and you lose exactly the parked messages: the queue is the
 * durability story. The router never breaks; it was never the
 * bottleneck, and that is the point.
 * ------------------------------------------------------------------ */

const whatsapp: Topology = {
  nodes: [
    node('phones', 'client', 'Message Senders', COL(0), LROW(1, 1), {
      rps: 400,
      timeoutMs: 2000,
    }),
    // The chat core: one Erlang hop. With E2E encryption the server
    // just moves ciphertext, so per-message cost is close to nothing,
    // and the node runs practically idle at any load this app offers.
    node('router', 'service', 'Erlang Router', COL(1), LROW(1, 1), {
      capacity: 48,
      serviceMs: 1.5,
      serviceCv: 0.3,
      queueLimit: 512,
    }),
    // Weighted split standing in for a presence lookup: 7 of 10
    // recipients are online right now, 3 are not.
    node('lookup', 'lb', 'Recipient Lookup (70% online)', COL(2), LROW(1, 1), {
      capacity: 256,
      serviceMs: 0.5,
    }),
    node('push', 'service', 'Push to Connected', COL(3), LROW(1, 1), {
      capacity: 32,
      serviceMs: 2,
      serviceCv: 0.4,
      queueLimit: 256,
    }),
    // Store-and-forward: the offline message is ACKED to the sender
    // and parked. Losing this node loses exactly the parked messages.
    node('offlineq', 'queue', 'Offline Store (Mnesia)', COL(3), LROW(2, 1), {
      serviceMs: 1,
      serviceCv: 0.2,
      queueLimit: 20000,
    }),
    node('drain', 'worker', 'Deliver on Reconnect', COL(4), LROW(2, 1), {
      capacity: 4,
      serviceMs: 20,
      serviceCv: 0.5,
    }),
    node('midnight', 'cron', 'Midnight Spike', COL(0), LROW(2, 1), {
      intervalMs: 30000,
      batchSize: 600,
    }),
    // The connection tier: what a gateway box actually rations. The
    // real boxes held ~2M tcp connections each; 1800 here, run at 75%
    // on purpose, because connection count WAS the capacity plan.
    node('churn', 'client', 'Phones Connecting', COL(0), ROW(0), {
      rps: 45,
      timeoutMs: 2000,
    }),
    node('wsgw', 'websocket', 'Chat Gateway (Erlang)', COL(1), ROW(0), {
      capacity: 1800,
      serviceMs: 4,
      serviceCv: 0.4,
      connectionMs: 30000,
    }),
    node('session', 'db', 'Session Store (Mnesia)', COL(2), ROW(0), {
      capacity: 16,
      serviceMs: 3,
      serviceCv: 0.4,
      queueLimit: 128,
    }),
    // Media: its own HTTP lane, exactly as published. Bytes never
    // touch the chat core.
    node('mediaup', 'client', 'Media Uploads', COL(0), LROW(3, 2), {
      rps: 25,
      timeoutMs: 4000,
    }),
    node('mediasvc', 'service', 'Media HTTP Service', COL(1), LROW(3, 2), {
      capacity: 12,
      serviceMs: 25,
      serviceCv: 0.5,
      queueLimit: 96,
    }),
    node('blob', 'objectstore', 'Media Blob Store', COL(2), LROW(3, 2), {
      capacity: 64,
      serviceMs: 90,
      serviceCv: 0.4,
      queueLimit: 512,
    }),
    node('mediadl', 'client', 'Media Downloads', COL(0), LROW(4, 2), {
      rps: 80,
      timeoutMs: 2500,
    }),
    node('mediacdn', 'cdn', 'Media Cache', COL(1), LROW(4, 2), {
      capacity: 128,
      serviceMs: 2,
      serviceCv: 0.3,
      hitRate: 0.6,
      queueLimit: 1024,
    }),
  ],
  edges: [
    edge('phones', 'router'),
    edge('midnight', 'router'),
    edge('router', 'lookup'),
    // The split that makes store-and-forward visible: online messages
    // push through, offline ones park. Weights are the 70/30 mix.
    edge('lookup', 'push', 7),
    edge('lookup', 'offlineq', 3),
    edge('offlineq', 'drain'),
    edge('churn', 'wsgw'),
    edge('wsgw', 'session'),
    edge('mediaup', 'mediasvc'),
    edge('mediasvc', 'blob'),
    edge('mediadl', 'mediacdn'),
    edge('mediacdn', 'blob'),
  ],
  annotations: [
    sectionOver('wa-sec-conn', 'Keeping phones connected', 0, 0, 2, 0, 0),
    sectionOver('wa-sec-route', 'Sending a message, or parking it', 1, 1, 4, 1, 2, 1),
    sectionOver(
      'wa-sec-media',
      'Photos and video, on their own path',
      2,
      0,
      2,
      3,
      4,
      2,
    ),
    note(
      'wa-note-conn',
      800,
      16,
      'What runs out here is open connections, not requests. 45 phones connect a second and each holds on for 30 seconds, filling 1350 of the 1800 slots. This box is run deliberately hot, because connections were the entire cost of the system.',
      300,
    ),
    note(
      'wa-note-route',
      1320,
      232,
      'The router does almost nothing per message: it cannot even read them. At 400 a second it is about one percent busy. Simple and small beat big here, and that was the point.',
      300,
    ),
    // The lesson. Senders essentially cannot fail, which is exactly what
    // makes the pile-up invisible unless you watch the right graph.
    note(
      'wa-note-store',
      1320,
      472,
      'Turn the load up to 4x and watch the offline store, not the error rate. A message to a phone that is not online parks here until it reconnects, so senders keep succeeding while undelivered messages pile up by the hundreds a second.',
      300,
    ),
    note(
      'wa-note-media',
      800,
      568,
      'Photos and video ride a separate path and never touch the chat core, so a media outage leaves messaging alone.',
      236,
    ),
  ],
};

export const PRESETS: Preset[] = [
  {
    id: 'single-server',
    name: 'Single server',
    tagline: 'Watch the database become the bottleneck',
    description:
      'One service in front of one database. Latency climbs sharply as the database fills up.',
    topology: singleServer,
  },
  {
    id: 'load-balanced',
    name: 'Load balanced',
    tagline: 'More servers, same database behind them',
    description:
      'Three servers share the load, but they all still talk to the same database.',
    topology: loadBalanced,
  },
  {
    id: 'cache-aside',
    name: 'Cache aside',
    tagline: 'What happens when the hit rate falls',
    description:
      'The cache absorbs most reads. Lower the hit rate and the database takes the whole load.',
    topology: cacheAside,
  },
  {
    id: 'async-workers',
    name: 'Async workers',
    tagline: 'A backlog that grows faster than it drains',
    description:
      'Requests are acknowledged instantly and buffered. Watch the backlog grow when workers fall behind.',
    topology: asyncWorkers,
  },
  {
    id: 'retry-storm',
    name: 'Retry storm',
    tagline: 'Retries making an overload worse',
    description:
      'A short timeout with retries in front of a small database. Retries multiply the load that caused them.',
    topology: retryStorm,
  },
  {
    id: 'cdn-origin',
    name: 'CDN and origin',
    tagline: 'How much traffic never reaches you',
    description:
      'The CDN answers most requests at the edge, so only a trickle reaches the origin. Drop the hit rate and watch the origin melt.',
    topology: cdnOrigin,
  },
  {
    id: 'rate-limited-api',
    name: 'Rate limited API',
    tagline: 'Turning excess away before it queues',
    description:
      'A limiter refuses excess traffic at the door. It serves slightly less, but what it does serve stays fast instead of queueing.',
    topology: rateLimitedApi,
  },
  {
    id: 'circuit-breaker',
    name: 'Circuit breaker',
    tagline: 'Giving a failing dependency room to recover',
    description:
      'A breaker watches a failing dependency and stops calling it. Break the payments API and watch the circuit trip, then recover.',
    topology: circuitBreaker,
  },
  {
    id: 'read-replicas',
    name: 'Read replicas',
    tagline: 'Reads that scale, and reads that go stale',
    description:
      'Replicas scale reads but not writes, and a read can arrive before the write it should have seen.',
    topology: readReplicas,
  },
  {
    id: 'sharded-database',
    name: 'Sharded database',
    tagline: 'One hot key undoing all the partitions',
    description:
      'Four partitions share the load evenly until one key gets hot, and then a single shard melts while the average still looks healthy.',
    topology: shardedDatabase,
  },
  {
    id: 'autoscaling-service',
    name: 'Autoscaling service',
    tagline: 'Capacity arriving after it was needed',
    description:
      'Capacity chases the load, but new servers take time to boot, so requests fail in the gap between the two.',
    topology: autoscalingService,
  },
  {
    id: 'multi-region',
    name: 'Multi-region failover',
    tagline: 'What a failover actually costs you',
    description:
      'Two regions, one serving. Crash the active one and every request fails until failover lands.',
    topology: multiRegion,
  },
  {
    id: 'full-stack',
    name: 'Full stack',
    tagline: 'Every piece at once, under real load',
    description:
      'Every tier at once: edge cache, load balancer, services, cache, shards, and a queue of async work behind it all.',
    topology: fullStack,
  },
  {
    id: 'specialised-stores',
    name: 'Specialised stores',
    tagline: 'The right store for each job, side by side',
    description:
      'Search, vectors, graph, blobs, metrics and an archive tier, each store built for one job. Watch which one saturates first, and which fails without a sound.',
    topology: specialisedStores,
  },
  {
    id: 'event-driven',
    name: 'Event-driven backend',
    tagline: 'Lag, fan-out, cold starts and a cron burst',
    description:
      'A stream with two consumer groups, a fan-out topic, a websocket tier, a sidecar, a lambda and a cron burst. Watch consumer lag grow, cold starts spike on the quarter-minute, and connections, not requests, run out.',
    topology: eventDriven,
  },
  {
    id: 'resilient-delivery',
    name: 'Resilient delivery',
    tagline: 'Choosing what fails, and where failures go',
    description:
      'Failing on purpose: a shedder drops the traffic that matters least, a bulkhead contains a slow dependency, retried deliveries land on a dead letter shelf, and a write-behind buffer trades durability for speed.',
    topology: resilientDelivery,
  },
  {
    id: 'discord',
    name: 'Discord: real-time chat',
    tagline: 'Millions of sockets, and fan-out per message',
    description:
      'A simplified reconstruction of Discord from their engineering blog; numbers are illustrative. The gateway runs out of connections, not requests; one message fans out to every gateway pod, and at 2x the push tier sheds deliveries the senders never see; make one channel hot and its store shard melts alone. Voice rides its own servers.',
    topology: discord,
  },
  {
    id: 'uber',
    name: 'Uber: ride dispatch',
    tagline: 'Matching riders to drivers, city by city',
    description:
      'A simplified reconstruction of Uber from their published architecture; numbers are illustrative. Driver pings outnumber rider requests 13 to 1 and ride a Kafka-style stream; at 4x the geo consumer lags and dispatch matches on stale positions without a single rider-facing error. Crash the payment processor and the breaker contains it.',
    topology: uber,
  },
  {
    id: 'netflix',
    name: 'Netflix: streaming at scale',
    tagline: 'Almost everything served from the edge',
    description:
      'A simplified reconstruction of Netflix from their tech blog; numbers are illustrative. Open Connect appliances inside ISPs serve ~96% of the bytes, so streaming barely touches the cloud; the control plane behind Zuul is where 4x hurts: licensing trips its Hystrix breaker, the recs bulkhead fills, Keystone quietly falls behind, and the encode farm backlog grows while viewers stream on.',
    topology: netflix,
  },
  {
    id: 'spotify',
    name: 'Spotify: music and discovery',
    tagline: 'A steady catalogue beside a heavy recommender',
    description:
      'A simplified reconstruction of Spotify from their engineering blog; numbers are illustrative. Audio flows from object storage through a CDN, apart from the metadata path. Playlist writes pin a replica primary while its read replicas idle, the event firehose outruns the royalty consumer at 4x, and every 20s the Discover Weekly batch writes the same vector index the home feed reads, so p99 breathes on the batch clock.',
    topology: spotify,
  },
  {
    id: 'twitter',
    name: 'Twitter/X: timeline fan-out',
    tagline: 'One tweet becoming a hundred thousand writes',
    description:
      'A simplified reconstruction of the Twitter timeline from Raffi Krikorian\'s "Timelines at Scale" talk; numbers are illustrative. Tweets fan out on write into precomputed timelines, so reads are one cache hit; every 20s a celebrity tweet dumps 200 fanout jobs on the firehose. Past 2x the fanout group never catches up again: reads stay green while timelines quietly go stale, and only the consumer lag tells the truth.',
    topology: twitter,
  },
  {
    id: 'stripe',
    name: 'Stripe: correctness over availability',
    tagline: 'Refusing work rather than charging twice',
    description:
      'A simplified reconstruction of Stripe from their published posts on rate limiters, idempotency and the ledger; numbers are illustrative. Duplicate retries answer from the idempotency store, a breaker fails charges fast when the card networks brown out, webhooks redeliver onto a dead-letter shelf, and at 4x the gateway sheds excess charges at the door while dashboards throttle against their replicas. Crash the ledger: charges stop dead, dashboards keep reading, and that ordering is the design.',
    topology: stripe,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp: store and forward',
    tagline: 'Messages that wait instead of failing',
    description:
      "A simplified reconstruction of WhatsApp from Rick Reed's Erlang scaling talks; numbers are illustrative. The chat core is deliberately tiny and nearly idle: one routing hop, then online recipients get pushed and offline ones park in the Mnesia store until they reconnect, so senders essentially cannot fail. At 4x undelivered messages pile up by the hundreds per second with zero errors, and the gateway runs out of held connections, not requests. Watch the queue depth, not the error rate.",
    topology: whatsapp,
  },
];
