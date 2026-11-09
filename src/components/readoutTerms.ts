import type { NodeKind } from '../sim/types';

/**
 * Which glossary entry explains each word printed on a node's box.
 *
 * The box is SVG text, so a <Term> cannot sit on it, and the canvas pointer
 * layer is not the place to grow a second hover system. The inspector shows
 * the same words under its meter instead, each explained from the glossary.
 *
 * Keyed by the exact label `readoutFor` returns. Most words mean the same
 * thing on every kind; the few that do not ("refused" is a rate limiter's
 * throttling but a breaker's open circuit) are resolved per kind first. A
 * label with no entry here is plain enough to need none ("in", "out").
 */
const BY_LABEL: Readonly<Record<string, string>> = {
  busy: 'utilisation',
  p99: 'p99',
  waiting: 'backlog',
  served: 'throughput',
  done: 'throughput',
  sent: 'offered',
  ok: 'goodput',
  failing: 'error-rate',
  hit: 'hit-rate',
  stale: 'stale-read',
  lock: 'lock-contention',
  origin: 'origin-fetch',
  tokens: 'tokens',
  circuit: 'breaker',
  trips: 'breaker',
  'dep fails': 'error-rate',
  fails: 'error-rate',
  range: 'range-query',
  lag: 'consumer-lag',
  lost: 'retention',
  'fan-out': 'fan-out',
  conns: 'connection-slot',
  slots: 'connection-slot',
  upstream: 'outlier-ejection',
  pool: 'bulkhead',
  dead: 'dead-letter',
  retry: 'redelivery',
  'at edge': 'edge-share',
  'at risk': 'dirty-write',
  watching: 'utilisation',
  pods: 'instances',
  serving: 'region',
  failover: 'region',
  healthy: 'region',
  'back in': 'region',
  'per job': 'service-time',
  'shed low': 'deprioritized',
  'shed high': 'deprioritized',
  limited: 'throttled',
  denied: 'unauthorized',
};

const BY_KIND: Partial<Record<NodeKind, Readonly<Record<string, string>>>> = {
  shard: { hot: 'hot-key', cold: 'shard' },
  lambda: { cold: 'cold-start', warm: 'cold-start', refused: 'throttled' },
  searchindex: { stale: 'stale-search' },
  graphdb: { query: 'traversal-depth' },
  vectordb: { query: 'recall' },
  ratelimiter: { refused: 'throttled' },
  breaker: { refused: 'rejected' },
  websocket: { refused: 'conn-refused' },
  bulkhead: { refused: 'bulkhead-full' },
  sidecar: { refused: 'outlier-ejection' },
  objectstore: { refused: 'prefix-ceiling' },
  coldstorage: { restore: 'coldstorage', refused: 'throttled' },
};

/** Glossary id for a word on a node's box, or undefined when it needs none. */
export function readoutTermFor(kind: NodeKind, label: string): string | undefined {
  return BY_KIND[kind]?.[label] ?? BY_LABEL[label];
}

/** Every id this module can return, for the wiring test. */
export function allReadoutTermIds(): string[] {
  const ids = new Set(Object.values(BY_LABEL));
  for (const m of Object.values(BY_KIND))
    for (const id of Object.values(m)) ids.add(id);
  return [...ids];
}
