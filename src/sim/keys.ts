import { pow } from './fdlibm';

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
export const KEYSPACE = 64;

/** Steepest skew a client accepts. Past 2 the hottest key is over 60%. */
export const MAX_KEY_SKEW = 2;

/**
 * The skew a client is actually running with, 0..MAX_KEY_SKEW. Absent, zero,
 * negative and non-finite all mean an even spread.
 */
export function effectiveKeySkew(skew: number | undefined): number {
  if (skew === undefined || !(skew > 0)) return 0;
  return skew > MAX_KEY_SKEW ? MAX_KEY_SKEW : skew;
}

/**
 * Cumulative Zipf shares over the keyspace: entry k is the chance a request's
 * key is k or lower, where key k has weight 1 / (k + 1)^skew. Key 0 is the
 * hottest, so it lands on shard 0 and adds to a shard's own hot-key share
 * rather than fighting it.
 *
 * Built with the fdlibm pow, not Math.pow, because the table decides keys
 * and keys decide routing: a last-bit difference between browsers would move
 * a draw across a boundary and the replay would split.
 */
function buildTable(skew: number): Float64Array {
  const cdf = new Float64Array(KEYSPACE);
  let total = 0;
  for (let k = 0; k < KEYSPACE; k++) {
    total += 1 / pow(k + 1, skew);
    cdf[k] = total;
  }
  for (let k = 0; k < KEYSPACE; k++) cdf[k] /= total;
  // Rounding can leave the last entry a hair under 1, and a draw above it
  // would fall off the end.
  cdf[KEYSPACE - 1] = 1;
  return cdf;
}

/**
 * Tables by skew. A client's skew changes only when someone moves the slider,
 * so this holds a handful of entries; it is cleared rather than grown if a
 * long drag ever fills it.
 */
const TABLES = new Map<number, Float64Array>();
const MAX_TABLES = 32;

/** The cumulative table for `skew`, built once and then reused. */
export function keyTable(skew: number): Float64Array {
  let table = TABLES.get(skew);
  if (table === undefined) {
    if (TABLES.size >= MAX_TABLES) TABLES.clear();
    table = buildTable(skew);
    TABLES.set(skew, table);
  }
  return table;
}

/**
 * Turn one uniform draw `u` in [0, 1) into a key.
 *
 * At skew 0 this is exactly `Math.floor(u * KEYSPACE)`, the expression every
 * run before skew existed used, so a client without it keys byte for byte as
 * it did. Either way it is one draw per request, so the random numbers taken
 * after it are the same with skew on or off.
 */
export function keyForDraw(u: number, skew: number): number {
  if (skew <= 0) return Math.floor(u * KEYSPACE);
  const cdf = keyTable(skew);
  // First key whose cumulative share is above u. Six steps over 64 keys.
  let lo = 0;
  let hi = KEYSPACE - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u < cdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The share of requests the hottest key gets at `skew`, 0..1. */
export function hottestKeyShare(skew: number): number {
  return skew > 0 ? keyTable(skew)[0] : 1 / KEYSPACE;
}
