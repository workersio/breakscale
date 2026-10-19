import type { Annotation, AnnotationFont, Note, Section } from '../sim/annotations';
import { ANNOTATION_FONTS, SECTION_TONE_COUNT } from '../sim/annotations';
import { defaultConfig } from '../sim/presets';
import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from '../sim/types';
import { TRAFFIC_PATTERNS } from '../sim/types';

/* ------------------------------------------------------------------ *
 * Share wire format, generation 3.
 *
 * A share link carries a whole design in a URL fragment, and the fragment
 * has to fit where links get pasted: Discord, Slack, a tweet, a mail
 * client that stops at 2000 characters. Generation 2 was the readable
 * `Topology` JSON with default config fields stripped and deflated, and
 * the largest worked examples (about twenty nodes with notes) ran past
 * 2400 characters under it. This format carries the same designs in
 * about 1450 (`tools/share-bench.ts` prints the table).
 *
 * This module is a SEPARATE representation, chosen for size, and nothing
 * outside `share.ts` sees it. The application keeps `SimNode`, `SimEdge`
 * and `Annotation` exactly as they are; `packTopology` turns one of those
 * into bytes and `unpackTopology` turns the bytes back. Every decision
 * below is a fact about how much information a field really carries:
 *
 *   - Node ids are not sent. They are `kind-N` counters minted by the
 *     editor (or short handles an example author typed), never shown to
 *     the reader and never hashed by the engine, so they are regenerated
 *     on the way out. Edges name nodes by INDEX into the node list.
 *   - Edge and annotation ids are likewise regenerated: the shell mints
 *     `from->to` and `note-N` itself and dedupes against what is on the
 *     canvas, so a regenerated id is indistinguishable from a minted one.
 *   - A node kind is one small integer from a fixed table.
 *   - Config is a bitmask over a per-kind field list followed by only the
 *     values that differ from `defaultConfig(kind)`. Property names never
 *     travel; both sides know them.
 *   - Numbers travel as a decimal mantissa and exponent in one varint,
 *     which is exact for anything the sliders produce and costs one or
 *     two bytes for the values that actually occur. Anything that does
 *     not fit falls back to a full float64, so no value is ever rounded.
 *   - Node coordinates are rounded to whole pixels, as generation 2 did;
 *     half a pixel is not visible layout.
 *   - Optional edge fields and note styling are presence bits.
 *
 * The byte layout is a PROTOCOL. The tables below (`KINDS`, `FIELDS`,
 * `SCHEMA`) are frozen for generation 3: append only, never reorder, and
 * an incompatible change is a new generation with a new prefix. They are
 * deliberately literals rather than imports of the application's own
 * lists, which are free to change order whenever the palette does.
 *
 * Encoding is deterministic: the same topology always yields the same
 * bytes, so a link can be compared, cached or hashed.
 * ------------------------------------------------------------------ */

/** Thrown inside the decoder for any structural problem; never escapes. */
class WireError extends Error {}

/* ---------------- protocol tables ---------------- */

/**
 * Kind dictionary. Index is the wire value. Append only.
 */
const KINDS = [
  'client',
  'lb',
  'service',
  'cache',
  'db',
  'queue',
  'worker',
  'autoscaler',
  'region',
  'cdn',
  'ratelimiter',
  'breaker',
  'replica',
  'shard',
  'objectstore',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'coldstorage',
  'vectordb',
  'streambroker',
  'pubsub',
  'websocket',
  'apigateway',
  'sidecar',
  'lambda',
  'cron',
  'bulkhead',
  'retryqueue',
  'transcoder',
  'edgecompute',
  'writebehind',
  'loadshedder',
] as const satisfies readonly NodeKind[];

/** Every kind the wire can name; exported so a test can prove it is complete. */
export const WIRE_KINDS: readonly NodeKind[] = KINDS;

/**
 * The label a node of each kind is born with, as of generation 3. A node
 * still carrying it sends nothing for its label. This is a frozen copy,
 * not the palette's live table: if the app renames "Load Balancer" one
 * day, a link written before that must still open with the words its
 * author saw, so the wire's idea of the default cannot follow the app's.
 */
const LABELS: Readonly<Record<NodeKind, string>> = {
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

type ConfigField = keyof NodeConfig;

/**
 * Every config field the wire can carry, in wire order. A field a kind's
 * schema does not list is still encodable, as an "extra" keyed by this
 * index, so a design carrying an unusual field is never silently
 * trimmed. Append only.
 */
const FIELDS = [
  'capacity',
  'instances',
  'serviceMs',
  'serviceCv',
  'queueLimit',
  'hitRate',
  'errorRate',
  'timeoutMs',
  'retries',
  'rps',
  'traffic',
  'trafficPeriodS',
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
  'replicaCount',
  'replicationLagMs',
  'readFraction',
  'shardCount',
  'shardCapacity',
  'hotKeyFraction',
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
  'flushDelayMs',
  'edgeShare',
  'lowPriorityShare',
  'priorityReserve',
  'lockMs',
  'prefixRps',
  'renditions',
  'cpuMsCap',
  'bulkheadMode',
  'acquireQueueMax',
  'acquireTimeoutMs',
] as const satisfies readonly ConfigField[];

/** Every field the wire can carry; exported so a test can prove it is complete. */
export const WIRE_FIELDS: readonly ConfigField[] = FIELDS;

const FIELD_INDEX = new Map<string, number>(FIELDS.map((f, i) => [f, i]));

/**
 * The knobs shared by every request-path kind, in the order a design is
 * most likely to override them. Low bits are cheap: a mask that only
 * touches the first seven fields is one byte.
 */
const COMMON: readonly ConfigField[] = [
  'capacity',
  'serviceMs',
  'queueLimit',
  'instances',
  'serviceCv',
  'timeoutMs',
  'retries',
  'errorRate',
  'hitRate',
  'rps',
];

/**
 * Per-kind field list: the mask's bit i is field `SCHEMA[kind][i]`. Each
 * kind lists its own knobs first, then the common ones. Every field the
 * engine reads for that kind is here so the extras path is only ever
 * taken by a design carrying a field its kind does not use.
 */
const SCHEMA: Record<NodeKind, readonly ConfigField[]> = {
  client: [
    'rps',
    'timeoutMs',
    'retries',
    'traffic',
    'trafficPeriodS',
    'capacity',
    'serviceMs',
    'queueLimit',
    'instances',
    'serviceCv',
    'errorRate',
    'hitRate',
  ],
  lb: COMMON,
  service: COMMON,
  cache: ['hitRate', ...COMMON.filter((f) => f !== 'hitRate')],
  db: ['readFraction', 'lockMs', ...COMMON],
  queue: COMMON,
  worker: COMMON,
  autoscaler: [
    'targetUtil',
    'minCapacity',
    'maxCapacity',
    'cooldownMs',
    'scaleStepPct',
    'warmupMs',
    ...COMMON,
  ],
  region: ['regions', 'activeRegion', 'failoverMs', ...COMMON],
  cdn: ['hitRate', ...COMMON.filter((f) => f !== 'hitRate')],
  ratelimiter: ['rateLimitRps', 'burst', ...COMMON],
  breaker: ['errorThreshold', 'windowMs', 'openMs', 'halfOpenProbes', ...COMMON],
  replica: ['replicaCount', 'replicationLagMs', 'readFraction', ...COMMON],
  shard: ['shardCount', 'shardCapacity', 'hotKeyFraction', ...COMMON],
  objectstore: ['prefixRps', ...COMMON],
  searchindex: ['readFraction', 'indexMs', 'indexLagMs', ...COMMON],
  timeseriesdb: ['rangeQueryFraction', 'rangeQueryMs', ...COMMON],
  graphdb: ['traversalDepth', ...COMMON],
  coldstorage: COMMON,
  vectordb: ['indexSizeK', 'recallTarget', ...COMMON],
  streambroker: ['partitions', ...COMMON],
  pubsub: COMMON,
  websocket: ['connectionMs', ...COMMON],
  apigateway: ['rateLimitRps', 'burst', 'authFailRate', ...COMMON],
  sidecar: ['outlierAfter', 'openMs', ...COMMON],
  lambda: ['coldStartMs', 'keepWarmMs', 'maxConcurrency', ...COMMON],
  cron: ['intervalMs', 'batchSize', ...COMMON],
  // Appended after COMMON: a mask bit is the field's position here, so
  // fields added to a kind go at the end or an older link's bits land on
  // the wrong knobs.
  bulkhead: [
    'bulkheadMax',
    ...COMMON,
    'bulkheadMode',
    'acquireQueueMax',
    'acquireTimeoutMs',
  ],
  retryqueue: COMMON,
  transcoder: ['renditions', ...COMMON],
  edgecompute: ['edgeShare', 'cpuMsCap', ...COMMON],
  writebehind: ['flushDelayMs', ...COMMON],
  loadshedder: [
    'rateLimitRps',
    'burst',
    'lowPriorityShare',
    'priorityReserve',
    ...COMMON,
  ],
};

/** Per-kind schema; exported for the size benchmark and its tests. */
export const WIRE_SCHEMA: Readonly<Record<NodeKind, readonly ConfigField[]>> = SCHEMA;

/* ---------------- edge and annotation bits ---------------- */

const EDGE_CONTROL = 1 << 0;
const EDGE_WEIGHT = 1 << 1;
const EDGE_LATENCY = 1 << 2;
const EDGE_BANDWIDTH = 1 << 3;
const EDGE_LOSS = 1 << 4;
const EDGE_KNOWN =
  EDGE_CONTROL | EDGE_WEIGHT | EDGE_LATENCY | EDGE_BANDWIDTH | EDGE_LOSS;

/** Annotation header, bit 0: 0 is a note, 1 is a section. */
const ANN_SECTION = 1 << 0;

// Note header bits above the kind bit.
const NOTE_SIZE_SHIFT = 1; // two bits: 0 sm, 1 md, 2 lg
const NOTE_FONT_SHIFT = 3; // three bits: 0 unset, else ANNOTATION_FONTS[n - 1]
const NOTE_COLOR = 1 << 6;
const NOTE_TONE = 1 << 7;
const NOTE_BOLD = 1 << 8;
const NOTE_ITALIC = 1 << 9;
const NOTE_UNDERLINE = 1 << 10;
const NOTE_SCALE = 1 << 11;
const NOTE_AUTO = 1 << 12;
const NOTE_KNOWN = (1 << 13) - 1;

const NOTE_SIZES = ['sm', 'md', 'lg'] as const;

// Section header bits above the kind bit.
const SECTION_TONE_SHIFT = 1; // four bits, 0..12
const SECTION_COLOR = 1 << 5;
const SECTION_KNOWN = (1 << 6) - 1;

/* ---------------- numbers ---------------- */

/**
 * A number on the wire is one varint, `zigzag(mantissa) * 8 + tag`, where
 * the tag says which power of ten the mantissa is scaled by:
 *
 *   0        x1          25, 64, 8
 *   1..4     x10^-tag    0.6, 0.92, 0.005
 *   5        x100        2500
 *   6        x1000       5000, 30000
 *   7        a raw little-endian float64 follows
 *
 * The powers were picked from what a design actually holds: fractions
 * with a few decimals, and millisecond and message counts that are round
 * thousands. With them, nearly every value in every worked example is one
 * or two bytes. Anything else (a fifth decimal place, a million, one
 * third) takes the nine-byte escape and is still exact.
 */
const NUM_FLOAT = 7;
const NUM_HUNDREDS = 5;
const NUM_THOUSANDS = 6;

/**
 * Widest mantissa the compact form carries, so `zigzag(m) * 8` stays a
 * safe integer through the varint path.
 */
const MAX_MANTISSA = 2 ** 49;

/**
 * Split a finite number into mantissa and tag using the shortest decimal
 * string that round-trips it, which is exactly what `String` gives.
 * Rebuilding the same decimal on the far side and parsing it reproduces
 * the original bit for bit, because both are the one decimal string
 * parsed with the one rounding rule. Returns null when the value does not
 * fit the compact form.
 */
function decimalParts(v: number): { m: number; tag: number } | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(v));
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const frac = match[3] ?? '';
  let digits = (match[2] ?? '') + frac;
  // v = digits * 10^p
  let p = (match[4] ? Number(match[4]) : 0) - frac.length;
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    p += 1;
  }
  let tag: number;
  if (p >= -4 && p <= 0) tag = -p;
  else if (p === 1) {
    digits += '0';
    tag = 0;
  } else if (p === 2) tag = NUM_HUNDREDS;
  else if (p >= 3) {
    digits += '0'.repeat(p - 3);
    tag = NUM_THOUSANDS;
  } else return null;
  const mag = Number(digits);
  if (!Number.isSafeInteger(mag) || mag >= MAX_MANTISSA) return null;
  return { m: sign * mag, tag };
}

function fromDecimalParts(m: number, tag: number): number {
  if (tag === 0) return m;
  if (tag === NUM_HUNDREDS) return m * 100;
  if (tag === NUM_THOUSANDS) return m * 1000;
  return Number(`${m}e-${tag}`);
}

/* ---------------- byte writer and reader ---------------- */

class Writer {
  private buf = new Uint8Array(512);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }

  /** Unsigned LEB128, up to 2^53. */
  varint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new WireError(`bad varint ${n}`);
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }

  /** Signed integer, zigzag then varint. */
  sint(n: number): void {
    this.varint(n < 0 ? -2 * n - 1 : 2 * n);
  }

  /** Any finite number, exactly. */
  num(v: number): void {
    if (!Number.isFinite(v)) throw new WireError(`non-finite ${v}`);
    const d = decimalParts(v);
    if (d) {
      const z = d.m < 0 ? -2 * d.m - 1 : 2 * d.m;
      this.varint(z * 8 + d.tag);
      return;
    }
    this.varint(NUM_FLOAT);
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, v, true);
    this.len += 8;
  }

  /** UTF-8, length-prefixed. */
  str(s: string): void {
    const bytes = new TextEncoder().encode(s);
    this.varint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  bytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  done(): boolean {
    return this.pos >= this.buf.length;
  }

  byte(): number {
    if (this.pos >= this.buf.length) throw new WireError('truncated');
    return this.buf[this.pos++] ?? 0;
  }

  varint(): number {
    let n = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      n += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) {
        if (!Number.isSafeInteger(n)) throw new WireError('varint overflow');
        return n;
      }
      scale *= 0x80;
    }
    throw new WireError('varint too long');
  }

  sint(): number {
    const z = this.varint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  num(): number {
    const n = this.varint();
    const tag = n % 8;
    if (tag === NUM_FLOAT) {
      if (this.pos + 8 > this.buf.length) throw new WireError('truncated');
      const v = new DataView(
        this.buf.buffer,
        this.buf.byteOffset + this.pos,
        8,
      ).getFloat64(0, true);
      this.pos += 8;
      // A JSON link could never carry these, and the engine must never see
      // them; the escape is for precision, not for smuggling.
      if (!Number.isFinite(v)) throw new WireError('non-finite number');
      return v;
    }
    const z = (n - tag) / 8;
    const m = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
    return fromDecimalParts(m, tag);
  }

  str(): string {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new WireError('truncated');
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}

/* ---------------- encode ---------------- */

/**
 * Serialise a topology to generation-3 bytes. Node, edge and annotation
 * order is preserved exactly: a region node's regions are its outgoing
 * edges BY INDEX, so edge order is topology, not presentation.
 */
export function packTopology(topology: Topology): Uint8Array<ArrayBuffer> {
  const w = new Writer();
  const annotations = topology.annotations ?? [];
  const index = new Map<string, number>();
  topology.nodes.forEach((n, i) => index.set(n.id, i));

  w.varint(topology.nodes.length);
  w.varint(topology.edges.length);
  w.varint(annotations.length);

  for (const node of topology.nodes) packNode(w, node);
  for (const edge of topology.edges) packEdge(w, edge, index);
  for (const a of annotations) packAnnotation(w, a);

  return w.bytes();
}

function packNode(w: Writer, node: SimNode): void {
  const kind = KINDS.indexOf(node.kind);
  if (kind < 0) throw new WireError(`unknown kind ${node.kind}`);
  w.varint(kind);
  w.sint(Math.round(node.x));
  w.sint(Math.round(node.y));
  // 0 means "the kind's default label"; anything else is length + 1, so
  // an explicitly empty label survives as its own thing.
  if (node.label === LABELS[node.kind]) w.varint(0);
  else {
    const bytes = new TextEncoder().encode(node.label);
    w.varint(bytes.length + 1);
    for (const b of bytes) w.byte(b);
  }
  packConfig(w, node.kind, node.config);
}

type ConfigValue = number | string;

/**
 * The fields worth sending: present, of a type the wire carries, and
 * different from what `defaultConfig(kind)` would restore. An undefined
 * or non-finite value is treated as absent; neither is a setting.
 */
function overrides(kind: NodeKind, config: NodeConfig): Map<ConfigField, ConfigValue> {
  const def = defaultConfig(kind) as unknown as Record<string, unknown>;
  const out = new Map<ConfigField, ConfigValue>();
  for (const field of FIELDS) {
    const v = (config as unknown as Record<string, unknown>)[field];
    if (v === undefined || v === def[field]) continue;
    if (field === 'traffic' || field === 'bulkheadMode') {
      if (
        typeof v === 'string' &&
        (field === 'traffic'
          ? (TRAFFIC_PATTERNS as readonly string[]).includes(v)
          : v === 'reject' || v === 'wait')
      ) {
        out.set(field, v);
      }
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) out.set(field, v);
  }
  return out;
}

function packValue(w: Writer, field: ConfigField, v: ConfigValue): void {
  if (field === 'traffic') {
    w.varint(TRAFFIC_PATTERNS.indexOf(v as (typeof TRAFFIC_PATTERNS)[number]));
  } else if (field === 'bulkheadMode') {
    w.varint(v === 'wait' ? 1 : 0);
  } else {
    w.num(v as number);
  }
}

function packConfig(w: Writer, kind: NodeKind, config: NodeConfig): void {
  const set = overrides(kind, config);
  const schema = SCHEMA[kind];
  let mask = 0;
  const extras: ConfigField[] = [];
  for (const field of set.keys()) {
    const bit = schema.indexOf(field);
    if (bit >= 0) mask += 2 ** bit;
    else extras.push(field);
  }
  w.varint(mask * 2 + (extras.length > 0 ? 1 : 0));
  for (const field of schema) {
    const v = set.get(field);
    if (v !== undefined) packValue(w, field, v);
  }
  if (extras.length > 0) {
    w.varint(extras.length);
    for (const field of extras) {
      w.varint(FIELD_INDEX.get(field) ?? -1);
      // The map is built from FIELDS, so the value is always there.
      packValue(w, field, set.get(field) as ConfigValue);
    }
  }
}

function packEdge(w: Writer, edge: SimEdge, index: Map<string, number>): void {
  const from = index.get(edge.from);
  const to = index.get(edge.to);
  if (from === undefined || to === undefined) throw new WireError('dangling edge');
  let flags = 0;
  if (edge.control === true) flags |= EDGE_CONTROL;
  if (edge.weight !== 1) flags |= EDGE_WEIGHT;
  if (finite(edge.latencyMs)) flags |= EDGE_LATENCY;
  if (finite(edge.bandwidthRps)) flags |= EDGE_BANDWIDTH;
  if (finite(edge.lossRate)) flags |= EDGE_LOSS;
  w.varint(from);
  // The flags byte is folded away for the plain edge, which is nearly all
  // of them: one bit on `to` says whether it follows.
  w.varint(to * 2 + (flags ? 1 : 0));
  if (!flags) return;
  w.byte(flags);
  if (flags & EDGE_WEIGHT) w.num(edge.weight);
  if (flags & EDGE_LATENCY) w.num(edge.latencyMs as number);
  if (flags & EDGE_BANDWIDTH) w.num(edge.bandwidthRps as number);
  if (flags & EDGE_LOSS) w.num(edge.lossRate as number);
}

function finite(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function packAnnotation(w: Writer, a: Annotation): void {
  if (a.kind === 'section') packSection(w, a);
  else packNote(w, a);
}

function packNote(w: Writer, n: Note): void {
  let h = 0;
  h |= Math.max(0, NOTE_SIZES.indexOf(n.size)) << NOTE_SIZE_SHIFT;
  if (n.font !== undefined)
    h |= (ANNOTATION_FONTS.indexOf(n.font) + 1) << NOTE_FONT_SHIFT;
  if (n.color !== undefined) h |= NOTE_COLOR;
  if (n.tone !== undefined) h |= NOTE_TONE;
  if (n.bold === true) h |= NOTE_BOLD;
  if (n.italic === true) h |= NOTE_ITALIC;
  if (n.underline === true) h |= NOTE_UNDERLINE;
  if (finite(n.scale) && n.scale !== 1) h |= NOTE_SCALE;
  if (n.autoResize === true) h |= NOTE_AUTO;
  w.varint(h);
  w.str(n.text);
  w.num(n.x);
  w.num(n.y);
  w.num(n.width);
  if (h & NOTE_SCALE) w.num(n.scale as number);
  if (h & NOTE_COLOR) w.str(n.color as string);
  if (h & NOTE_TONE) w.varint(toneIndex(n.tone as number));
}

function packSection(w: Writer, s: Section): void {
  let h = ANN_SECTION;
  h |= toneIndex(s.tone) << SECTION_TONE_SHIFT;
  if (s.color !== undefined) h |= SECTION_COLOR;
  w.varint(h);
  w.str(s.label);
  w.num(s.x);
  w.num(s.y);
  w.num(s.width);
  w.num(s.height);
  if (h & SECTION_COLOR) w.str(s.color as string);
}

/** A tone index, folded into the palette the same way the sanitizer does. */
function toneIndex(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return (
    ((Math.floor(t) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) % SECTION_TONE_COUNT
  );
}

/* ---------------- decode ---------------- */

/**
 * Ceiling on element counts, applied before any allocation. A hostile
 * header claiming a billion nodes must fail on the number, not on the
 * memory. The largest worked example has 21 nodes; a link cannot carry
 * more than a few hundred.
 */
const MAX_ITEMS = 10_000;

/**
 * Parse generation-3 bytes back into a topology, or null if the bytes do
 * not describe one. This is a structural parse only: the result still
 * goes through `isTopology` and `sanitizeAnnotations` in share.ts, the
 * same gates every other untrusted input passes, so there is no second
 * validator here to drift out of step with them.
 */
export function unpackTopology(bytes: Uint8Array): Topology | null {
  try {
    const r = new Reader(bytes);
    const nodeCount = r.varint();
    const edgeCount = r.varint();
    const annCount = r.varint();
    if (nodeCount > MAX_ITEMS || edgeCount > MAX_ITEMS || annCount > MAX_ITEMS)
      return null;

    const nodes: SimNode[] = [];
    const perKind = new Map<NodeKind, number>();
    for (let i = 0; i < nodeCount; i++) nodes.push(unpackNode(r, perKind));

    const edges: SimEdge[] = [];
    const edgeIds = new Set<string>();
    for (let i = 0; i < edgeCount; i++) edges.push(unpackEdge(r, nodes, edgeIds));

    const annotations: Annotation[] = [];
    let notes = 0;
    let sections = 0;
    for (let i = 0; i < annCount; i++) {
      const a = unpackAnnotation(r);
      if (a.kind === 'note') a.id = `note-${++notes}`;
      else a.id = `section-${++sections}`;
      annotations.push(a);
    }

    // Trailing bytes mean the link is not what it claims to be.
    if (!r.done()) return null;

    return {
      nodes,
      edges,
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  } catch (e) {
    if (e instanceof WireError) return null;
    // A TextDecoder or DataView failure is the same thing: bad bytes.
    return null;
  }
}

function unpackNode(r: Reader, perKind: Map<NodeKind, number>): SimNode {
  const kind = KINDS[r.varint()];
  if (kind === undefined) throw new WireError('unknown kind');
  const x = r.sint();
  const y = r.sint();
  const labelLen = r.varint();
  let label: string;
  if (labelLen === 0) label = LABELS[kind];
  else {
    const bytes = new Uint8Array(labelLen - 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = r.byte();
    label = new TextDecoder().decode(bytes);
  }
  const config = unpackConfig(r, kind);
  // Same shape makeNode mints, numbered per kind from 1. The shell dedupes
  // against these when it adds a node, so nothing can collide later.
  const n = (perKind.get(kind) ?? 0) + 1;
  perKind.set(kind, n);
  return { id: `${kind}-${n}`, kind, label, x, y, config };
}

function unpackValue(r: Reader, field: ConfigField): ConfigValue {
  if (field === 'traffic') {
    const t = TRAFFIC_PATTERNS[r.varint()];
    if (t === undefined) throw new WireError('unknown traffic pattern');
    return t;
  }
  if (field === 'bulkheadMode') {
    const mode = r.varint();
    if (mode > 1) throw new WireError('unknown bulkhead mode');
    return mode === 1 ? 'wait' : 'reject';
  }
  return r.num();
}

function unpackConfig(r: Reader, kind: NodeKind): NodeConfig {
  const config = defaultConfig(kind) as unknown as Record<string, ConfigValue>;
  const schema = SCHEMA[kind];
  const header = r.varint();
  const hasExtras = header % 2 === 1;
  let mask = (header - (hasExtras ? 1 : 0)) / 2;
  if (mask >= 2 ** schema.length) throw new WireError('mask names an unknown field');
  for (const field of schema) {
    if (mask % 2 === 1) config[field] = unpackValue(r, field);
    mask = Math.floor(mask / 2);
  }
  if (hasExtras) {
    const count = r.varint();
    if (count > FIELDS.length) throw new WireError('too many extras');
    for (let i = 0; i < count; i++) {
      const field = FIELDS[r.varint()];
      if (field === undefined) throw new WireError('unknown field');
      config[field] = unpackValue(r, field);
    }
  }
  return config as unknown as NodeConfig;
}

function unpackEdge(r: Reader, nodes: readonly SimNode[], ids: Set<string>): SimEdge {
  const from = nodes[r.varint()];
  const toBits = r.varint();
  const hasFlags = toBits % 2 === 1;
  const to = nodes[(toBits - (hasFlags ? 1 : 0)) / 2];
  if (!from || !to) throw new WireError('edge names a missing node');
  const flags = hasFlags ? r.byte() : 0;
  if (flags & ~EDGE_KNOWN) throw new WireError('unknown edge flag');

  // The shell's own id shape. Two edges between the same pair cannot be
  // drawn, but a design file could carry them, so a repeat is suffixed
  // rather than allowed to shadow the first.
  let id = `${from.id}->${to.id}`;
  for (let k = 2; ids.has(id); k++) id = `${from.id}->${to.id}~${k}`;
  ids.add(id);

  const edge: SimEdge = {
    id,
    from: from.id,
    to: to.id,
    weight: flags & EDGE_WEIGHT ? r.num() : 1,
  };
  if (flags & EDGE_CONTROL) edge.control = true;
  if (flags & EDGE_LATENCY) edge.latencyMs = r.num();
  if (flags & EDGE_BANDWIDTH) edge.bandwidthRps = r.num();
  if (flags & EDGE_LOSS) edge.lossRate = r.num();
  return edge;
}

function unpackAnnotation(r: Reader): Annotation {
  const h = r.varint();
  if (h & ANN_SECTION) {
    if (h & ~SECTION_KNOWN) throw new WireError('unknown section bit');
    const tone = (h >> SECTION_TONE_SHIFT) & 0xf;
    if (tone >= SECTION_TONE_COUNT) throw new WireError('bad tone');
    const label = r.str();
    const x = r.num();
    const y = r.num();
    const width = r.num();
    const height = r.num();
    const s: Section = { id: '', kind: 'section', label, x, y, width, height, tone };
    if (h & SECTION_COLOR) s.color = r.str();
    return s;
  }
  if (h & ~NOTE_KNOWN) throw new WireError('unknown note bit');
  const size = NOTE_SIZES[(h >> NOTE_SIZE_SHIFT) & 0x3];
  if (size === undefined) throw new WireError('bad size');
  const fontBits = (h >> NOTE_FONT_SHIFT) & 0x7;
  let font: AnnotationFont | undefined;
  if (fontBits > 0) {
    font = ANNOTATION_FONTS[fontBits - 1];
    if (font === undefined) throw new WireError('bad font');
  }
  const text = r.str();
  const x = r.num();
  const y = r.num();
  const width = r.num();
  const n: Note = { id: '', kind: 'note', text, x, y, width, size };
  if (h & NOTE_SCALE) n.scale = r.num();
  if (font !== undefined) n.font = font;
  if (h & NOTE_COLOR) n.color = r.str();
  if (h & NOTE_TONE) {
    const tone = r.varint();
    if (tone >= SECTION_TONE_COUNT) throw new WireError('bad tone');
    n.tone = tone;
  }
  if (h & NOTE_BOLD) n.bold = true;
  if (h & NOTE_ITALIC) n.italic = true;
  if (h & NOTE_UNDERLINE) n.underline = true;
  if (h & NOTE_AUTO) n.autoResize = true;
  return n;
}
