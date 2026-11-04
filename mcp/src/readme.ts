import { NODE_KINDS } from '../../src/clipboard';
import { WIRE_SCHEMA } from '../../src/share/wire';
import { defaultConfig } from '../../src/sim/presets';
import { defaultLabel, glossaryFor } from './kinds';

/* ------------------------------------------------------------------ *
 * What a model reads once before it draws anything.
 *
 * Generated rather than written out, so that a component added to the
 * engine appears here the day it lands. The per-kind setting lists come
 * from the wire schema, the one-line meanings from the doc comments on
 * NodeConfig and the glossary, and the defaults from `defaultConfig`.
 * The only hand-written parts are the ones no source file already says:
 * how requests move through a graph, and how real code maps onto kinds.
 * ------------------------------------------------------------------ */

/** Settings every request-path kind shares. Listed once, not per kind. */
const COMMON = new Set([
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
]);

/**
 * The first sentence of each NodeConfig field's doc comment, keyed by field.
 * Takes the source text rather than reading it, so the caller decides how
 * the file arrives (inlined by the bundler, or read in a test).
 */
export function extractFieldDocs(typesSource: string): Record<string, string> {
  const start = typesSource.indexOf('export interface NodeConfig {');
  const end = typesSource.indexOf('\n}', start);
  if (start < 0 || end < 0) return {};
  const docs: Record<string, string> = {};
  for (const m of typesSource
    .slice(start, end)
    .matchAll(/\/\*\*([\s\S]*?)\*\/\s*(\w+)\??:/g)) {
    const text = (m[1] ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim();
    const para = (text.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ');
    // A short first paragraph is kept whole, since the second sentence is
    // often the range ("0 = deterministic, 1 = exponential").
    const doc =
      para.length <= 160 ? para : (para.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? para);
    if (m[2]) docs[m[2]] = doc.replace(/ -- /g, ', ');
  }
  return docs;
}

function componentLines(): string[] {
  return NODE_KINDS.map((kind) => {
    const entry = glossaryFor(kind);
    const defaults = defaultConfig(kind) as unknown as Record<string, unknown>;
    const own = WIRE_SCHEMA[kind]
      .filter((f) => !COMMON.has(f) || (kind === 'client' && f === 'rps'))
      .map((f) => `${f}=${JSON.stringify(defaults[f] ?? null)}`);
    const shared = ['capacity', 'serviceMs', 'queueLimit']
      .map((f) => `${f}=${JSON.stringify(defaults[f])}`)
      .join(' ');
    const label = defaultLabel(kind);
    return (
      `- \`${kind}\` (${label}): ${entry?.short ?? label}. ` +
      (own.length > 0 ? `Own settings: ${own.join(' ')}. ` : '') +
      `Defaults: ${shared}.`
    );
  });
}

export function buildReadme(fieldDocs: Readonly<Record<string, string>>): string {
  const commonDocs = [...COMMON]
    .map((f) => `- \`${f}\`: ${fieldDocs[f] ?? ''}`)
    .join('\n');
  const ownDocs = Object.entries(fieldDocs)
    .filter(([f]) => !COMMON.has(f))
    .map(([f, d]) => `- \`${f}\`: ${d}`)
    .join('\n');

  return `# Breakscale design format

You only need to read this once per conversation. Then call create_view.

Breakscale is a system design simulator. A design is a graph of components.
Traffic starts at \`client\` nodes and flows along edges; every component
has a finite number of request slots and a queue, so load you add shows up
as real queueing, latency and failures, measured from simulated requests.

## Shape

\`\`\`json
{
  "name": "Rate limited API",
  "nodes": [
    { "id": "users", "kind": "client", "config": { "rps": 400 } },
    { "id": "limiter", "kind": "ratelimiter", "config": { "rateLimitRps": 250, "burst": 50 } },
    { "id": "api", "kind": "service", "label": "Orders API", "config": { "capacity": 16 } },
    { "id": "db", "kind": "db", "config": { "capacity": 12 } }
  ],
  "edges": [
    { "from": "users", "to": "limiter" },
    { "from": "limiter", "to": "api" },
    { "from": "api", "to": "db" }
  ]
}
\`\`\`

- A node needs \`id\` and \`kind\`. \`label\` is what the canvas shows.
  \`config\` holds only the settings you want to change; everything else
  gets the defaults listed below.
- Leave out \`x\` and \`y\`. Nodes are laid out left to right in the
  direction requests flow. Give positions only when you are editing a
  design that already has them.
- An edge is a request path \`{ "from", "to" }\`. \`weight\` (default 1)
  splits traffic when a node picks one edge out of several.
- A whole \`.breakscale\` file is also accepted as is.

## How requests move

- A \`client\` offers \`rps\` requests per second. Use one client per real
  traffic source. The total the whole design sees is the sum.
- \`lb\`, \`region\` and \`bulkhead\` send each request down ONE outgoing
  edge (least loaded when weights are equal, otherwise by weight).
- Every other kind calls ALL of its outgoing edges for each request and
  finishes when they all answer. So a service wired to a cache and a
  database calls both. To model "cache first, database on a miss", wire
  service to cache and cache to database: a \`cache\` answers hits itself
  and only passes misses on (\`hitRate\`).
- A node with no outgoing edge answers the request itself.
- A \`queue\` acknowledges at once and buffers; \`worker\` nodes wired from it
  drain it. Always draw queue to worker. A worker wired to a queue drains
  it whichever way the edge points, so to have a worker publish into
  another queue, put a \`service\` between them: worker, then service, then
  queue.
- An \`autoscaler\` carries no traffic. Wire it TO the node it resizes; that
  edge is a control edge and changes that node's \`instances\`.
- A node can do at most \`capacity * instances * (1000 / serviceMs)\` requests
  per second. Do this arithmetic when you pick numbers: a design that is
  meant to hold should sit well under it, and one meant to show a
  bottleneck should cross it.

## Components

${componentLines().join('\n')}

## Settings every component has

${commonDocs}

## Component-specific settings

${ownDocs}

## Turning real code into a design

Read the code for what actually runs and how it is called, then map:

- HTTP server, app server, microservice: \`service\`. Pool sizes, worker
  threads or max connections become \`capacity\`; replica counts or pod
  counts become \`instances\`; client timeouts and retry counts go on the
  CALLER as \`timeoutMs\` and \`retries\`.
- nginx, HAProxy, ELB/ALB, a Kubernetes Service in front of pods: \`lb\`.
- Kong, AWS API Gateway, an auth-checking gateway: \`apigateway\`.
- Postgres, MySQL: \`db\`. Read replicas: \`replica\`. Sharded or
  partitioned tables (Vitess, Citus): \`shard\`.
- Redis or Memcached used as a read cache: \`cache\`. Write-behind caching:
  \`writebehind\`.
- CloudFront, Fastly, Cloudflare caching: \`cdn\`. Cloudflare Workers,
  Lambda@Edge: \`edgecompute\`.
- SQS, RabbitMQ, BullMQ, Celery, Sidekiq: \`queue\` feeding \`worker\` nodes.
  A retry or dead-letter queue: \`retryqueue\`.
- Kafka, Kinesis: \`streambroker\`. SNS, Google Pub/Sub, Redis pub/sub:
  \`pubsub\`.
- S3, GCS, Azure Blob: \`objectstore\`. Glacier and archive tiers:
  \`coldstorage\`.
- Elasticsearch, OpenSearch: \`searchindex\`. InfluxDB, TimescaleDB:
  \`timeseriesdb\`. Neo4j: \`graphdb\`. pgvector, Pinecone: \`vectordb\`.
- Rate-limit middleware: \`ratelimiter\`. Circuit breakers (resilience4j,
  opossum, Polly): \`breaker\`. Bulkheads or concurrency limiters:
  \`bulkhead\`. Priority load shedding: \`loadshedder\`.
- Istio, Linkerd or Envoy sidecars: \`sidecar\`.
- AWS Lambda, Cloud Functions: \`lambda\`. Cron jobs, scheduled tasks:
  \`cron\`. WebSocket servers: \`websocket\`. Media encoding: \`transcoder\`.
- A Kubernetes HPA or an autoscaling group: \`autoscaler\` wired to the
  service it scales. Multi-region failover: \`region\` with one edge per
  region.

Use numbers that appear in the code or config. Where the code does not
say, keep the defaults rather than inventing precise-looking values, and
tell the user which numbers were assumed.

## Editing

To change a design, call create_view again with the whole updated design,
keeping node ids and positions so the canvas does not jump. If the user
edited the design on the canvas, their latest version is in your context;
start from that one.

## Breaking it on a schedule

A design can carry \`faults\`, a list of things that go wrong at set times,
so a run shows what happens when a part fails and then recovers. \`atMs\`
is simulated time in milliseconds from the start of the run.

- \`{ "atMs": 10000, "action": "inject", "nodeId": "db", "kind": "crash" }\`
  takes a node down. Other kinds: \`slow\` with \`"opts": { "factor": 3 }\`
  (three times slower), \`errors\` with \`"opts": { "rate": 0.2 }\` (20% of
  requests fail), and \`partition\` (its outgoing edges stop carrying
  requests).
- \`{ "atMs": 20000, "action": "clear", "nodeId": "db" }\` heals it.
- \`{ "atMs": 5000, "action": "cut", "edgeId": "api->db" }\` cuts one edge
  and \`restore\` reconnects it. An edge's id is \`from->to\` unless you gave
  it one.

\`seed\` (a whole number, default 1) picks the random draws. The same
design, seed and faults always give the same numbers.

## Saving to a file

A \`.breakscale\` file can be opened in the Breakscale app and in its VS
Code extension, from Settings, Open a file. Do not write one by hand: it
needs every node's position and full config, which the short form leaves
out. Call export_design with the same design you gave create_view, and
write what it returns to a file ending in \`.breakscale\`.
`;
}
