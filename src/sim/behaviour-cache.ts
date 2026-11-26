import { effectiveCacheKeys, effectiveCacheTtlMs, KeyedCache } from './cacheKeys';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { NodeStats } from './types';

/* ------------------------------------------------------------------ *
 * The hit decision the cache and the CDN share.
 *
 * Both used to roll `hitRate` and nothing else. They still do unless
 * `cacheKeys` is set, and the roll is drawn either way, in the same
 * position, so switching a cache between the two models mid-run moves no
 * other random number in the run. See cacheKeys.ts for the model itself.
 * ------------------------------------------------------------------ */

function held(state: NodeStateLike): KeyedCache {
  return state.ext as KeyedCache;
}

/** Whether this request is answered from the cache. Draws one roll, always. */
export function cacheHit(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
): boolean {
  const roll = ctx.roll();
  const capacity = effectiveCacheKeys(state.config);
  if (capacity === 0) {
    const rate = state.config.hitRate;
    return roll < (rate < 0 ? 0 : rate > 1 ? 1 : rate);
  }
  const cache = held(state);
  // A write is never answered from a copy. It goes to the store and the
  // copy of its key is gone, so the next read fetches what it wrote.
  if (req.isWrite) {
    cache.invalidate(req.key);
    return false;
  }
  return cache.lookup(req.key, ctx.now, effectiveCacheTtlMs(state.config), capacity);
}

/**
 * The hooks a key-tracking cache needs on top of its hit decision: where it
 * keeps its keys, how it fills them from the answers behind it, what a crash
 * does to them, and the readout. Inert on a cache that rolls `hitRate`.
 */
export const KEYED_CACHE_HOOKS = {
  observesOutcome: true,
  initState: (): KeyedCache => new KeyedCache(),
  onDownstreamResult: (
    ctx: BehaviourCtx,
    state: NodeStateLike,
    child: ReqLike,
    ok: boolean,
  ): void => {
    const capacity = effectiveCacheKeys(state.config);
    if (capacity === 0) return;
    // A store downstream may be the one that decides a request is a write,
    // so the answer, not the lookup, is where that is known for sure.
    if (child.isWrite) held(state).invalidate(child.key);
    else if (ok) held(state).fill(child.key, ctx.now, capacity);
  },
  onMemoryLost: (state: NodeStateLike): void => {
    held(state).clear();
  },
  decorateStats: (ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void => {
    if (effectiveCacheKeys(state.config) > 0) {
      stats.cachedKeys = held(state).goodAt(ctx.now, effectiveCacheTtlMs(state.config));
    }
  },
};
