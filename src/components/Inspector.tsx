import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
/*
 * Transport glyphs. The top-level entry, not the per-icon deep paths the
 * canvas uses: here the React component wrapper is exactly what we want
 * (each button holds one <svg> of its own), and the package is marked
 * side-effect-free so the build keeps only these four.
 */
import { Pause, Play, RotateCcw, StepForward } from 'lucide-react';
import type {
  NodeConfig,
  NodeKind,
  NodeStats,
  SimNode,
  SystemStats,
} from '../sim/types';
import { defaultConfig } from '../sim/presets';
import { suggestionFor } from '../content/suggestions';
import { KIND_NAME, KIND_TERM } from './nodeVisuals';
import {
  NA,
  formatCount,
  formatMs,
  formatPct,
  formatRate,
  formatRateBare,
  healthOfErr,
  healthOfLatency,
  healthOfLoad,
  toneClass,
} from './format';
import { Term } from './Tooltip';
import { VendorPanel } from './VendorPanel';
import './Inspector.css';

/* ------------------------------------------------------------------ *
 * Which knobs actually apply to which kind.
 *
 * This is the whole point of the panel: a cache shows hitRate, a db does
 * not; a client shows the load it offers and how long it waits; a queue
 * shows only how deep it may get. Thirty knobs on every node would make
 * the app look configurable and feel meaningless.
 *
 * FIELDS_BY_KIND is the single source of truth for that filtering, and
 * the assertion below it is what keeps the promise honest: every field
 * that exists must be claimed by at least one kind, so a knob can never
 * be added to the type and silently reach every panel.
 * ------------------------------------------------------------------ */

type Field =
  | 'rps'
  | 'instances'
  | 'capacity'
  | 'serviceMs'
  | 'serviceCv'
  | 'queueLimit'
  | 'hitRate'
  | 'errorRate'
  | 'timeoutMs'
  | 'retries'
  | 'replicaCount'
  | 'replicationLagMs'
  | 'readFraction'
  | 'shardCount'
  | 'shardCapacity'
  | 'hotKeyFraction'
  | 'targetUtil'
  | 'minCapacity'
  | 'maxCapacity'
  | 'cooldownMs'
  | 'scaleStepPct'
  | 'warmupMs'
  | 'regions'
  | 'activeRegion'
  | 'failoverMs'
  | 'rateLimitRps'
  | 'burst'
  | 'errorThreshold'
  | 'windowMs'
  | 'openMs'
  | 'halfOpenProbes'
  | 'indexMs'
  | 'indexLagMs'
  | 'rangeQueryFraction'
  | 'rangeQueryMs'
  | 'traversalDepth'
  | 'indexSizeK'
  | 'recallTarget'
  | 'partitions'
  | 'connectionMs'
  | 'authFailRate'
  | 'outlierAfter'
  | 'coldStartMs'
  | 'keepWarmMs'
  | 'maxConcurrency'
  | 'intervalMs'
  | 'batchSize'
  | 'bulkheadMax'
  | 'bulkheadMode'
  | 'acquireQueueMax'
  | 'acquireTimeoutMs'
  | 'flushDelayMs'
  | 'edgeShare'
  | 'lowPriorityShare'
  | 'priorityReserve'
  | 'lockMs'
  | 'prefixRps'
  | 'renditions'
  | 'cpuMsCap';

const FIELDS_BY_KIND: Record<NodeKind, Field[]> = {
  // The client generates load and decides how long to wait for an answer.
  // It serves nothing, so it has no capacity, service time, or queue.
  client: ['rps', 'timeoutMs', 'retries'],
  // A load balancer forwards; its own service time is near-zero but its
  // connection pool and backlog are real and can saturate.
  lb: ['instances', 'capacity', 'serviceMs', 'queueLimit'],
  // The general workhorse: everything except cache hits and offered load.
  service: [
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
    'timeoutMs',
    'retries',
  ],
  // Only the cache has a hit rate. That single knob is the interesting one.
  cache: ['hitRate', 'instances', 'capacity', 'serviceMs', 'serviceCv', 'queueLimit'],
  // A database is slots, service time, and the write lock: the read/write
  // mix and the per-writer lock wait are what make it more than a service.
  db: [
    'readFraction',
    'lockMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
  ],
  // A queue is a buffer. Depth is the only thing that matters about it.
  queue: ['queueLimit', 'serviceMs'],
  // Workers drain a queue. No inbound queue limit of their own.
  worker: ['instances', 'capacity', 'serviceMs', 'serviceCv', 'errorRate'],
  // The three knobs that trade read scale against staleness, plus the
  // per-replica service cost.
  replica: [
    'replicaCount',
    'replicationLagMs',
    'readFraction',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Partition count and per-shard slots set the ceiling; hotKeyFraction
  // is the knob that destroys it.
  shard: [
    'shardCount',
    'shardCapacity',
    'hotKeyFraction',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // A controller has no request-path knobs at all: every field it exposes is
  // about the control loop it runs on the node it watches.
  autoscaler: [
    'targetUtil',
    'minCapacity',
    'maxCapacity',
    'cooldownMs',
    'scaleStepPct',
    'warmupMs',
  ],
  // Which region serves, how many there are, and what an outage costs.
  region: ['regions', 'activeRegion', 'failoverMs'],
  // A CDN is a cache whose whole story is the hit rate: how much load never
  // reaches you. Capacity and service time are shown because a saturated
  // edge is still a real failure mode.
  cdn: ['hitRate', 'instances', 'capacity', 'serviceMs', 'queueLimit'],
  // A limiter has exactly two knobs, and the pair is the lesson: sustained
  // rate, and how much burst you forgive on top of it.
  ratelimiter: ['rateLimitRps', 'burst'],
  // The four knobs of a breaker are the four questions it answers: how bad,
  // measured over how long, shut for how long, and reopened on what evidence.
  breaker: ['errorThreshold', 'windowMs', 'openMs', 'halfOpenProbes'],
  // Blob storage: a high flat latency, a wide pool, and the per-prefix rate
  // ceiling that is the real limit long before the pool is.
  objectstore: [
    'prefixRps',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
    'errorRate',
  ],
  // The search trade: cheap queries, surcharged writes, and the refresh lag
  // that decides how stale a search can be.
  searchindex: [
    'readFraction',
    'indexMs',
    'indexLagMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Appends are the base cost; the two range-query knobs are what turn a
  // metrics firehose into a melted store.
  timeseriesdb: [
    'rangeQueryFraction',
    'rangeQueryMs',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // One knob carries the lesson: every extra hop of depth multiplies cost.
  graphdb: [
    'traversalDepth',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // The archive tier is deliberately knob-poor: seconds per request and few
  // slots ARE the component.
  coldstorage: ['capacity', 'serviceMs', 'serviceCv', 'queueLimit'],
  // Corpus size and recall target move query cost independently; the server
  // knobs underneath decide how much of that cost the pool can absorb.
  vectordb: [
    'indexSizeK',
    'recallTarget',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'queueLimit',
  ],
  // Partition count is the parallelism ceiling of every consumer group;
  // queueLimit is the log's retention in messages.
  streambroker: ['partitions', 'queueLimit', 'serviceMs'],
  // A topic has no knobs of its own: amplification comes from the wiring,
  // and the ack cost is the only thing to tune.
  pubsub: ['serviceMs'],
  // Capacity here is CONNECTIONS HELD per instance; connectionMs is how
  // long each one is held. serviceMs is only the handshake.
  websocket: ['connectionMs', 'instances', 'capacity', 'serviceMs', 'serviceCv'],
  // The front door: its own processing cost, a token bucket, and the auth
  // check, in one panel.
  apigateway: [
    'rateLimitRps',
    'burst',
    'authFailRate',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // The tax (serviceMs), and what it buys: retries with a per-attempt
  // deadline, and outlier ejection.
  sidecar: [
    'outlierAfter',
    'openMs',
    'retries',
    'timeoutMs',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // No fleet knobs at all: the platform scales it. What you tune is the
  // cold-start economics and the concurrency ceiling.
  lambda: [
    'coldStartMs',
    'keepWarmMs',
    'maxConcurrency',
    'serviceMs',
    'serviceCv',
    'errorRate',
  ],
  // A schedule and a payload size. Everything else about a cron job is
  // what it does to the nodes downstream of it.
  cron: ['intervalMs', 'batchSize'],
  // One knob, and it IS the component: how many calls may be outstanding
  // to the dependency behind it. errorRate and retries are deliberately
  // not offered here; both would make the pool count drift.
  bulkhead: ['bulkheadMax', 'bulkheadMode', 'acquireQueueMax', 'acquireTimeoutMs'],
  // Delivery concurrency, dispatch cost, buffer depth, and the redrive
  // policy: attempts and the per-attempt deadline.
  retryqueue: [
    'retries',
    'timeoutMs',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // The encode farm: boxes, jobs per box, seconds per job, and the quality
  // ladder each finished job hands downstream.
  transcoder: [
    'renditions',
    'instances',
    'capacity',
    'serviceMs',
    'serviceCv',
    'errorRate',
    'queueLimit',
  ],
  // The share it can answer locally, and the CPU budget that decides how
  // much of that share it actually gets to keep.
  edgecompute: [
    'edgeShare',
    'cpuMsCap',
    'instances',
    'capacity',
    'serviceMs',
    'queueLimit',
  ],
  // How long writes sit dirty, and how many may sit at once. `capacity`
  // here is the buffer (memory), not threads.
  writebehind: ['flushDelayMs', 'capacity', 'serviceMs', 'queueLimit'],
  // The limiter's bucket plus the two priority knobs that turn it from
  // fair refusal into deliberate triage.
  loadshedder: ['rateLimitRps', 'burst', 'lowPriorityShare', 'priorityReserve'],
};

/**
 * Kinds that hold no work of their own: they admit or refuse and pass
 * through, so their in-flight and queued counts are structurally zero and
 * must not be printed as if they were live readings.
 */
const GATE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'ratelimiter',
  'breaker',
  'loadshedder',
  'bulkhead',
]);

/** Kinds whose throughput ceiling is capacity x (1000 / serviceMs). */
const HAS_THROUGHPUT_CEILING: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'lb',
  'service',
  'cache',
  'db',
  'worker',
  // Both serve on the engine's standard slot discipline with a flat mean
  // service time, so capacity x (1000 / serviceMs) is exact for them too.
  'objectstore',
  'coldstorage',
  // Same standard slot discipline: delivery slots for the retry queue,
  // encode slots for the transcoder, PoP slots for edge compute.
  'retryqueue',
  'transcoder',
  'edgecompute',
  // Both run the standard slot discipline too; they were simply missing.
  'apigateway',
  'sidecar',
]);

/**
 * One line on what the kind is for. This is the text that used to sit under
 * every palette row, where it forced the rail to 260px and left it mostly
 * empty. It belongs here, shown only for the one kind actually selected.
 */
const KIND_BLURB: Record<NodeKind, string> = {
  client:
    'Offers load and waits for an answer. Its timeout decides when a slow reply becomes a failure.',
  lb: 'Spreads requests across its targets. Its own pool and backlog can saturate before theirs do.',
  service:
    'The workhorse. How many it handles at once, divided by how long each takes, is the ceiling everything else queues behind.',
  cache:
    'Answers hits without touching downstream. Each cache rolls its own hit chance, independently of the others, so stacking them multiplies misses rather than treating later caches as filters on earlier misses.',
  db: 'Slots and service time. It does not retry for you, so its queue is where pressure shows.',
  queue:
    'A buffer. Depth is the whole story: it absorbs bursts up to the limit, then sheds.',
  worker:
    'Drains a queue at its own pace. Too few workers and the backlog never recovers.',
  replica:
    'Reads scale with the replica count, but a read can arrive before the last write has propagated. Watch the stale rate as you raise the lag.',
  shard:
    'Splits data across partitions by key, so capacity adds up, until one key gets hot and a single shard has to carry it alone.',
  autoscaler:
    'Watches one node and adds capacity when it runs hot. New capacity takes warmup time to arrive, so load always leads it.',
  region:
    'Sends traffic to one region at a time. If that region dies, failover costs you a full outage window before the next one takes over.',
  cdn: 'An edge cache in front of everything. At a 0.9 hit rate one CDN leaves a tenth of the traffic for the origin, and that chance is rolled independently of every other cache on the path. It is still the cheapest capacity you will ever add.',
  ratelimiter:
    'A token bucket. Refuses excess traffic instantly instead of queueing it, which is what stops a busy system turning into a dead one.',
  breaker:
    'Watches its downstream and stops calling it once it is failing. Cutting the traffic to zero is what gives a struggling dependency room to recover.',
  objectstore:
    'Blob storage. Every request pays a high flat latency, but the pool is wide enough that saturating it takes deliberate effort. Not a database, and that is the point.',
  searchindex:
    'Searches are cheap; writes pay an indexing surcharge and only become searchable after the refresh lag. The stale-search rate is that lag made visible.',
  timeseriesdb:
    'Built to swallow appends by the thousand. A range query costs hundreds of appends, so a few percent of them dominates the store, which is why metrics do not live in your main database.',
  graphdb:
    'Stores relationships. Every extra hop of traversal depth multiplies the edges visited by three, so a friends-of-friends query costs triple and one more hop triples it again.',
  coldstorage:
    'The archive tier: cheap to keep, seconds to read. Fine for a trickle of restores behind a queue, hopeless for anything a user is waiting on.',
  vectordb:
    'Similarity search over embeddings. Cost grows with the log of the corpus and explodes as recall approaches perfect, so the recall slider is a latency slider read backwards.',
  streambroker:
    'A partitioned, replayable log. Producers are acked instantly; each outgoing edge is an independent consumer group whose lag grows when its consumers are slower than the producers. Partition count, not consumer count, caps how fast a group can drain.',
  pubsub:
    'One publish becomes one delivery per subscriber. A slow subscriber sheds at its own node without delaying the others, but the total load is multiplied by the fan-out, whether you noticed or not.',
  websocket:
    'Holds long-lived connections. Capacity is concurrent connections held, not requests per second: at 30 new connections a second held 8 seconds each, 240 slots are simply occupied. Chat systems run out of sockets long before they run out of CPU.',
  apigateway:
    'The front door: authenticates, rate limits, and routes each request to the backend its weights choose. Three components worth of refusals happen here so the backends only ever see traffic worth serving.',
  sidecar:
    'A proxy beside one service. It charges its service time on every single request, and pays you back with retries, a per-attempt deadline, and ejecting the upstream after repeated failures. Put one at every hop and watch the taxes stack; that is a service mesh.',
  lambda:
    'Scales instantly with load, up to its concurrency cap, and there is no queue past it. The catch is the cold start: a request that finds no warm instance pays a large extra latency, so idle periods and bursts are exactly when it is slowest.',
  cron: 'Fires on a schedule and dumps its whole batch at once. The database that handles the steady daytime load falls over at midnight not because traffic grew, but because this arrived all in the same instant.',
  bulkhead:
    'Caps how many calls may be outstanding to the dependency behind it. When that dependency slows down, the pool fills within one round trip and the excess fails fast here, instead of queueing behind a sick service.',
  retryqueue:
    'Acks the sender instantly, delivers downstream itself, and redelivers failures with backoff. Messages that fail every attempt land on the dead letter shelf: counted, not vanished.',
  transcoder:
    'A batch farm: jobs take seconds, so throughput is boxes times jobs-per-box divided by job time. Feed it from a queue, and size it against arrivals, because a structural deficit grows the backlog forever.',
  edgecompute:
    'A small function running in the PoP. The share of requests it can fully answer never touches your origin; the rest pass through. Unlike a CDN hit rate, that share is a property of your code, not your traffic.',
  writebehind:
    'Acknowledges writes from memory and flushes them to the store later. The caller sees a one-millisecond write; the store sees the same load smoothed. Crash it, and every write still in the buffer is lost after being confirmed.',
  loadshedder:
    'A token bucket that refuses by priority: low-priority traffic must leave a reserve untouched, so under saturation it is dropped first while the traffic that matters keeps being admitted. Degradation as a policy, not an accident.',
};

/* ------------------------------------------------------------------ *
 * Field descriptors: label, unit, control shape, bounds.
 *
 * EVERY field carries a `unit`, including sliders. A slider's unit is
 * folded into its `display` string (`120ms`, `45%`, `12/s`) rather than
 * printed twice; the separate `unit` key is what the multi-edit summary
 * and the aria description use, so it is never absent.
 * ------------------------------------------------------------------ */

/**
 * One line of plain English disambiguating a knob whose NAME alone does not
 * carry its meaning.
 *
 * Reserved for genuine ambiguity, not decoration. The test a field has to
 * fail before it earns a hint: could a student who has never read the source
 * confuse this with the field next to it? `shardCount` and `shardCapacity`
 * fail it (one is a number of things, the other a rate per thing, and both
 * read as "how much shard"). `instances` and `capacity` fail it in exactly
 * the same way. `serviceMs` passes -- its label and unit already say
 * everything -- and gets no hint, because a hint on every field is noise that
 * teaches a student to stop reading them.
 */
type FieldHint = string;

interface SliderSpec {
  control: 'slider';
  label: string;
  /** Stated for a11y and the multi-select summary; the display folds it in. */
  unit: string;
  hint?: FieldHint;
  /**
   * Glossary id for the label.
   *
   * DISTINCT FROM `hint`, and the two do different jobs. A hint is field
   * mechanics: what THIS control does to THIS component, and it is reserved
   * for genuine ambiguity between neighbouring fields. A term is the concept
   * behind the field, shared with every other surface that mentions it, and
   * it comes from the glossary so a student meets one definition of
   * "utilisation" rather than three.
   *
   * Left off where the label is already plain English describing itself
   * ("Never scale below", "Fires every"). A trigger there would promise an
   * explanation and then restate the label, which teaches a student that the
   * dotted underline is not worth following.
   */
  term?: string;
  min: number;
  max: number;
  step: number;
  /** Renders the live value shown to the right of the track. */
  display: (v: number) => string;
}

interface NumberSpec {
  control: 'number';
  label: string;
  unit: string;
  hint?: FieldHint;
  /** Glossary id for the label. See SliderSpec.term. */
  term?: string;
  min: number;
  max: number;
  step: number;
}

interface ChoiceSpec {
  control: 'choice';
  label: string;
  unit: string;
  hint?: FieldHint;
  options: readonly { value: 'reject' | 'wait'; label: string }[];
}

type FieldSpec = SliderSpec | NumberSpec | ChoiceSpec;

const FIELD_SPECS: Record<Field, FieldSpec> = {
  rps: {
    control: 'slider',
    term: 'offered',
    label: 'Offered load',
    unit: 'requests per second',
    min: 1,
    max: 5000,
    step: 1,
    display: (v) => formatRate(v),
  },
  instances: {
    control: 'number',
    term: 'instances',
    label: 'Instances',
    unit: 'machines',
    hint: 'How many copies of this component are running. This is what an autoscaler adds and removes.',
    min: 1,
    max: 512,
    step: 1,
  },
  capacity: {
    control: 'number',
    term: 'capacity',
    label: 'Slots per instance',
    unit: 'at once, on one machine',
    hint: 'How many requests ONE machine handles at a time. Total parallelism is instances x this.',
    min: 1,
    max: 4096,
    step: 1,
  },
  serviceMs: {
    control: 'slider',
    term: 'service-time',
    label: 'Service time',
    unit: 'milliseconds',
    min: 0.1,
    max: 500,
    step: 0.1,
    display: (v) => formatMs(v),
  },
  serviceCv: {
    control: 'slider',
    term: 'service-cv',
    label: 'How uneven the work is',
    unit: 'coefficient of variation',
    min: 0,
    max: 2,
    step: 0.05,
    display: (v) => (v === 0 ? 'every one the same' : v.toFixed(2)),
  },
  queueLimit: {
    control: 'number',
    term: 'queue-limit',
    label: 'Most that can wait in line',
    unit: 'at most',
    min: 0,
    max: 20000,
    step: 1,
  },
  hitRate: {
    control: 'slider',
    term: 'hit-rate',
    label: 'Hit rate you set',
    unit: 'percent',
    hint: 'Each cache or CDN rolls this chance on its own. Two at 80% leave about 4% of traffic for whatever is behind them, because the chances multiply.',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  errorRate: {
    control: 'slider',
    term: 'error-rate',
    label: 'Error rate',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  timeoutMs: {
    control: 'slider',
    term: 'timeout',
    label: 'Timeout',
    unit: 'milliseconds',
    min: 0,
    max: 5000,
    step: 10,
    display: (v) => (v === 0 ? 'none' : formatMs(v)),
  },
  retries: {
    control: 'number',
    term: 'retry',
    label: 'Retries',
    unit: 'extra tries',
    min: 0,
    max: 10,
    step: 1,
  },
  replicaCount: {
    control: 'number',
    term: 'read-replica',
    label: 'Read replicas',
    unit: 'copies, besides the primary',
    hint: 'Read-only copies behind the primary. They add READ capacity only; every write still goes through the one primary.',
    min: 1,
    max: 64,
    step: 1,
  },
  replicationLagMs: {
    control: 'slider',
    term: 'replication-lag',
    label: 'Replication lag',
    unit: 'milliseconds',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'synchronous' : formatMs(v)),
  },
  readFraction: {
    control: 'slider',
    term: 'read-fraction',
    label: 'Reads, as a share of traffic',
    unit: 'percent of traffic',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  shardCount: {
    control: 'number',
    term: 'shard',
    label: 'Shards',
    unit: 'partitions',
    hint: 'How many partitions the data is split across. A key goes to exactly one of them.',
    min: 1,
    max: 64,
    step: 1,
  },
  shardCapacity: {
    control: 'number',
    term: 'capacity',
    label: 'Slots per shard',
    unit: 'at once, on one shard',
    hint: 'How many requests ONE partition handles at a time. A hot key can only ever use its own shard\u2019s slots.',
    min: 1,
    max: 512,
    step: 1,
  },
  hotKeyFraction: {
    control: 'slider',
    term: 'hot-key',
    label: 'Traffic hitting one hot key',
    unit: 'percent onto one shard',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => (v === 0 ? 'even' : formatPct(v)),
  },
  targetUtil: {
    control: 'slider',
    term: 'target-util',
    label: 'Keep utilisation near',
    unit: 'percent',
    min: 0.1,
    max: 0.95,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  minCapacity: {
    control: 'number',
    label: 'Never scale below',
    unit: 'at once',
    min: 1,
    max: 512,
    step: 1,
  },
  maxCapacity: {
    control: 'number',
    label: 'Never scale above',
    unit: 'at once',
    min: 1,
    max: 512,
    step: 1,
  },
  cooldownMs: {
    control: 'slider',
    term: 'autoscaler',
    label: 'Wait between changes',
    unit: 'milliseconds',
    min: 0,
    max: 30000,
    step: 250,
    display: (v) => formatMs(v),
  },
  scaleStepPct: {
    control: 'slider',
    label: 'Change capacity by',
    unit: 'percent of capacity',
    min: 0.05,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  warmupMs: {
    control: 'slider',
    term: 'warmup',
    label: 'New capacity takes',
    unit: 'milliseconds',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  regions: {
    control: 'number',
    term: 'region',
    label: 'Regions',
    unit: 'regions',
    hint: 'How many regions exist in total. Only one of them serves traffic at a time; which one is a separate number, below.',
    min: 1,
    max: 8,
    step: 1,
  },
  activeRegion: {
    control: 'number',
    term: 'region',
    label: 'Serving from region',
    unit: 'number',
    hint: 'WHICH region is serving right now, not how many exist. Change it to move service to a different region without crashing anything.',
    min: 0,
    max: 7,
    step: 1,
  },
  failoverMs: {
    control: 'slider',
    term: 'region',
    label: 'Failover takes',
    unit: 'milliseconds',
    hint: 'How long every request fails for after the active region goes down and before the next one takes over. Nothing is served in that window, however many healthy regions are left.',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'instant' : formatMs(v)),
  },
  rateLimitRps: {
    control: 'slider',
    term: 'rate-limiter',
    label: 'Rate limit',
    unit: 'requests per second',
    min: 0,
    max: 2000,
    step: 5,
    display: (v) => (v === 0 ? 'unlimited' : formatRate(Math.round(v))),
  },
  burst: {
    control: 'number',
    term: 'burst',
    label: 'Burst allowance',
    unit: 'requests',
    min: 1,
    max: 5000,
    step: 1,
  },
  errorThreshold: {
    control: 'slider',
    term: 'breaker',
    label: 'Trip when errors reach',
    unit: 'percent',
    min: 0,
    max: 1,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  windowMs: {
    control: 'slider',
    label: 'Measured over',
    unit: 'milliseconds',
    min: 200,
    max: 30000,
    step: 100,
    display: (v) => formatMs(v),
  },
  openMs: {
    control: 'slider',
    term: 'breaker',
    label: 'Stay open for',
    unit: 'milliseconds',
    min: 100,
    max: 60000,
    step: 100,
    display: (v) => formatMs(v),
  },
  halfOpenProbes: {
    control: 'number',
    term: 'breaker',
    label: 'Test requests before closing',
    unit: 'requests',
    min: 1,
    max: 50,
    step: 1,
  },
  indexMs: {
    control: 'slider',
    label: 'Indexing cost per write',
    unit: 'extra milliseconds per write',
    hint: 'What a write pays ON TOP of the service time, to update the index. Searches never pay it.',
    min: 0,
    max: 500,
    step: 5,
    display: (v) => (v === 0 ? 'free' : `+${formatMs(v)}`),
  },
  indexLagMs: {
    control: 'slider',
    term: 'stale-search',
    label: 'Searchable after',
    unit: 'milliseconds after a write commits',
    hint: 'The refresh interval: how long after a write commits before searches can see it. Searches inside that window read the old index.',
    min: 0,
    max: 10000,
    step: 100,
    display: (v) => (v === 0 ? 'instantly' : formatMs(v)),
  },
  rangeQueryFraction: {
    control: 'slider',
    term: 'range-query',
    label: 'Traffic that is range queries',
    unit: 'percent of traffic',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => (v === 0 ? 'appends only' : formatPct(v)),
  },
  rangeQueryMs: {
    control: 'slider',
    term: 'range-query',
    label: 'Range query costs',
    unit: 'extra milliseconds per range query',
    hint: 'What a range query pays ON TOP of the service time, to scan and aggregate. Appends never pay it.',
    min: 0,
    max: 2000,
    step: 10,
    display: (v) => (v === 0 ? 'free' : `+${formatMs(v)}`),
  },
  traversalDepth: {
    control: 'number',
    term: 'traversal-depth',
    label: 'Traversal depth',
    unit: 'hops',
    hint: 'How many hops each query walks. Every extra hop multiplies the work by about 3, so depth 3 costs 9x depth 1.',
    min: 1,
    max: 6,
    step: 1,
  },
  indexSizeK: {
    control: 'slider',
    label: 'Index size',
    unit: 'thousands of vectors',
    min: 1,
    max: 100000,
    step: 1,
    display: (v) =>
      v >= 1000
        ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}M vectors`
        : `${Math.round(v)}K vectors`,
  },
  recallTarget: {
    control: 'slider',
    term: 'recall',
    label: 'Recall target',
    unit: 'fraction of true neighbours found',
    hint: 'How close to perfect the search must be. Cost scales with 1 / (1 - recall): the last percent costs more than everything before it.',
    min: 0.5,
    max: 0.99,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  partitions: {
    control: 'number',
    term: 'partitions',
    label: 'Partitions',
    unit: 'partitions',
    hint: 'A message lands in one partition by key, and a consumer group takes at most one message per partition at a time, so this is the most a group can do in parallel.',
    min: 1,
    max: 64,
    step: 1,
  },
  connectionMs: {
    control: 'slider',
    term: 'connection-slot',
    label: 'Connection lifetime',
    unit: 'milliseconds held',
    hint: 'How long each accepted connection occupies a slot. Held connections settle at rate x lifetime, which is the number that actually saturates.',
    min: 500,
    max: 120000,
    step: 500,
    display: (v) => formatMs(v),
  },
  authFailRate: {
    control: 'slider',
    label: 'Failing auth',
    unit: 'percent of requests',
    min: 0,
    max: 0.5,
    step: 0.005,
    display: (v) => formatPct(v),
  },
  outlierAfter: {
    control: 'number',
    label: 'Eject after',
    unit: 'consecutive failures',
    hint: 'Straight downstream failures before the proxy stops calling it for a while. Simpler than the breaker on purpose; this is how sidecar outlier detection actually works.',
    min: 1,
    max: 50,
    step: 1,
  },
  coldStartMs: {
    control: 'slider',
    term: 'cold-start',
    label: 'Cold start costs',
    unit: 'extra milliseconds',
    min: 0,
    max: 5000,
    step: 25,
    display: (v) => (v === 0 ? 'free' : formatMs(v)),
  },
  keepWarmMs: {
    control: 'slider',
    term: 'cold-start',
    label: 'Instances stay warm',
    unit: 'milliseconds after finishing',
    hint: 'How long a finished instance waits, warm, before the platform reclaims it. Shorter keep-warm means more cold starts on the next burst.',
    min: 0,
    max: 60000,
    step: 500,
    display: (v) => (v === 0 ? 'reclaim at once' : formatMs(v)),
  },
  maxConcurrency: {
    control: 'number',
    term: 'capacity',
    label: 'Concurrency cap',
    unit: 'invocations at once',
    hint: 'The platform limit. Past it requests are throttled immediately; a lambda has no queue to wait in.',
    min: 1,
    max: 1000,
    step: 1,
  },
  intervalMs: {
    control: 'slider',
    label: 'Fires every',
    unit: 'milliseconds',
    min: 1000,
    max: 120000,
    step: 1000,
    display: (v) => formatMs(v),
  },
  batchSize: {
    control: 'number',
    label: 'Requests per firing',
    unit: 'per outgoing edge, at once',
    min: 1,
    max: 2000,
    step: 1,
  },
  bulkheadMax: {
    control: 'number',
    term: 'bulkhead',
    label: 'Calls in flight, at most',
    unit: 'to the dependency behind it',
    hint: 'The pool. Roughly this divided by the dependency\u2019s latency in seconds is the admission ceiling.',
    min: 1,
    max: 512,
    step: 1,
  },
  bulkheadMode: {
    control: 'choice',
    label: 'When the pool is full',
    unit: 'admission behavior',
    hint: 'Reject fails immediately. Wait holds a request until a connection opens, or its acquire timeout expires.',
    options: [
      { value: 'reject', label: 'Reject' },
      { value: 'wait', label: 'Wait' },
    ],
  },
  acquireQueueMax: {
    control: 'number',
    label: 'Waiting acquires, at most',
    unit: 'requests',
    min: 0,
    max: 10000,
    step: 1,
  },
  acquireTimeoutMs: {
    control: 'slider',
    label: 'Acquire timeout',
    unit: 'milliseconds',
    min: 0,
    max: 30000,
    step: 50,
    display: (v) => formatMs(v),
  },
  flushDelayMs: {
    control: 'slider',
    term: 'dirty-write',
    label: 'Writes sit dirty for',
    unit: 'milliseconds',
    hint: 'Time between the ack and the flush landing. Everything inside this window is lost if the node crashes.',
    min: 0,
    max: 10000,
    step: 50,
    display: (v) => (v === 0 ? 'instant flush' : formatMs(v)),
  },
  edgeShare: {
    control: 'slider',
    term: 'edgecompute',
    label: 'Answered at the edge',
    unit: 'percent of requests',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  lowPriorityShare: {
    control: 'slider',
    term: 'loadshedder',
    label: 'Low-priority traffic',
    unit: 'percent of traffic',
    hint: 'Derived from the request key, so the same caller is always the same priority.',
    min: 0,
    max: 1,
    step: 0.01,
    display: (v) => formatPct(v),
  },
  priorityReserve: {
    control: 'slider',
    term: 'loadshedder',
    label: 'Reserved for high priority',
    unit: 'percent of the bucket',
    hint: 'Low-priority requests must leave this share of tokens untouched, which is why they are dropped first.',
    min: 0,
    max: 0.9,
    step: 0.05,
    display: (v) => formatPct(v),
  },
  lockMs: {
    control: 'slider',
    term: 'lock-contention',
    label: 'Lock wait per concurrent write',
    unit: 'milliseconds each',
    hint: 'Each write entering service waits this long for every write already in flight. Fleet size does not appear in that sentence, which is the lesson.',
    min: 0,
    max: 100,
    step: 1,
    display: (v) => (v === 0 ? 'no contention' : formatMs(v)),
  },
  prefixRps: {
    control: 'slider',
    term: 'prefix-ceiling',
    label: 'Ceiling per key prefix',
    unit: 'requests per second, each prefix',
    hint: 'Keys map onto 8 prefixes. Evenly spread traffic sustains 8x this; a hot prefix gets exactly 1x and then slowdowns, however idle the pool is.',
    min: 0,
    max: 1000,
    step: 10,
    display: (v) => (v === 0 ? 'no limit' : `${v}/s`),
  },
  renditions: {
    control: 'number',
    term: 'rendition',
    label: 'Renditions per job',
    unit: 'output files, per finished job',
    hint: 'The quality ladder. Storage behind the farm sees this many uploads per job, so its write load is this times the job rate.',
    min: 1,
    max: 12,
    step: 1,
  },
  cpuMsCap: {
    control: 'slider',
    term: 'cpu-budget',
    label: 'CPU budget per request',
    unit: 'milliseconds of execution',
    hint: 'A request that runs past this is killed at the edge and sent to the origin anyway. Heavier edge code blows the budget more often.',
    min: 0,
    max: 50,
    step: 0.5,
    display: (v) => (v === 0 ? 'no budget' : formatMs(v)),
  },
};

/* ------------------------------------------------------------------ *
 * Per-kind overrides of a shared field's wording.
 *
 * A field id is shared machinery; what it MEANS can differ by kind, and the
 * label must say what the engine will actually do with the number. The
 * shared `capacity` spec reads "How many requests ONE machine handles at a
 * time", which is flatly wrong on a websocket gateway (a slot there is a
 * HELD CONNECTION) and on a write-behind cache (the buffer is memory, not
 * threads). Same for the autoscaler's bounds, whose unit is INSTANCES since
 * the instance-model revision, and the broker's queueLimit, which is the
 * log's RETENTION. Only wording is overridden here, never bounds or control
 * shape, so the engine-facing semantics of the field cannot fork.
 * ------------------------------------------------------------------ */

const KIND_FIELD_OVERRIDES: Partial<
  Record<NodeKind, Partial<Record<Field, Partial<FieldSpec>>>>
> = {
  websocket: {
    capacity: {
      // Overrides the shared `capacity` term too: a slot here is a held
      // connection, and pointing this at the generic capacity entry would
      // explain the wrong idea to the one kind that most needs the right one.
      term: 'connection-slot',
      label: 'Connections per instance',
      unit: 'held at once, on one machine',
      hint: 'A slot here is a held connection, not a request in service. Held connections settle at connect rate x lifetime, which is the number that saturates.',
    },
  },
  writebehind: {
    capacity: {
      term: 'dirty-write',
      label: 'Dirty writes held',
      unit: 'buffered at once',
      hint: 'The buffer is memory: how many acknowledged writes may sit dirty at once. It is not a thread count.',
    },
  },
  streambroker: {
    queueLimit: {
      term: 'retention',
      label: 'Retention',
      unit: 'messages kept, per partition',
      hint: 'How far back the log keeps messages. A consumer group that falls further behind than this skips ahead, and the skipped messages are lost to it.',
    },
  },
  autoscaler: {
    minCapacity: { unit: 'instances' },
    maxCapacity: { unit: 'instances' },
    scaleStepPct: { label: 'Change the fleet by', unit: 'percent of instances' },
  },
};

/** The spec actually rendered for `field` on a node of `kind`. */
function specFor(kind: NodeKind, field: Field): FieldSpec {
  const base = FIELD_SPECS[field];
  const patch = KIND_FIELD_OVERRIDES[kind]?.[field];
  return patch ? ({ ...base, ...patch } as FieldSpec) : base;
}

/**
 * Grouping WITHIN a kind's field list.
 *
 * A replica shows seven knobs. Three are about replication and four are
 * the ordinary server knobs underneath it, and reading them as one flat
 * list of seven is what makes a panel feel like a form. The order of
 * FIELDS_BY_KIND is preserved inside each group, and a group with no
 * fields for this kind is not rendered — so this never introduces a knob
 * a kind does not have, which is the invariant that matters.
 */
const FIELD_GROUPS: { title: string; fields: ReadonlySet<Field> }[] = [
  {
    // The knob that teaches this kind's lesson goes first, alone.
    title: 'What it does',
    fields: new Set<Field>([
      'rps',
      'hitRate',
      'replicaCount',
      'replicationLagMs',
      'readFraction',
      'shardCount',
      'shardCapacity',
      'hotKeyFraction',
      'targetUtil',
      'minCapacity',
      'maxCapacity',
      'cooldownMs',
      'scaleStepPct',
      'warmupMs',
      'regions',
      'activeRegion',
      'failoverMs',
      'rateLimitRps',
      'burst',
      'errorThreshold',
      'windowMs',
      'openMs',
      'halfOpenProbes',
      'indexMs',
      'indexLagMs',
      'rangeQueryFraction',
      'rangeQueryMs',
      'traversalDepth',
      'indexSizeK',
      'recallTarget',
      'partitions',
      'connectionMs',
      'authFailRate',
      'outlierAfter',
      'coldStartMs',
      'keepWarmMs',
      'maxConcurrency',
      'intervalMs',
      'batchSize',
      'bulkheadMax',
      'bulkheadMode',
      'acquireQueueMax',
      'acquireTimeoutMs',
      'flushDelayMs',
      'edgeShare',
      'lowPriorityShare',
      'priorityReserve',
    ]),
  },
  {
    title: 'How much it can handle',
    fields: new Set<Field>(['capacity', 'serviceMs', 'serviceCv', 'queueLimit']),
  },
  {
    title: 'When things go wrong',
    fields: new Set<Field>(['errorRate', 'timeoutMs', 'retries']),
  },
];

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/**
 * Fraction of a slider's travel that is filled, as a CSS percentage.
 *
 * The shared .slider primitive paints its WebKit fill from a `--fill-pct`
 * custom property, because WebKit exposes no equivalent of Firefox's
 * ::-moz-range-progress. Nothing was setting it, so on Chrome every slider
 * in the app rendered an empty trough no matter where its thumb sat.
 *
 * The range is guarded: a spec whose min equals its max would divide by
 * zero, and a non-finite value would reach CSS as `NaN%` and paint nothing.
 */
function fillPct(value: number, min: number, max: number): string {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return '0%';
  const v = Number.isFinite(value) ? value : min;
  const t = (v - min) / span;
  return `${Math.max(0, Math.min(1, t)) * 100}%`;
}

function SliderRow({
  spec,
  value,
  mixed,
  locked,
  onChange,
}: {
  spec: SliderSpec;
  value: number;
  /** True when a multi-selection disagrees on this field. */
  mixed?: boolean;
  /** Held still by a challenge. Shown, and shown to be fixed, never hidden. */
  locked?: boolean;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className={locked ? 'ins-field is-locked' : 'ins-field'}>
      <div className="ins-field-head">
        <label className="row-k" htmlFor={id}>
          {spec.term ? <Term id={spec.term}>{spec.label}</Term> : spec.label}
        </label>
        <span className={mixed ? 'row-v ins-mixed' : 'row-v'}>
          {mixed ? 'mixed' : spec.display(value)}
        </span>
      </div>
      <input
        id={id}
        className="slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        /* A mixed selection has no single position to fill to, so the
           track is left empty rather than showing one node's value as if
           it were shared. */
        style={
          {
            '--fill-pct': mixed ? '0%' : fillPct(value, spec.min, spec.max),
          } as React.CSSProperties
        }
        aria-describedby={`${id}-u`}
        aria-valuetext={mixed ? 'mixed' : spec.display(value)}
        disabled={locked}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <span id={`${id}-u`} className="sr-only">
        {spec.unit}
      </span>
      {locked ? (
        <p className="ins-hint">
          Fixed for this challenge: it describes the work, not your design.
        </p>
      ) : spec.hint ? (
        <p className="ins-hint">{spec.hint}</p>
      ) : null}
    </div>
  );
}

function NumberRow({
  spec,
  value,
  mixed,
  locked,
  onChange,
}: {
  spec: NumberSpec;
  value: number;
  mixed?: boolean;
  /** Held still by a challenge. See SliderRow. */
  locked?: boolean;
  onChange: (v: number) => void;
}) {
  const id = useId();
  /** Text as typed while the field is focused; null when at rest. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The committed value when focus arrived, so Escape can revert to it. */
  const atFocusRef = useRef(value);
  return (
    <div
      className={
        (spec.hint || locked
          ? 'ins-field-row ins-field-row--hinted'
          : 'ins-field-row') + (locked ? ' is-locked' : '')
      }
    >
      <label className="row-k" htmlFor={id}>
        {spec.term ? <Term id={spec.term}>{spec.label}</Term> : spec.label}
      </label>
      <span className="ins-number-wrap">
        {/*
          A DRAFT rides over the committed value while the field is focused.
          Committing the clamped parse of every keystroke corrupted edits in
          progress: Ctrl+A then "-5" saw the intermediate "" parse to 0,
          clamp to the minimum, re-render into the field, and the following
          "5" append to it — the student typed -5 and got 15. The draft lets
          the box hold any partial text; only text that parses commits (still
          clamped, still live), and blur or Enter squares the box back with
          the committed value. Escape discards the draft outright.
        */}
        <input
          id={id}
          className="ins-number"
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={draft ?? value}
          placeholder={mixed ? 'mixed' : undefined}
          data-mixed={mixed || undefined}
          disabled={locked}
          onChange={(e) => {
            const text = e.currentTarget.value;
            setDraft(text);
            if (text.trim() === '') return;
            const raw = Number(text);
            if (!Number.isFinite(raw)) return;
            onChange(Math.min(spec.max, Math.max(spec.min, Math.round(raw))));
          }}
          onFocus={() => {
            atFocusRef.current = value;
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setDraft(null);
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              // Same contract as the canvas rename: Escape means "as it was
              // when I started", not "keep whatever half-edit went through".
              onChange(atFocusRef.current);
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
        />
        <span className="label ins-unit">{spec.unit}</span>
      </span>
      {locked ? (
        <p className="ins-hint">
          Fixed for this challenge: it describes the work, not your design.
        </p>
      ) : spec.hint ? (
        <p className="ins-hint">{spec.hint}</p>
      ) : null}
    </div>
  );
}

function ChoiceRow({
  spec,
  value,
  locked,
  onChange,
}: {
  spec: ChoiceSpec;
  value: 'reject' | 'wait';
  locked?: boolean;
  onChange: (v: 'reject' | 'wait') => void;
}) {
  const id = useId();
  return (
    <div className={locked ? 'ins-field-row is-locked' : 'ins-field-row'}>
      <label className="row-k" htmlFor={id}>
        {spec.label}
      </label>
      <select
        id={id}
        className="ins-number"
        value={value}
        disabled={locked}
        onChange={(e) => onChange(e.currentTarget.value as 'reject' | 'wait')}
      >
        {spec.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {spec.hint ? <p className="ins-hint">{spec.hint}</p> : null}
    </div>
  );
}

/**
 * One live readout. `tone` is a health class or undefined — at 'ok' the value
 * stays neutral, so a healthy panel carries no colour at all and --warn /
 * --danger keep their meaning for when they do appear.
 */
function StatRow({
  label,
  term,
  value,
  tone,
}: {
  label: string;
  /**
   * Glossary id, where the row names a concept rather than describing itself.
   *
   * Most rows here were deliberately written as plain English ("Being handled
   * now", "Booting now") and need no explanation; those pass nothing and
   * render exactly as before. The ones that carry a term a student could not
   * guess -- p99, goodput, backlog, hit rate -- point at the glossary instead
   * of repeating a definition locally.
   */
  term?: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="ins-stat">
      <span className="row-k">{term ? <Term id={term}>{label}</Term> : label}</span>
      <span className={tone ? `row-v ${tone}` : 'row-v'}>{value}</span>
    </div>
  );
}

/**
 * A ratio rendered as a multiple: `3.8x`, `0.6x`, `<0.1x`.
 *
 * Rule 1 applies here as it does to every other readout: a node running at
 * twenty times its ceiling has a headroom of 0.05, and `0.0x` would say it has
 * none to spare when what it actually has is a deficit. Below the display step
 * it degrades to a bound rather than to zero.
 */
function formatMultiple(v: number): string {
  if (!Number.isFinite(v) || v < 0) return NA;
  if (v === 0) return '0x';
  if (v < 0.1) return '<0.1x';
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, '')}x`;
  return `${formatCount(v)}x`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ins-section">
      <h2 className="label ins-section-title">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A utilisation meter. Length is the primary channel and colour the
 * secondary one, so the reading survives both a colourblind student and a
 * greyscale screenshot. Width is clamped into 0..1 before it reaches CSS,
 * so an oversubscribed node pins the bar at full rather than overflowing
 * its track.
 */
function Meter({
  value,
  tone,
  label = 'Utilisation',
}: {
  value: number;
  tone?: string;
  /** What the bar measures, for the accessible name. */
  label?: string;
}) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const pct = Math.min(1, safe) * 100;
  return (
    <div
      className={tone ? `ins-meter ${tone}` : 'ins-meter'}
      role="img"
      aria-label={`${label} ${formatPct(value)}`}
    >
      <div className="ins-meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * The headline meter, per kind.
 *
 * "How busy it is" driven by `utilization` rendered a permanent 0% on every
 * kind that serves no requests (rate limiter, breaker, load shedder,
 * bulkhead, pub/sub, stream broker, cron, region, autoscaler, queue): the
 * engine hardwires their utilisation to zero, so the one meter at the top of
 * the panel was a dead gauge on ten kinds, including several mid-catastrophe.
 * Each kind now meters the quantity that genuinely fills up for it, or shows
 * nothing when its own panel below carries the reading.
 */
function VitalsMeter({
  kind,
  stats,
  cfg,
}: {
  kind: NodeKind;
  stats: NodeStats;
  cfg: NodeConfig;
}) {
  switch (kind) {
    // Their own panels below carry the honest reading; a utilisation bar
    // here would be a second gauge pinned at zero.
    case 'client':
    case 'queue':
    case 'cron':
    case 'autoscaler':
    case 'region':
    case 'pubsub':
    case 'breaker':
      return null;

    // Token-bucket kinds: the bucket is the thing that drains.
    case 'ratelimiter':
    case 'loadshedder':
    case 'apigateway': {
      const burst = cfg.burst ?? cfg.rateLimitRps ?? 1;
      const tokens = Math.max(0, stats.tokens ?? 0);
      const fill = burst > 0 ? Math.min(1, tokens / burst) : 0;
      const tone = toneClass(healthOfLoad(1 - fill));
      return (
        <div className="ins-util">
          <div className="ins-util-head">
            <span className="label">
              <Term id="rate-limiter">Tokens left</Term>
            </span>
            <span className={tone ? `num num-md ${tone}` : 'num num-md'}>
              {formatCount(tokens)} / {formatCount(burst)}
            </span>
          </div>
          <Meter value={fill} tone={tone} label="Tokens left" />
        </div>
      );
    }

    case 'bulkhead': {
      const limit = stats.bulkheadLimit ?? 0;
      const used = stats.bulkheadInFlight ?? 0;
      const fill = limit > 0 ? Math.min(1, used / limit) : 0;
      const rejecting = (stats.bulkheadRejectedRate ?? 0) > 0;
      const timingOut = (stats.bulkheadAcquireTimeoutRate ?? 0) > 0;
      const tone = rejecting || timingOut ? 'is-danger' : toneClass(healthOfLoad(fill));
      return (
        <div className="ins-util">
          <div className="ins-util-head">
            <span className="label">
              <Term id="bulkhead">Pool in use</Term>
            </span>
            <span className={tone ? `num num-md ${tone}` : 'num num-md'}>
              {formatCount(used)} / {formatCount(limit)}
            </span>
          </div>
          <Meter value={fill} tone={tone} label="Pool in use" />
        </div>
      );
    }

    case 'streambroker': {
      const lag = stats.consumerLag ?? 0;
      const retention = stats.queueLimit > 0 ? stats.queueLimit : 1;
      const fill = Math.min(1, lag / retention);
      const losing = (stats.retentionDropRate ?? 0) > 0;
      const tone = losing ? 'is-danger' : toneClass(healthOfLoad(fill));
      return (
        <div className="ins-util">
          <div className="ins-util-head">
            <span className="label">
              <Term id="consumer-lag">Worst lag vs retention</Term>
            </span>
            <span className={tone ? `num num-md ${tone}` : 'num num-md'}>
              {formatCount(lag)} / {formatCount(retention)}
            </span>
          </div>
          <Meter value={fill} tone={tone} label="Consumer lag" />
        </div>
      );
    }

    case 'websocket': {
      const max = stats.maxConnections ?? 0;
      const open = stats.connectionsOpen ?? 0;
      const fill = max > 0 ? Math.min(1, open / max) : 0;
      const refusing = (stats.connectionRejectRate ?? 0) > 0;
      const tone = refusing ? 'is-danger' : toneClass(healthOfLoad(fill));
      return (
        <div className="ins-util">
          <div className="ins-util-head">
            <span className="label">
              <Term id="connection-slot">Connections held</Term>
            </span>
            <span className={tone ? `num num-md ${tone}` : 'num num-md'}>
              {formatCount(open)} / {formatCount(max)}
            </span>
          </div>
          <Meter value={fill} tone={tone} label="Connections held" />
        </div>
      );
    }

    default: {
      const util = stats.utilization;
      const tone = toneClass(healthOfLoad(util));
      return (
        <div className="ins-util">
          <div className="ins-util-head">
            <span className="label">
              <Term id="utilisation">How busy it is</Term>
            </span>
            <span className={tone ? `num num-md ${tone}` : 'num num-md'}>
              {formatPct(util)}
            </span>
          </div>
          <Meter value={Math.max(0, Math.min(1, util))} tone={tone} />
        </div>
      );
    }
  }
}

/**
 * The cron, narrated. Its generic stats are hardwired zeros (it serves
 * nothing, ever), so the panel states the schedule instead: when it fires
 * next, how big the burst will be, and what it has emitted so far.
 */
function CronPanel({ stats }: { stats: NodeStats }) {
  return (
    <Section title="What it is doing">
      <div className="ins-stats">
        <StatRow label="Next firing in" value={formatMs(stats.nextFireInMs)} />
        <StatRow label="Requests per firing" value={formatCount(stats.burstSize)} />
        <StatRow label="Sent since start" value={formatCount(stats.batchEmitted)} />
      </div>
      <p className="ins-hint">
        Between firings it does nothing at all. The whole batch lands downstream in the
        same instant, which is exactly what makes it dangerous.
      </p>
    </Section>
  );
}

/**
 * The failover switch, narrated: which region serves, how many are healthy,
 * and, mid-failover, how long the dark window has left. Previously the panel
 * showed a permanent 0% meter through a total outage.
 */
function RegionPanel({ stats }: { stats: NodeStats }) {
  const total = stats.regionsTotal ?? 1;
  const healthy = stats.regionsHealthy ?? total;
  const dark = stats.failingOver === true;
  return (
    <Section title="What it is doing">
      <div className="ins-stats">
        <StatRow
          label="Serving from"
          value={dark ? 'nowhere' : `region ${stats.activeRegion ?? 0}`}
          tone={dark ? 'is-danger' : undefined}
        />
        <StatRow
          label="Regions healthy"
          value={`${formatCount(healthy)} of ${formatCount(total)}`}
          tone={healthy === 0 ? 'is-danger' : healthy < total ? 'is-warn' : undefined}
        />
        {dark && (
          <StatRow
            label="Traffic resumes in"
            value={formatMs(stats.failoverRemainingMs)}
            tone="is-danger"
          />
        )}
      </div>
      {dark && (
        <p className="ins-hint is-danger">
          Mid-failover: every request arriving right now fails. This window is what
          failover costs, and it is never free.
        </p>
      )}
    </Section>
  );
}

/**
 * Kind-specific live rows for the "Right now" section.
 *
 * Every one of these fields already existed in NodeStats; the panel simply
 * never showed them. The breaker was the worst case: its panel contained
 * NOTHING breaker-specific while the node was failing fast at 93 rps.
 * A row appears only for the kinds it applies to.
 */
function KindStatRows({
  kind,
  config,
  stats,
}: {
  kind: NodeKind;
  config: NodeConfig;
  stats: NodeStats;
}) {
  switch (kind) {
    case 'cache':
      return (
        <StatRow
          label="Hit rate right now"
          term="hit-rate"
          value={formatPct(stats.hitRate)}
        />
      );

    case 'cdn':
      return (
        <>
          <StatRow
            label="Hit rate right now"
            term="hit-rate"
            value={formatPct(stats.hitRate)}
          />
          <StatRow
            label="Fetched from origin"
            value={formatRate(stats.originFetchRate)}
          />
        </>
      );

    case 'ratelimiter':
      return (
        <>
          <StatRow label="Admitted" value={formatRate(stats.admittedRate)} />
          <StatRow
            label="Refused (throttled)"
            term="throttled"
            value={formatRate(stats.throttledRate)}
            tone={(stats.throttledRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
        </>
      );

    case 'breaker': {
      const state = stats.breakerState ?? 'closed';
      return (
        <>
          <StatRow
            label="Circuit"
            term="breaker"
            value={
              state === 'open'
                ? 'OPEN, failing fast'
                : state === 'half-open'
                  ? 'probing'
                  : 'closed'
            }
            tone={
              state === 'open'
                ? 'is-danger'
                : state === 'half-open'
                  ? 'is-warn'
                  : undefined
            }
          />
          <StatRow
            label="Downstream errors, windowed"
            value={formatPct(stats.breakerErrorRate)}
            tone={toneClass(healthOfErr(stats.breakerErrorRate))}
          />
          {state === 'open' && (
            <StatRow label="Probes again in" value={formatMs(stats.openRemainingMs)} />
          )}
          <StatRow
            label="Failing fast"
            value={formatRate(stats.rejectedRate)}
            tone={(stats.rejectedRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
          <StatRow
            label="Times tripped"
            term="breaker"
            value={formatCount(stats.breakerTrips)}
          />
        </>
      );
    }

    case 'sidecar': {
      const state = stats.breakerState ?? 'closed';
      return (
        <>
          <StatRow
            label="Upstream"
            value={
              state === 'open'
                ? 'EJECTED'
                : state === 'half-open'
                  ? 'probing'
                  : 'proxying'
            }
            tone={
              state === 'open'
                ? 'is-danger'
                : state === 'half-open'
                  ? 'is-warn'
                  : undefined
            }
          />
          <StatRow
            label="Upstream failures"
            value={formatRate(stats.upstreamFailRate)}
          />
          <StatRow
            label="Consecutive failures"
            value={formatCount(stats.consecutiveFails)}
            tone={(stats.consecutiveFails ?? 0) > 0 ? 'is-warn' : undefined}
          />
          <StatRow
            label="Failing fast"
            value={formatRate(stats.rejectedRate)}
            tone={(stats.rejectedRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
          <StatRow
            label="Times ejected"
            term="outlier-ejection"
            value={formatCount(stats.breakerTrips)}
          />
        </>
      );
    }

    case 'websocket':
      return (
        <>
          <StatRow label="New connections" value={formatRate(stats.connectRate)} />
          <StatRow
            label="Connections refused"
            term="conn-refused"
            value={formatRate(stats.connectionRejectRate)}
            tone={(stats.connectionRejectRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    case 'lambda':
      return (
        <>
          <StatRow
            label="Cold starts"
            term="cold-start"
            value={formatPct(stats.coldStartRate)}
            tone={(stats.coldStartRate ?? 0) > 0.5 ? 'is-warn' : undefined}
          />
          <StatRow label="Running now" value={formatCount(stats.runningNow)} />
          <StatRow label="Warm and idle" value={formatCount(stats.warmIdle)} />
          <StatRow
            label="Throttled"
            value={formatRate(stats.throttledRate)}
            tone={(stats.throttledRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    case 'streambroker':
      return (
        <>
          <StatRow
            label="Worst group lag"
            term="consumer-lag"
            value={formatCount(stats.consumerLag)}
          />
          <StatRow label="Delivering" value={formatRate(stats.deliveryRate)} />
          <StatRow
            label="Lost to retention"
            term="retention"
            value={formatRate(stats.retentionDropRate)}
            tone={(stats.retentionDropRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    case 'pubsub':
      return (
        <>
          <StatRow
            label="Subscribers"
            term="fan-out"
            value={formatCount(stats.fanout)}
          />
          <StatRow label="Delivering" value={formatRate(stats.deliveryRate)} />
        </>
      );

    case 'apigateway':
      return (
        <>
          <StatRow label="Admitted" value={formatRate(stats.admittedRate)} />
          <StatRow
            label="Refused (throttled)"
            term="throttled"
            value={formatRate(stats.throttledRate)}
            tone={(stats.throttledRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
          <StatRow
            label="Refused (bad auth)"
            term="unauthorized"
            value={formatRate(stats.authRejectRate)}
            tone={(stats.authRejectRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
        </>
      );

    case 'db':
      return (
        <>
          <StatRow label="Reads" value={formatRate(stats.readRate)} />
          <StatRow label="Writes" value={formatRate(stats.writeRate)} />
          <StatRow
            label="Lock wait per write"
            term="lock-contention"
            value={formatMs(stats.lockWaitMs)}
            tone={
              (stats.lockWaitMs ?? 0) > 2 * Math.max(1, stats.p50)
                ? 'is-danger'
                : (stats.lockWaitMs ?? 0) > 0.5 * Math.max(1, stats.p50)
                  ? 'is-warn'
                  : undefined
            }
          />
        </>
      );

    case 'objectstore':
      return (
        <StatRow
          label="Slowdowns, hot prefix"
          term="prefix-ceiling"
          value={formatRate(stats.slowdownRate)}
          tone={(stats.slowdownRate ?? 0) > 0 ? 'is-danger' : undefined}
        />
      );

    case 'coldstorage':
      return (
        <>
          <StatRow label="Restore jobs running" value={formatCount(stats.inFlight)} />
          <StatRow
            label="Refused, quota full"
            term="throttled"
            value={formatRate(stats.throttledRate)}
            tone={(stats.throttledRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    case 'transcoder':
      return (
        <StatRow
          label="Renditions out"
          term="rendition"
          value={formatRate(stats.outputRate)}
        />
      );

    case 'searchindex':
      return (
        <>
          <StatRow
            label="Stale searches"
            term="stale-search"
            value={formatPct(stats.staleSearchRate)}
            tone={(stats.staleSearchRate ?? 0) > 0.2 ? 'is-warn' : undefined}
          />
          <StatRow label="Searches" value={formatRate(stats.searchRate)} />
          <StatRow label="Index writes" value={formatRate(stats.indexWriteRate)} />
        </>
      );

    case 'timeseriesdb':
      return (
        <>
          <StatRow label="Appends" value={formatRate(stats.appendRate)} />
          <StatRow
            label="Range queries"
            term="range-query"
            value={formatRate(stats.rangeQueryRate)}
          />
        </>
      );

    case 'graphdb':
      return (
        <StatRow
          label="Cost per traversal, measured"
          term="traversal-depth"
          value={formatMs(stats.traversalCostMs)}
        />
      );

    case 'vectordb':
      return (
        <StatRow
          label="Cost per query, measured"
          term="recall"
          value={formatMs(stats.queryCostMs)}
        />
      );

    case 'bulkhead':
      return (
        <>
          <StatRow
            label="Pool in use"
            value={`${formatCount(stats.bulkheadInFlight ?? 0)} of ${formatCount(stats.bulkheadLimit ?? 0)}`}
          />
          <StatRow
            label="Refused, pool full"
            term="bulkhead-full"
            value={formatRate(stats.bulkheadRejectedRate)}
            tone={(stats.bulkheadRejectedRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
          {config.bulkheadMode === 'wait' && (
            <>
              <StatRow
                label="Waiting to acquire"
                value={formatCount(stats.bulkheadWaiting ?? 0)}
              />
              <StatRow
                label="Last acquire wait, measured"
                value={
                  stats.bulkheadAcquireLatencyMs === undefined
                    ? NA
                    : formatMs(stats.bulkheadAcquireLatencyMs)
                }
              />
              <StatRow
                label="Acquire timeouts"
                value={formatRate(stats.bulkheadAcquireTimeoutRate)}
                tone={
                  (stats.bulkheadAcquireTimeoutRate ?? 0) > 0 ? 'is-danger' : undefined
                }
              />
            </>
          )}
        </>
      );

    case 'retryqueue':
      return (
        <>
          <StatRow label="Delivered" value={formatRate(stats.deliveredRate)} />
          <StatRow
            label="Redelivering"
            value={formatRate(stats.redeliveryRate)}
            tone={(stats.redeliveryRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
          <StatRow
            label="Dead-lettering"
            value={formatRate(stats.deadLetterRate)}
            tone={(stats.deadLetterRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
          <StatRow
            label="Dead letters, total"
            term="dead-letter"
            value={formatCount(stats.deadLetters)}
            tone={(stats.deadLetters ?? 0) > 0 ? 'is-warn' : undefined}
          />
        </>
      );

    case 'writebehind':
      return (
        <>
          <StatRow
            label="Dirty writes held"
            term="dirty-write"
            value={formatCount(stats.dirtyWrites)}
          />
          <StatRow label="Flushing" value={formatRate(stats.flushedRate)} />
          <StatRow
            label="Flushes failing"
            value={formatRate(stats.flushFailRate)}
            tone={(stats.flushFailRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    case 'edgecompute':
      return (
        <>
          <StatRow
            label="Answered at the edge"
            value={formatRate(stats.edgeHandledRate)}
          />
          <StatRow
            label="Passed to origin"
            value={formatRate(stats.passedThroughRate)}
          />
          <StatRow
            label="Killed by the CPU budget"
            term="cpu-budget"
            value={formatRate(stats.cpuExceededRate)}
            tone={(stats.cpuExceededRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
        </>
      );

    case 'loadshedder':
      return (
        <>
          <StatRow
            label="High priority admitted"
            value={formatRate(stats.highAdmittedRate)}
          />
          <StatRow
            label="Low priority admitted"
            value={formatRate(stats.lowAdmittedRate)}
          />
          <StatRow
            label="Low priority dropped"
            term="deprioritized"
            value={formatRate(stats.lowSheddedRate)}
            tone={(stats.lowSheddedRate ?? 0) > 0 ? 'is-warn' : undefined}
          />
          <StatRow
            label="High priority dropped"
            value={formatRate(stats.highSheddedRate)}
            tone={(stats.highSheddedRate ?? 0) > 0 ? 'is-danger' : undefined}
          />
        </>
      );

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Multi-selection helpers
 * ------------------------------------------------------------------ */

/** Read a config field, falling back to the kind's own default. */
function readField(node: SimNode, field: Field): number {
  const v = node.config[field];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const d = defaultConfig(node.kind)[field];
  return typeof d === 'number' && Number.isFinite(d) ? d : 0;
}

/**
 * The common value of `field` across every node, or null when they
 * disagree. Null is what drives the `mixed` display — a multi-edit must
 * never invent a value that no selected node actually holds.
 */
function commonValue(nodes: readonly SimNode[], field: Field): number | null {
  if (nodes.length === 0) return null;
  const first = readField(nodes[0]!, field);
  for (let i = 1; i < nodes.length; i += 1) {
    if (readField(nodes[i]!, field) !== first) return null;
  }
  return first;
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

export interface InspectorProps {
  /**
   * The single selected node, or null. Unchanged, so the existing shell
   * call site keeps working exactly as it does today.
   */
  node: SimNode | null;
  stats: NodeStats | null;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  /**
   * Fields a challenge is holding still, or undefined outside one.
   *
   * A brief fixes the properties of the work (how long a query takes, how
   * uneven it is) and leaves every design decision editable. See
   * FIXED_DURING_CHALLENGE in sim/challenge.ts for why that line sits where
   * it does.
   */
  lockedFields?: readonly string[];

  /* ---- multi-selection: all optional, all additive ---------------- *
   * The canvas rewrite made a multi-selection reachable, but the shell
   * still resolves a selection of one down to `node`. These props let it
   * hand over the whole selection instead, WITHOUT any of them being
   * required — omit them and the panel behaves exactly as before.
   * ------------------------------------------------------------------ */

  /**
   * Every selected node. When this holds two or more, it takes precedence
   * over `node` and the panel renders the multi-selection view.
   */
  selectedNodes?: readonly SimNode[];
  /** Count of selected EDGES, for the summary line. Nodes come from above. */
  selectedEdgeCount?: number;
  /**
   * Apply one config patch to many nodes at once. Optional: without it a
   * multi-selection is still summarised, just not editable.
   */
  onChangeMany?: (ids: readonly string[], patch: Partial<NodeConfig>) => void;
  /** Delete the whole selection. Falls back to per-node `onDelete`. */
  onDeleteMany?: (ids: readonly string[]) => void;
}

export function Inspector({
  node,
  stats,
  onChange,
  onDelete,
  onRename,
  lockedFields,
  selectedNodes,
  selectedEdgeCount = 0,
  onChangeMany,
  onDeleteMany,
}: InspectorProps) {
  /**
   * The selection this panel is actually describing. `selectedNodes` wins
   * when it carries a real multi-selection; otherwise the panel falls back
   * to the single `node` prop the shell passes today.
   */
  const nodes = useMemo<readonly SimNode[]>(() => {
    if (selectedNodes && selectedNodes.length > 0) return selectedNodes;
    return node ? [node] : [];
  }, [selectedNodes, node]);

  const multi = nodes.length > 1;

  /* Nothing selected. Edges may still be, so the empty state reports that
     rather than claiming the canvas selection is empty when it is not. */
  if (nodes.length === 0) {
    return (
      <aside className="ins" aria-label="Inspector">
        <div className="ins-scroll scroll">
          {selectedEdgeCount > 0 ? (
            <>
              <p className="ins-empty">
                {selectedEdgeCount === 1
                  ? '1 connection selected.'
                  : `${selectedEdgeCount} connections selected.`}
              </p>
              <p className="ins-empty ins-empty-hint">
                Connections have nothing to configure. Press Delete to remove them.
              </p>
            </>
          ) : (
            <p className="ins-empty">
              Select a component on the canvas and its settings will appear here.
            </p>
          )}
        </div>
      </aside>
    );
  }

  if (multi) {
    return (
      <MultiInspector
        nodes={nodes}
        edgeCount={selectedEdgeCount}
        onChange={onChange}
        onChangeMany={onChangeMany}
        onDelete={onDelete}
        onDeleteMany={onDeleteMany}
      />
    );
  }

  return (
    <SingleInspector
      node={nodes[0]!}
      stats={stats}
      onChange={onChange}
      onDelete={onDelete}
      onRename={onRename}
      lockedFields={lockedFields}
    />
  );
}

/* ================================================================== *
 * STRUCTURE PANELS
 *
 * What a component is MADE OF, in the Inspector's own voice. The canvas draws
 * this; these panels say it in words and give the exact numbers the drawing
 * can only approximate — a stack caps at five cards, but "23 instances" is
 * always precise here.
 * ================================================================== */

/**
 * The autoscaler, as a sentence a student can read.
 *
 * This component was the origin of the whole complaint: it is a box wired to
 * another box that silently mutates a number, and nothing anywhere said what
 * it was doing. The engine exposes everything needed to narrate it —
 * `watchedId`, `watchedUtil`, `setpoint`, `targetInstances`,
 * `watchedInstances`, `pendingInstances`, `scalePhase`, `phaseRemainingMs` —
 * and the whole point of this panel is that a student never has to infer the
 * controller's state from a fleet size changing on its own.
 *
 * The phase line is the most important part, because it answers the question
 * a student actually asks: "it is overloaded, why is the autoscaler not doing
 * anything?" The honest answers are "it is still measuring", "it already
 * acted and the machines are booting", and "it is waiting out its cooldown",
 * and each of those is a real lesson about why real autoscalers lag.
 */
function AutoscalerPanel({ stats }: { stats: NodeStats }) {
  const phase = stats.scalePhase;
  if (!phase) return null;

  const watching = stats.watchedId;
  const have = stats.watchedInstances ?? 0;
  const want = stats.targetInstances ?? have;
  const booting = stats.pendingInstances ?? 0;
  const util = stats.watchedUtil ?? 0;
  const setpoint = stats.setpoint ?? 0;
  const secs = Math.max(0, Math.round((stats.phaseRemainingMs ?? 0) / 100) / 10);

  /* Each phase gets a plain-language line. Only 'steady' is silent about
     time, because it is the only one that is not waiting for anything. */
  const phaseText =
    phase === 'observing'
      ? `Still measuring. It will not act for another ${secs}s.`
      : phase === 'warming'
        ? `${formatCount(booting)} more booting. They start serving in ${secs}s.`
        : phase === 'cooldown'
          ? `Just acted. It will not act again for ${secs}s.`
          : 'Holding steady. Load does not call for a change.';

  if (!watching) {
    return (
      <Section title="What it is doing">
        <p className="ins-blurb">
          Not wired to anything yet. Draw a connection from this autoscaler to the
          component it should scale, and it will start watching it.
        </p>
      </Section>
    );
  }

  /* Wired to something with no fleet to resize. Reported rather than left
     silent: the controller reads the load correctly and then cannot act, and
     a panel that showed only the utilisation would look like a bug. Saying so
     is also the lesson, because the reason an object store has no instance
     count is that a managed blob store is not a pool of machines you can add
     to when a prefix melts. */
  if (stats.watchedUnscalable) {
    return (
      <Section title="What it is doing">
        <p className="ins-blurb">
          Watching <strong>{watching}</strong>, which has no instances to add or remove.
          This autoscaler cannot help it.
        </p>
        <div className="ins-stats">
          <StatRow
            label="It is at"
            value={formatPct(util)}
            tone={toneClass(healthOfLoad(util))}
          />
        </div>
        <p className="ins-hint">
          A managed store is one logical service rather than a pool of machines, so
          there is no fleet to grow. If it is overloaded, the answer is spreading the
          load across its keyspace rather than adding capacity.
        </p>
      </Section>
    );
  }

  return (
    <Section title="What it is doing">
      <p className="ins-blurb">
        Watching <strong>{watching}</strong>, aiming to keep it at{' '}
        <strong>{formatPct(setpoint)}</strong> busy.
      </p>
      <div className="ins-stats">
        <StatRow
          label="It is at"
          value={formatPct(util)}
          tone={toneClass(healthOfLoad(util))}
        />
        <StatRow label="Instances running" term="instances" value={formatCount(have)} />
        {want !== have && (
          <StatRow
            label="Instances wanted"
            term="autoscaler"
            value={formatCount(want)}
          />
        )}
        {booting > 0 && (
          <StatRow label="Booting now" value={formatCount(booting)} tone="is-warn" />
        )}
      </div>
      <p className={phase === 'warming' ? 'ins-hint is-warn' : 'ins-hint'}>
        {phaseText}
      </p>
    </Section>
  );
}

/**
 * How long a calmer state must hold before a hint reflecting a worse one
 * changes. Long enough to ride out a signal that flips on every 10Hz
 * snapshot, short enough that a hint does not outstay what it describes.
 */
const HINT_HOLD_MS = 1500;

/**
 * `on`, but turning off only after it has stayed off for HINT_HOLD_MS.
 *
 * For a hint that appears when a noisy signal crosses a line: it shows the
 * moment the signal does, and does not blink out each time the signal dips
 * back for a single snapshot.
 */
function useLingering(on: boolean): boolean {
  const [held, setHeld] = useState(on);
  // Turning on takes effect during render, so it shows this pass.
  if (on && !held) setHeld(true);
  useEffect(() => {
    if (on) return;
    const t = setTimeout(() => setHeld(false), HINT_HOLD_MS);
    return () => clearTimeout(t);
  }, [on]);
  return on || held;
}

type QueueHintState = 'idle' | 'queued' | 'shedding';

const QUEUE_HINT_RANK: Record<QueueHintState, number> = {
  idle: 0,
  queued: 1,
  shedding: 2,
};

/**
 * The queue hint state, escalating at once but calming only reluctantly.
 *
 * A queue whose consumers roughly match its producers flips between 0 and 1
 * waiting item on every 10Hz snapshot, and a full one flips in and out of
 * shedding the same way. Following that directly makes the hint flicker. A
 * worse state shows immediately; a better one waits until it has held for a
 * continuous HINT_HOLD_MS. The shed rate is held with the state so a
 * lingering "turning away" message keeps the last real rate instead of 0/s.
 */
function useQueueHint(
  state: QueueHintState,
  shedRate: number,
): { state: QueueHintState; shedRate: number } {
  const [held, setHeld] = useState({ state, shedRate });
  const escalating = QUEUE_HINT_RANK[state] >= QUEUE_HINT_RANK[held.state];

  // A same-or-worse state takes over during render, so it shows this pass
  // and the rate stays live; React re-runs the render before committing.
  if (escalating && (held.state !== state || held.shedRate !== shedRate)) {
    setHeld({ state, shedRate });
  }

  // A calmer state only lands after holding for HINT_HOLD_MS. The
  // timer restarts only when the target state changes, not on a new rate.
  useEffect(() => {
    if (escalating) return;
    const t = setTimeout(() => setHeld({ state, shedRate: 0 }), HINT_HOLD_MS);
    return () => clearTimeout(t);
  }, [escalating, state]);

  return escalating ? { state, shedRate } : held;
}

/**
 * The replica set's split between the primary and the read pool.
 *
 * Both of its signals are noisy: stale reads come and go with every lagging
 * read, and the primary hovers around the bottleneck threshold. So nothing
 * here is added or removed as they change. The stale-read row always shows
 * (0% is a real reading), and the two hints share one slot sized to the
 * taller of them, like the queue hint. When both apply, the bottleneck
 * warning wins: the stale share is still on the row above it.
 */
function ReplicaSetSection({ per, stats }: { per: number[]; stats: NodeStats }) {
  // Index 0 is the primary and reports the WRITE pool; the rest share the
  // read pool. Averaging them together is what hides a write bottleneck.
  const primary = per[0] ?? 0;
  const reads = per.slice(1);
  const readAvg = reads.length ? reads.reduce((a, b) => a + b, 0) / reads.length : 0;
  // Lingering keeps the slot from flicking between messages, not just from
  // moving: a hint swaps only after its signal has settled.
  const writeBound = useLingering(primary - readAvg > 0.4);
  const stale = useLingering(stats.staleReadRate > 0);
  const hint = writeBound ? 'write-bound' : stale ? 'stale' : null;
  return (
    <Section title="Across the set">
      <div className="ins-stats">
        <StatRow
          label="Primary (writes)"
          value={formatPct(primary)}
          tone={toneClass(healthOfLoad(primary))}
        />
        <StatRow
          label="Read replicas"
          term="read-replica"
          value={formatCount(reads.length)}
        />
        <StatRow
          label="Read replicas, average"
          value={formatPct(readAvg)}
          tone={toneClass(healthOfLoad(readAvg))}
        />
        <StatRow
          label="Reads served stale"
          term="stale-read"
          value={formatPct(stats.staleReadRate)}
          tone={toneClass(healthOfErr(stats.staleReadRate))}
        />
      </div>
      <div className="ins-hint-stack">
        <p className="ins-hint is-warn" data-active={hint === 'write-bound'}>
          The primary is the bottleneck, not the replicas. Adding more read replicas
          will not help; every write still goes through the one primary.
        </p>
        <p className="ins-hint" data-active={hint === 'stale'}>
          Some reads are answered by a replica that has not caught up with the latest
          write yet. Lower the replication lag to reduce this.
        </p>
      </div>
    </Section>
  );
}

/**
 * Per-unit truth for the kinds that are genuinely several things.
 *
 * The headline is the SPREAD, not the mean, and for a shard that is the whole
 * lesson: measured at hotKeyFraction 0.85 across 8 partitions, the hottest
 * sat at 100% while the node mean read 17%. A student reading only the mean
 * concludes there is plenty of headroom at the exact moment one partition is
 * shedding. Printing hottest and coldest side by side makes the gap
 * unmissable.
 */
function UnitsPanel({ node, stats }: { node: SimNode; stats: NodeStats }) {
  const per = stats.perInstance;
  if (!per || per.length === 0) return null;

  if (node.kind === 'shard') {
    const hot = stats.maxShardUtilization;
    const cold = stats.minShardUtilization;
    // A hot key is not "one shard is busier"; it is one shard pinned while
    // the rest idle. The gap is the signature, so it is named as one.
    const skewed = hot - cold > 0.5;
    return (
      <Section title="Across the partitions">
        <div className="ins-stats">
          <StatRow label="Partitions" term="shard" value={formatCount(per.length)} />
          <StatRow
            label="Busiest one"
            value={formatPct(hot)}
            tone={toneClass(healthOfLoad(hot))}
          />
          <StatRow label="Quietest one" value={formatPct(cold)} />
          <StatRow label="Average" value={formatPct(stats.utilization)} />
        </div>
        {skewed && (
          <p className="ins-hint is-warn">
            Badly uneven. One partition is doing most of the work while the others sit
            idle. Adding shards will not help until the keys spread out.
          </p>
        )}
      </Section>
    );
  }

  if (node.kind === 'replica') return <ReplicaSetSection per={per} stats={stats} />;

  // service / worker / db / cache / lb / cdn: interchangeable machines.
  const booting = stats.instancesPending ?? 0;
  if (per.length <= 1 && booting === 0) return null;
  return (
    <Section title="The fleet">
      <div className="ins-stats">
        <StatRow label="Instances serving" value={formatCount(per.length)} />
        {booting > 0 && (
          <StatRow label="Booting now" value={formatCount(booting)} tone="is-warn" />
        )}
      </div>
      {booting > 0 && (
        <p className="ins-hint is-warn">
          These are not serving traffic yet. Requests can still fail while they boot;
          that gap is why capacity always lags a spike.
        </p>
      )}
    </Section>
  );
}

/**
 * A queue's backlog against the limit it sheds at.
 *
 * A queue reports zero utilisation by construction — it holds work, it does
 * not serve it — so the standard busy-meter is pinned empty while the backlog
 * runs away. Measured on async-workers at 2.5x: depth climbed 369 -> 946 ->
 * 2478 with utilisation at 0.00 throughout. Depth against limit is the only
 * reading that moves.
 */
function QueuePanel({ stats }: { stats: NodeStats }) {
  const limit = stats.queueLimit > 0 ? stats.queueLimit : 1;
  const depth = stats.queued;
  const fill = Math.min(1, depth / limit);
  const hint = useQueueHint(
    stats.shedRate > 0 ? 'shedding' : depth > 0 ? 'queued' : 'idle',
    stats.shedRate,
  );
  return (
    <Section title="The line">
      <div className="ins-util">
        <div className="ins-util-head">
          <span className="label">
            <Term id="backlog">How full it is</Term>
          </span>
          <span className="num num-md">
            {formatCount(depth)} / {formatCount(limit)}
          </span>
        </div>
        <Meter value={fill} tone={toneClass(healthOfLoad(fill))} />
      </div>
      {/* Every message is rendered in one grid cell so the stack always holds
          the tallest one's height at the current panel width. Only the active
          message is visible; switching states never moves the panel below. */}
      <div className="ins-hint-stack">
        <p className="ins-hint is-danger" data-active={hint.state === 'shedding'}>
          Full. It is turning away {formatRate(hint.shedRate)}. Work arriving now is
          being destroyed, not delayed. The consumers cannot keep up.
        </p>
        <p className="ins-hint" data-active={hint.state === 'queued'}>
          Work is waiting here because the consumers are slower than the producers. It
          drains once they catch up.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Single-node view
 * ------------------------------------------------------------------ */

function SingleInspector({
  node,
  stats,
  onChange,
  onDelete,
  onRename,
  lockedFields,
}: {
  node: SimNode;
  stats: NodeStats | null;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, label: string) => void;
  lockedFields?: readonly string[];
}) {
  const fields = FIELDS_BY_KIND[node.kind];
  const cfg = node.config;

  /** The node's name when the title field took focus; Escape restores it. */
  const labelAtFocusRef = useRef(node.label);

  // Derived ceiling: how many requests per second this node can finish if
  // every slot stays busy. Recomputed live as capacity/serviceMs move.
  const showCeiling = HAS_THROUGHPUT_CEILING.has(node.kind) && cfg.serviceMs > 0;
  /**
   * The ceiling is `instances x capacity` slots, not `capacity` alone.
   *
   * `capacity` is slots on ONE machine; the fleet's real parallelism is that
   * times the instance count, which is exactly what the engine's
   * effectiveCapacity() computes and what the autoscaler moves. Reading
   * capacity by itself reported a 5-instance service as having a fifth of the
   * throughput it actually has, and — worse — the number never changed when
   * the autoscaler scaled the fleet, which is the one moment a student is
   * looking at it.
   */
  const fleet = Math.max(1, Math.floor(stats?.instances ?? cfg.instances ?? 1));
  const maxThroughput = showCeiling ? fleet * cfg.capacity * (1000 / cfg.serviceMs) : 0;

  // Headroom answers "is this the bottleneck?" without reading a chart:
  // the ceiling divided by what is actually arriving. Below 1.0x the node
  // cannot keep up, which is why it is toned by the same load thresholds.
  const arrivals = stats?.arrivalRate ?? 0;
  const headroom =
    showCeiling && arrivals > 0 && maxThroughput > 0 ? maxThroughput / arrivals : null;

  // One suggestion, only once this node is actually the thing that cannot
  // keep up -- below 1.0x headroom, same threshold the "Spare capacity"
  // reading itself is toned by.
  const suggestion =
    headroom !== null && headroom < 1 ? suggestionFor(node.kind) : null;

  const serviceMsLabel =
    cfg.serviceMs < 10 ? cfg.serviceMs.toFixed(1) : String(Math.round(cfg.serviceMs));

  /* Group this kind's fields. A group with nothing in it is dropped, so a
     ratelimiter shows one group and a replica shows two — the filtering
     invariant is preserved because the groups only ever PARTITION the
     kind's own list, never extend it. */
  const grouped = FIELD_GROUPS.map((g) => ({
    title: g.title,
    fields: fields.filter((f) => g.fields.has(f)),
  })).filter((g) => g.fields.length > 0);

  return (
    <aside className="ins" aria-label="Inspector">
      <div className="ins-scroll scroll">
        <header className="ins-head">
          {/*
            Writes through per keystroke (the canvas label should follow the
            typing), but Escape reverts to the name the field had when focus
            arrived and leaves the field — the same contract as the canvas's
            double-click rename, which this used to disagree with: one rename
            surface cancelled on Escape, the other kept the half-typed name.
          */}
          <input
            className="ins-title"
            type="text"
            value={node.label}
            spellCheck={false}
            aria-label="Node name"
            onFocus={(e) => {
              labelAtFocusRef.current = e.currentTarget.value;
            }}
            onChange={(e) => onRename(node.id, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onRename(node.id, labelAtFocusRef.current);
                e.currentTarget.blur();
              }
            }}
          />
          {/*
            The kind name is where a student learns WHAT they have selected.
            It is also the one place a canvas readout's concepts can be
            explained: the node's own numbers live in <svg> and cannot carry
            a trigger, so the inspector carries them instead.
          */}
          {/* Shown only once it says something the name field does not.

              At the default the two are the same word: the field read
              "Sharded Store" and this eyebrow read "Sharded store" directly
              beneath it — the same two words, in two capitalisations, 20px
              apart. The kind only carries information once a student has
              renamed the node to something of their own, so that is when it
              appears. The glossary trigger is not lost either way: the blurb
              below always carries it. */}
          {node.label.trim().toLowerCase() !== KIND_NAME[node.kind].toLowerCase() && (
            <span className="label ins-kind">
              <Term id={KIND_TERM[node.kind]}>{KIND_NAME[node.kind]}</Term>
            </span>
          )}
        </header>

        <p className="ins-blurb">
          <Term id={KIND_TERM[node.kind]}>{KIND_NAME[node.kind]}</Term>.{' '}
          {KIND_BLURB[node.kind]}
        </p>

        {/* The headline meter, chosen per kind: utilisation where slots are
            real, tokens for a bucket, pool fill for a bulkhead, lag against
            retention for a broker, held connections for a websocket gateway,
            and nothing at all for the kinds whose own panel below carries
            the reading. See VitalsMeter. */}
        {stats ? <VitalsMeter kind={node.kind} stats={stats} cfg={cfg} /> : null}

        {/* WHAT THIS COMPONENT IS MADE OF.

            Placed directly under the busy-meter and above the knobs, because
            it is the reading that explains the meter. A shard's 17% average
            means something completely different once you can see one
            partition pinned at 100% underneath it. */}
        {stats && node.kind === 'autoscaler' && <AutoscalerPanel stats={stats} />}
        {stats && node.kind === 'queue' && <QueuePanel stats={stats} />}
        {stats && node.kind === 'cron' && <CronPanel stats={stats} />}
        {stats && node.kind === 'region' && <RegionPanel stats={stats} />}
        {stats && node.kind !== 'queue' && node.kind !== 'autoscaler' && (
          <UnitsPanel node={node} stats={stats} />
        )}

        {grouped.map((group) => (
          <Section key={group.title} title={group.title}>
            <div className="ins-fields">
              {group.fields.map((field) => {
                const spec = specFor(node.kind, field);
                const locked = lockedFields?.includes(field) ?? false;
                // Fields that only some kinds read are optional on NodeConfig,
                // so a node saved by an older build can be missing one. Fall
                // back to this kind's default rather than to the spec's
                // minimum, which would silently show the student a value that
                // is not the one the engine is actually running with.
                const value = readField(node, field);
                return spec.control === 'slider' ? (
                  <SliderRow
                    key={field}
                    spec={spec}
                    value={value}
                    locked={locked}
                    onChange={(v) => onChange(node.id, { [field]: v })}
                  />
                ) : spec.control === 'choice' ? (
                  <ChoiceRow
                    key={field}
                    spec={spec}
                    value={node.config.bulkheadMode ?? 'reject'}
                    locked={locked}
                    onChange={(v) => onChange(node.id, { bulkheadMode: v })}
                  />
                ) : (
                  <NumberRow
                    key={field}
                    spec={spec}
                    value={value}
                    locked={locked}
                    onChange={(v) => onChange(node.id, { [field]: v })}
                  />
                );
              })}
            </div>
          </Section>
        ))}

        {showCeiling && (
          <Section title="What that works out to">
            <div className="ins-stats">
              <StatRow
                label="Most it can finish"
                term="capacity"
                value={formatRate(maxThroughput)}
              />
              <p className="ins-expr">
                {fleet > 1
                  ? `${formatCount(fleet)} instances x ${formatCount(cfg.capacity)} slots ÷ ${serviceMsLabel}ms each`
                  : `${formatCount(cfg.capacity)} at once ÷ ${serviceMsLabel}ms each`}
              </p>
              {headroom !== null && (
                <StatRow
                  label="Spare capacity"
                  term="headroom"
                  value={formatMultiple(headroom)}
                  tone={toneClass(healthOfLoad(arrivals / maxThroughput))}
                />
              )}
            </div>
          </Section>
        )}

        {suggestion && (
          <Section title="Suggested fix">
            <p className="ins-suggestion">{suggestion}</p>
          </Section>
        )}

        {/* Controllers (cron, autoscaler) serve nothing, ever: every generic
            row here is a hardwired zero for them, and ten rows of zeros are
            what made them read as broken. Their "What it is doing" panels
            above are their whole live story. */}
        {node.kind !== 'cron' && node.kind !== 'autoscaler' && (
          <Section title="Right now">
            {stats ? (
              <div className="ins-stats">
                {/* Gate kinds hold no work of their own: in-flight and queued
                    are structurally zero there and are dropped rather than
                    printed as dead rows. */}
                {!GATE_KINDS.has(node.kind) && (
                  <>
                    <StatRow
                      label="Being handled now"
                      value={formatCount(stats.inFlight)}
                    />
                    <StatRow
                      label="Waiting in line"
                      term={node.kind === 'queue' ? 'backlog' : 'queue-time'}
                      value={formatCount(stats.queued)}
                    />
                  </>
                )}
                <StatRow
                  label="Finishing"
                  term="throughput"
                  value={formatRate(stats.throughput)}
                />
                <StatRow
                  label="Arriving"
                  term="offered"
                  value={formatRate(stats.arrivalRate)}
                />
                <KindStatRows kind={node.kind} config={node.config} stats={stats} />
                <StatRow
                  label="Typical request"
                  term="p50"
                  value={formatMs(stats.p50)}
                />
                <StatRow
                  label="Slower requests"
                  term="p95"
                  value={formatMs(stats.p95)}
                />
                <StatRow
                  label="Slowest requests"
                  term="p99"
                  value={formatMs(stats.p99)}
                  tone={toneClass(healthOfLatency(stats.p99))}
                />
                <StatRow
                  label="Errors"
                  term="error-rate"
                  value={formatPct(stats.errorRate)}
                  tone={toneClass(healthOfErr(stats.errorRate))}
                />
                {stats.shedRate > 0 && (
                  <StatRow
                    label="Turned away"
                    term="shed"
                    value={formatRate(stats.shedRate)}
                    tone="is-danger"
                  />
                )}
                {stats.timeoutRate > 0 && (
                  <StatRow
                    label="Timed out"
                    term="timeout"
                    value={formatRate(stats.timeoutRate)}
                    tone="is-danger"
                  />
                )}
                <StatRow
                  label="Completed, total"
                  value={formatCount(stats.totalCompleted)}
                />
                <StatRow label="Failed, total" value={formatCount(stats.totalFailed)} />
              </div>
            ) : (
              <p className="ins-blurb">
                Nothing has reached this component yet. Press Play and it will start
                reporting.
              </p>
            )}
          </Section>
        )}

        {/* Last, because it is context rather than a knob. A student is here
            to change capacity and service time; what the thing is called at
            a cloud vendor is worth knowing and worth reading after. */}
        <VendorPanel
          nodeId={node.id}
          kind={node.kind}
          config={node.config}
          onChange={(patch) => onChange(node.id, patch)}
        />
      </div>

      <div className="ins-foot">
        <button
          type="button"
          className="btn btn-danger ins-delete"
          onClick={() => onDelete(node.id)}
        >
          Delete component
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Multi-selection view
 *
 * Two cases, and they are genuinely different:
 *
 *   SAME KIND    every selected node exposes the same knobs, so the panel
 *                shows those knobs and writes each edit to all of them.
 *                A knob the nodes disagree on reads `mixed` and stays
 *                mixed until the student moves it — moving it is the act
 *                that means "make them all this".
 *
 *   MIXED KINDS  there is no shared knob list, so offering one would be a
 *                lie. The panel becomes a manifest: what is selected, how
 *                many of each, and the one action that always applies.
 * ------------------------------------------------------------------ */

function MultiInspector({
  nodes,
  edgeCount,
  onChange,
  onChangeMany,
  onDelete,
  onDeleteMany,
}: {
  nodes: readonly SimNode[];
  edgeCount: number;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
  onChangeMany?: (ids: readonly string[], patch: Partial<NodeConfig>) => void;
  onDelete: (id: string) => void;
  onDeleteMany?: (ids: readonly string[]) => void;
}) {
  const ids = useMemo(() => nodes.map((n) => n.id), [nodes]);

  /** Count per kind, in the order the kinds first appear in the selection. */
  const byKind = useMemo(() => {
    const counts = new Map<NodeKind, number>();
    for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    return [...counts.entries()];
  }, [nodes]);

  const sameKind = byKind.length === 1;
  const kind = sameKind ? byKind[0]![0] : null;

  /**
   * Write one patch to every selected node. Prefers the batch callback so
   * the shell can fold the edit into a single state update; falls back to
   * per-node calls, which is correct but produces N updates.
   */
  const applyAll = useCallback(
    (patch: Partial<NodeConfig>) => {
      if (onChangeMany) {
        onChangeMany(ids, patch);
        return;
      }
      for (const id of ids) onChange(id, patch);
    },
    [ids, onChange, onChangeMany],
  );

  const deleteAll = useCallback(() => {
    if (onDeleteMany) {
      onDeleteMany(ids);
      return;
    }
    for (const id of ids) onDelete(id);
  }, [ids, onDelete, onDeleteMany]);

  const fields = kind ? FIELDS_BY_KIND[kind] : [];
  const grouped = FIELD_GROUPS.map((g) => ({
    title: g.title,
    fields: fields.filter((f) => g.fields.has(f)),
  })).filter((g) => g.fields.length > 0);

  return (
    <aside className="ins" aria-label="Inspector">
      <div className="ins-scroll scroll">
        <header className="ins-head">
          <p className="ins-multi-title">
            <span className="num num-md">{formatCount(nodes.length)}</span>{' '}
            <span className="ins-multi-word">
              {nodes.length === 1 ? 'component' : 'components'}
            </span>
            {edgeCount > 0 ? (
              <>
                {' + '}
                <span className="num num-md">{formatCount(edgeCount)}</span>{' '}
                <span className="ins-multi-word">
                  {edgeCount === 1 ? 'connection' : 'connections'}
                </span>
              </>
            ) : null}
          </p>
          <span className="label ins-kind">
            {sameKind ? (
              <Term id={KIND_TERM[kind!]}>{KIND_NAME[kind!]}</Term>
            ) : (
              'Mixed selection'
            )}
          </span>
        </header>

        {/* The manifest. It is the whole content when kinds differ, and a
            useful confirmation of what you grabbed when they do not. */}
        <ul className="ins-manifest">
          {byKind.map(([k, n]) => (
            <li key={k} className="ins-manifest-row">
              <span className="row-k">{KIND_NAME[k]}</span>
              <span className="row-v">{formatCount(n)}</span>
            </li>
          ))}
        </ul>

        {sameKind ? (
          <>
            <p className="ins-blurb">
              Changing anything below applies it to all {formatCount(nodes.length)} of
              these. Where they currently disagree the value reads <em>mixed</em>, until
              you move it.
            </p>

            {grouped.map((group) => (
              <Section key={group.title} title={group.title}>
                <div className="ins-fields">
                  {group.fields.map((field) => {
                    const spec = specFor(kind!, field);
                    const shared = commonValue(nodes, field);
                    const mixed = shared === null;
                    /* When the nodes disagree, the control still needs a
                       position. It shows the FIRST node's value but labels
                       itself `mixed`, so nothing claims the others hold it —
                       and the moment the student moves it, the value becomes
                       real for every one of them. */
                    const value = shared ?? readField(nodes[0]!, field);
                    return spec.control === 'slider' ? (
                      <SliderRow
                        key={field}
                        spec={spec}
                        value={value}
                        mixed={mixed}
                        onChange={(v) => applyAll({ [field]: v })}
                      />
                    ) : spec.control === 'choice' ? (
                      <ChoiceRow
                        key={field}
                        spec={spec}
                        value={nodes[0]!.config.bulkheadMode ?? 'reject'}
                        onChange={(v) => applyAll({ bulkheadMode: v })}
                      />
                    ) : (
                      <NumberRow
                        key={field}
                        spec={spec}
                        value={value}
                        mixed={mixed}
                        onChange={(v) => applyAll({ [field]: v })}
                      />
                    );
                  })}
                </div>
              </Section>
            ))}
          </>
        ) : (
          <p className="ins-blurb">
            These are different kinds of component, so they have no settings in common.
            Select one on its own to configure it, or delete the whole selection below.
          </p>
        )}
      </div>

      <div className="ins-foot">
        <button type="button" className="btn btn-danger ins-delete" onClick={deleteAll}>
          Delete {formatCount(nodes.length)} selected
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * TrafficControl
 *
 * The RPS slider is the primary control of the app. The underlying range
 * is 1..5000, but a linear slider would spend 90% of its travel above
 * 500rps where nothing new happens. The position is mapped exponentially
 * so the low end -- where the interesting knee usually is -- is reachable.
 * ------------------------------------------------------------------ */

const RPS_MIN = 1;
const RPS_MAX = 5000;
const LOG_MIN = Math.log(RPS_MIN);
const LOG_MAX = Math.log(RPS_MAX);
/** Slider travel in discrete steps. Finer than 1-per-rps at the low end. */
const SLIDER_STEPS = 1000;

/** Slider position (0..SLIDER_STEPS) -> real requests per second. */
function positionToRps(pos: number): number {
  const t = pos / SLIDER_STEPS;
  const rps = Math.exp(LOG_MIN + t * (LOG_MAX - LOG_MIN));
  // Round to something a student can actually read and reproduce.
  if (rps < 20) return Math.round(rps);
  if (rps < 200) return Math.round(rps / 5) * 5;
  if (rps < 1000) return Math.round(rps / 10) * 10;
  return Math.round(rps / 50) * 50;
}

/** Real requests per second -> slider position (0..SLIDER_STEPS). */
function rpsToPosition(rps: number): number {
  const safe = Number.isFinite(rps) ? rps : RPS_MIN;
  const clamped = Math.min(RPS_MAX, Math.max(RPS_MIN, safe));
  const t = (Math.log(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return Math.round(t * SLIDER_STEPS);
}

/**
 * Scale marks, placed at their true log position rather than spread evenly.
 * An evenly-spaced 1/10/100/1k/5k row lies about where the thumb will land:
 * 1k sits at 69% of the travel, not 75%.
 */
const SCALE_MARKS = [1, 10, 100, 1000, 5000];

export interface TrafficControlProps {
  rps: number;
  onRpsChange: (rps: number) => void;
  running: boolean;
  onToggleRun: () => void;
  onStep: () => void;
  onReset: () => void;
  system: SystemStats;
  /** Requests actually lost per second, from the engine's per-reason counters. */
  lost: number;
  /**
   * True when the canvas has no components at all.
   *
   * The engine is right to report 100% errors here — traffic with nowhere to
   * go is traffic that is lost — but it is the wrong thing to SAY. A student
   * who has just cleared the canvas to start their own design was being met
   * with "Errors 100%, Dropped 5k/s" in red, directly above copy inviting
   * them to drag a component in. The measurements are suppressed rather than
   * faked: there is nothing to measure yet, so the bar says that instead.
   */
  empty: boolean;
  /**
   * No client on the canvas, so nothing is offering load.
   *
   * Separate from `empty`: a design can hold a database and a cache and still
   * have no traffic source, and the slider is just as inert there as on a
   * blank canvas. It writes `rps` onto client nodes, so with none to write to
   * it silently snapped back to where it started, which reads as a broken
   * control rather than an inapplicable one.
   */
  noTrafficSource: boolean;
}

export function TrafficControl({
  rps,
  onRpsChange,
  running,
  onToggleRun,
  onStep,
  onReset,
  system,
  lost,
  empty,
  noTrafficSource,
}: TrafficControlProps) {
  const sliderId = useId();

  const errTone = toneClass(healthOfErr(system.errorRate));

  // Traffic that actually FAILED, while it is failing. Deliberately not
  // `offered - goodput`: that gap is mostly in-flight work and is largest
  // during warm-up, so using it made a healthy system flash a red
  // "Dropped 10/s" next to an error rate of exactly zero. `errorRate` is
  // the engine's own fraction of requests that errored or were shed.
  const dropped = Number.isFinite(lost) ? Math.max(0, lost) : 0;
  const showDropped = dropped > 0.5;

  /**
   * p99 of WHAT? With zero goodput nothing is completing, so a latency
   * percentile does not exist — and "0ms" beside "Errors 100%" read as
   * "instantly fast" in the middle of a total outage (observed on the retry
   * storm preset). No data renders as the sentinel, never as a fake zero.
   */
  const p99 = system.p99 === 0 && system.goodputRps === 0 ? null : system.p99;
  const p99Tone = toneClass(healthOfLatency(p99));

  return (
    <div className="traffic">
      {/* Cause. The only thing on screen the student directly controls, and
          therefore the only input that gets a hero-sized number. */}
      <div className="traffic-load">
        <div className="traffic-load-head">
          {/*
            The <label> keeps its `for`, so clicking the word still focuses
            the slider; the <Term> only wraps the text inside it. Nesting the
            trigger the other way round would make the tooltip's own click
            target steal the label's activation.
          */}
          <label className="label" htmlFor={sliderId}>
            <Term id="offered">Offered load</Term>
          </label>
          <span className="traffic-load-readout">
            {noTrafficSource ? (
              /* Not "0". With no client there is no offered load to report,
                 and a confident zero in the app's darkest ink outranks the
                 faint note under the slider that explains why: a reader
                 drags, nothing happens, and the number tells them the number
                 is the answer. Saying what is missing puts the reason where
                 the eye already is. */
              <span className="traffic-load-none">No traffic source</span>
            ) : (
              <>
                {/* num-lg, not the hero. The slider's own value is feedback
                    the student just caused; p99 is the consequence they are
                    meant to watch, and it reads as the most important number
                    on screen only if it is the ONLY number at the hero
                    size. */}
                <span className="num num-lg">{formatRateBare(rps)}</span>
                <span className="label traffic-load-unit">
                  <Term id="rps">requests / sec</Term>
                </span>
              </>
            )}
          </span>
        </div>
        <div className="traffic-load-track">
          <input
            id={sliderId}
            className="slider"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={rpsToPosition(rps)}
            style={
              {
                '--fill-pct': fillPct(rpsToPosition(rps), 0, SLIDER_STEPS),
              } as React.CSSProperties
            }
            disabled={noTrafficSource}
            aria-valuetext={
              noTrafficSource
                ? 'No traffic source on the canvas'
                : `${Math.round(rps)} request${Math.round(rps) === 1 ? '' : 's'} per second`
            }
            onChange={(e) => onRpsChange(positionToRps(Number(e.currentTarget.value)))}
          />
          {noTrafficSource ? (
            /* The scale describes a range the slider cannot reach, so it is
               replaced by the reason rather than sitting under a dead
               control. Says what to do, not what went wrong. */
            <p className="traffic-scale-note">Add a client to send traffic.</p>
          ) : (
            <div className="traffic-scale" aria-hidden="true">
              {SCALE_MARKS.map((m) => (
                <span
                  key={m}
                  className="num traffic-scale-mark"
                  style={{ left: `${(rpsToPosition(m) / SLIDER_STEPS) * 100}%` }}
                >
                  {m >= 1000 ? `${m / 1000}k` : m}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="traffic-spacer" />

      {/* Effect. p99 is the number students should watch, so it carries the
          only other hero, toned by the same threshold as the chart line.

          Every metric slot is ALWAYS rendered, including "Dropped" at zero.
          It used to mount only once dropped traffic appeared, which meant
          Goodput and Errors jumped sideways at the exact moment a system
          started failing — motion arriving precisely when the student needs
          to read the numbers, not watch them move. */}
      <div className="traffic-headline">
        {empty ? (
          /* No components: nothing to measure. One quiet sentence, in the
             same slot the numbers occupy, rather than a row of red zeroes. */
          <p className="traffic-empty">
            Nothing to measure yet. Add a component to get started.
          </p>
        ) : (
          <>
            <div className="traffic-metric">
              <span className="label">
                System <Term id="p99">p99</Term>
              </span>
              <span className={p99Tone ? `num num-hero ${p99Tone}` : 'num num-hero'}>
                {formatMs(p99)}
              </span>
            </div>

            <div className="traffic-metric-group">
              <div className="traffic-metric">
                <span className="label">
                  <Term id="goodput">Goodput</Term>
                </span>
                <span className="num num-md">{formatRate(system.goodputRps)}</span>
              </div>
              <div className="traffic-metric">
                <span className="label">
                  <Term id="error-rate">Errors</Term>
                </span>
                <span className={errTone ? `num num-md ${errTone}` : 'num num-md'}>
                  {formatPct(system.errorRate)}
                </span>
              </div>
              <div className="traffic-metric">
                <span className="label">
                  <Term id="dropped">Dropped</Term>
                </span>
                <span className={showDropped ? 'num num-md is-danger' : 'num num-md'}>
                  {formatRate(dropped)}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      {/*
        The transport. Icon-only, which is the settled convention for these
        three actions everywhere from video players to debuggers; the words
        move into aria-label and the title, where the shortcut is printed
        beside the action the same way the undo pair prints Ctrl+Z.

        role="group" with a name, so a screen reader announces "Simulation
        transport" once and then three short labels, instead of three
        orphaned buttons.
      */}
      <div className="traffic-actions" role="group" aria-label="Simulation transport">
        <button
          type="button"
          className="btn btn-icon transport-toggle"
          onClick={onToggleRun}
          aria-label={running ? 'Pause' : 'Play'}
          title={running ? 'Pause (Space)' : 'Play (Space)'}
        >
          {/* No aria-pressed. The label itself flips Pause <-> Play, so the
              button already states its effect; adding a pressed state made a
              running simulation announce "Pause, pressed", which reads as
              ALREADY paused, the opposite of the truth.

              ONE button, two glyphs, in a fixed-width .btn-icon box: the
              old text label resized the button every time the state
              flipped. Both glyphs are drawn filled because that is how a
              transport control states "this is the go/stop switch", and
              the fill is what marks it primary now that the accent surface
              is gone (an icon in a coloured box is on the ban list). */}
          {running ? (
            <Pause size={18} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play
              size={18}
              strokeWidth={1.5}
              fill="currentColor"
              aria-hidden="true"
              /* A triangle's visual mass sits left of its bounding-box
                 centre; the class nudges it right so play and pause land
                 on the same optical centre and the swap does not flicker. */
              className="transport-play"
            />
          )}
        </button>
        {/* Stepping is only meaningful against a stopped clock, and it
            pauses on its own, so the tooltip states what it will do. */}
        <button
          type="button"
          className="btn btn-icon"
          onClick={onStep}
          aria-label="Step one tick"
          title="Step one tick (S)"
        >
          <StepForward size={16} aria-hidden="true" />
        </button>
        {/* No shortcut: reset throws away the run's numbers, and an action
            with a cost is exactly the one that should require the pointer. */}
        <button
          type="button"
          className="btn btn-icon"
          onClick={onReset}
          aria-label="Reset simulation"
          title="Reset simulation"
        >
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
