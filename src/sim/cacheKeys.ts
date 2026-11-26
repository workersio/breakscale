import { KEYSPACE } from './keys';
import type { NodeConfig } from './types';

/* ------------------------------------------------------------------ *
 * A cache that remembers which keys it holds.
 *
 * The default cache rolls `hitRate` on every request, so two caches in a row
 * are two independent coin flips and their misses multiply. That is not how
 * a cache works: whether a request hits depends on whether its key is in
 * there, and a request reaches the second cache only because the first one
 * did not hold its key. With `cacheKeys` set, the cache holds that many of
 * the keyspace's keys, fills a key when the call behind it answers a read,
 * and evicts the key used least recently when it is full. Its hit rate is
 * then measured, not set: hot keys make it high, an even spread makes it
 * about `cacheKeys / KEYSPACE`, and a second cache behind the first sees
 * only the cold keys the first one could not keep.
 *
 * Plain arrays over the keyspace, no random numbers and no events: a key is
 * expired when the clock has passed its fill time plus the TTL, checked when
 * the key is next looked up. Eviction scans 64 entries, which is cheaper than
 * keeping a list in order.
 * ------------------------------------------------------------------ */

/** Keys a cache holds when it switches to tracking keys and does not say. */
export const DEFAULT_CACHE_KEYS = 16;
/** Longest TTL a cache accepts, in ms. */
export const MAX_CACHE_TTL_MS = 60_000;

/**
 * How many keys the cache holds, 0..KEYSPACE. 0 means it does not track keys
 * and rolls `hitRate` instead. Absent, negative and non-finite are all 0.
 */
export function effectiveCacheKeys(config: NodeConfig): number {
  const v = config.cacheKeys;
  if (v === undefined || !(v >= 1)) return 0;
  return v > KEYSPACE ? KEYSPACE : Math.floor(v);
}

/** How long a filled key stays good in ms, or 0 for until it is evicted. */
export function effectiveCacheTtlMs(config: NodeConfig): number {
  const v = config.cacheTtlMs;
  if (v === undefined || !(v > 0)) return 0;
  return v > MAX_CACHE_TTL_MS ? MAX_CACHE_TTL_MS : v;
}

/** What one cache node holds. Lives in the node's `ext`. */
export class KeyedCache {
  /** When each key was filled, or -1 when it is not held. */
  private readonly filledAt = new Float64Array(KEYSPACE).fill(-1);
  /** When each held key was last used, for eviction. */
  private readonly usedAt = new Float64Array(KEYSPACE);
  private held = 0;

  /** Keys held right now, the expired ones still counted until next looked at. */
  get size(): number {
    return this.held;
  }

  /** Keys held and still good at `now`, for the readout. */
  goodAt(now: number, ttlMs: number): number {
    if (ttlMs <= 0) return this.held;
    let n = 0;
    for (let k = 0; k < KEYSPACE; k++) {
      const at = this.filledAt[k]!;
      if (at >= 0 && now < at + ttlMs) n++;
    }
    return n;
  }

  /**
   * Whether `key` is held and still good at `now`. A hit counts as a use.
   * An expired key is dropped here, so the miss that finds it goes downstream
   * and fills it again, the way a TTL expiry sends every reader to the store.
   */
  lookup(key: number, now: number, ttlMs: number, capacity: number): boolean {
    this.fit(capacity);
    const k = slot(key);
    const at = this.filledAt[k]!;
    if (at < 0) return false;
    if (ttlMs > 0 && now >= at + ttlMs) {
      this.drop(k);
      return false;
    }
    this.usedAt[k] = now;
    return true;
  }

  /** Hold `key` from `now`, evicting the least recently used key when full. */
  fill(key: number, now: number, capacity: number): void {
    if (capacity <= 0) return;
    const k = slot(key);
    if (this.filledAt[k]! < 0) {
      this.fit(capacity - 1);
      this.held++;
    }
    this.filledAt[k] = now;
    this.usedAt[k] = now;
  }

  /** Forget `key`, as a write to it does. */
  invalidate(key: number): void {
    const k = slot(key);
    if (this.filledAt[k]! >= 0) this.drop(k);
  }

  /** Forget everything, as a process that lost its memory does. */
  clear(): void {
    this.filledAt.fill(-1);
    this.held = 0;
  }

  /** Evict least recently used keys until at most `capacity` are held. */
  private fit(capacity: number): void {
    while (this.held > capacity && this.held > 0) {
      let oldest = -1;
      for (let k = 0; k < KEYSPACE; k++) {
        if (this.filledAt[k]! < 0) continue;
        if (oldest < 0 || this.usedAt[k]! < this.usedAt[oldest]!) oldest = k;
      }
      this.drop(oldest);
    }
  }

  private drop(k: number): void {
    this.filledAt[k] = -1;
    this.held--;
  }
}

function slot(key: number): number {
  return ((Math.floor(key) % KEYSPACE) + KEYSPACE) % KEYSPACE;
}
