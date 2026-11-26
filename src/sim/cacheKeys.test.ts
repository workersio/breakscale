import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import { KeyedCache } from './cacheKeys';
import { Engine } from './engine';
import { makeNode } from './presets';
import type { SimNode, Topology } from './types';

/**
 * A cache that tracks which keys it holds (#31). What is worth pinning: that
 * a cache without `cacheKeys` runs exactly as before, that the hit rate is
 * measured from the keys and not the setting, and the two things the old
 * model got wrong, chained caches and a cache that comes back empty.
 */

function node(kind: SimNode['kind'], id: string): SimNode {
  return { ...makeNode(kind, 0, 0, id), id };
}

interface Opts {
  keys?: number;
  skew?: number;
  ttlMs?: number;
  twoCaches?: boolean;
}

/** client at 200/s -> cache (-> cache) -> db, both caches set to 80%. */
function design({ keys, skew = 1, ttlMs, twoCaches = false }: Opts): Topology {
  const client = node('client', 'client');
  client.config.rps = 200;
  client.config.keySkew = skew;
  const caches = (twoCaches ? ['c1', 'c2'] : ['c1']).map((id) => {
    const c = node('cache', id);
    c.config.hitRate = 0.8;
    if (keys !== undefined) c.config.cacheKeys = keys;
    if (ttlMs !== undefined) c.config.cacheTtlMs = ttlMs;
    return c;
  });
  const db = node('db', 'db');
  const path = ['client', ...caches.map((c) => c.id), 'db'];
  return {
    nodes: [client, ...caches, db],
    edges: path
      .slice(1)
      .map((to, i) => ({ id: `e${i}`, from: path[i]!, to, weight: 1 })),
  };
}

function runFor(t: Topology, seconds: number, each?: (e: Engine, s: number) => void) {
  const engine = new Engine(t, 42);
  for (let i = 0; i < seconds * 60; i++) {
    if (each && i % 60 === 0) each(engine, i / 60);
    engine.advance(1000 / 60);
  }
  return engine;
}

function snapshotHash(t: Topology): string {
  const engine = new Engine(t, 7);
  const h = createHash('sha256');
  for (let i = 1; i <= 600; i++) {
    engine.advance(1000 / 60);
    if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
  }
  return h.digest('hex');
}

describe('the key store', () => {
  it('evicts the key used least recently when full', () => {
    const c = new KeyedCache();
    c.fill(1, 0, 2);
    c.fill(2, 1, 2);
    expect(c.lookup(1, 2, 0, 2)).toBe(true); // 1 is now the fresher
    c.fill(3, 3, 2);
    expect(c.lookup(2, 4, 0, 2)).toBe(false);
    expect(c.lookup(1, 4, 0, 2)).toBe(true);
    expect(c.lookup(3, 4, 0, 2)).toBe(true);
    expect(c.size).toBe(2);
  });

  it('lets a key expire after its TTL, and refills it fresh', () => {
    const c = new KeyedCache();
    c.fill(5, 0, 4);
    expect(c.lookup(5, 999, 1000, 4)).toBe(true);
    expect(c.goodAt(1000, 1000)).toBe(0);
    expect(c.lookup(5, 1000, 1000, 4)).toBe(false);
    c.fill(5, 1000, 4);
    expect(c.lookup(5, 1500, 1000, 4)).toBe(true);
  });

  it('forgets a written key, everything on clear, and shrinks to a smaller size', () => {
    const c = new KeyedCache();
    for (let k = 0; k < 8; k++) c.fill(k, k, 8);
    c.invalidate(3);
    expect(c.lookup(3, 10, 0, 8)).toBe(false);
    expect(c.size).toBe(7);
    // Shrunk to 2: the two most recently used stay.
    expect(c.lookup(7, 11, 0, 2)).toBe(true);
    expect(c.size).toBe(2);
    expect(c.lookup(6, 12, 0, 2)).toBe(true);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.lookup(6, 13, 0, 2)).toBe(false);
  });
});

describe('a cache that tracks keys', () => {
  it('runs byte for byte as before when cacheKeys is unset or 0', () => {
    expect(snapshotHash(design({ keys: 0 }))).toBe(snapshotHash(design({})));
  });

  it('replays the same seed identically', () => {
    expect(snapshotHash(design({ keys: 16 }))).toBe(snapshotHash(design({ keys: 16 })));
  });

  it('survives a share link', () => {
    const t = design({ keys: 24, ttlMs: 5000 });
    const back = unpackTopology(packTopology(t));
    const c1 = back?.nodes[1];
    expect(c1?.config.cacheKeys).toBe(24);
    expect(c1?.config.cacheTtlMs).toBe(5000);
  });

  it('measures its hit rate from the keys, not from hitRate', () => {
    // Measured at seed 42, 30s: 16 of 64 keys, even 28%; skew 1.0 62%;
    // 8 keys 43%, 32 keys 83%. hitRate is 0.8 on every one of them.
    const at = (o: Opts) => runFor(design(o), 30).snapshot().nodes.c1!;
    const even = at({ keys: 16, skew: 0 });
    expect(even.hitRate).toBeGreaterThan(0.2);
    expect(even.hitRate).toBeLessThan(0.35);
    const hot = at({ keys: 16, skew: 1 });
    expect(hot.hitRate).toBeGreaterThan(0.55);
    expect(hot.hitRate).toBeLessThan(0.7);
    expect(hot.cachedKeys).toBe(16);
    expect(at({ keys: 8 }).hitRate).toBeLessThan(hot.hitRate);
    expect(at({ keys: 32 }).hitRate).toBeGreaterThan(hot.hitRate);
  });

  it('hits less with a TTL, because expired keys go back to the store', () => {
    const keep = runFor(design({ keys: 16 }), 30).snapshot().nodes.c1!;
    const ttl = runFor(design({ keys: 16, ttlMs: 2000 }), 30).snapshot().nodes.c1!;
    expect(ttl.hitRate).toBeLessThan(keep.hitRate - 0.05);
  });

  it('leaves a second cache only the cold keys, instead of multiplying (#31)', () => {
    // Measured at seed 42, 30s. Rolling: c1 77%, c2 84%, db 7.8/s, the
    // misses multiplied. Tracking 16 keys each: c1 63%, c2 7%, db 59/s.
    const rolled = runFor(design({ twoCaches: true }), 30).snapshot().nodes;
    const keyed = runFor(design({ keys: 16, twoCaches: true }), 30).snapshot().nodes;
    expect(rolled.c2!.hitRate).toBeGreaterThan(0.7);
    expect(keyed.c2!.hitRate).toBeLessThan(0.15);
    expect(keyed.db!.arrivalRate).toBeGreaterThan(4 * rolled.db!.arrivalRate);
  });

  it('comes back empty from a restart and fills again from the store', () => {
    let before = -1;
    let after = -1;
    let refilled = -1;
    runFor(design({ keys: 16 }), 25, (e, s) => {
      if (s === 14) before = e.snapshot().nodes.c1!.cachedKeys!;
      if (s === 15) {
        e.injectFailure('c1', 'restart', { downMs: 1000 });
        after = e.snapshot().nodes.c1!.cachedKeys!;
      }
      if (s === 24) refilled = e.snapshot().nodes.c1!.cachedKeys!;
    });
    expect(before).toBe(16);
    expect(after).toBe(0);
    expect(refilled).toBe(16);
  });

  it('fills only from reads, and a write forgets its key', () => {
    // The database decides which calls are writes. Every one is here, so
    // nothing is ever filled and nothing is ever answered from a copy.
    const t = design({ keys: 64 });
    t.nodes.find((n) => n.id === 'db')!.config.readFraction = 0;
    const c1 = runFor(t, 10).snapshot().nodes.c1!;
    expect(c1.hitRate).toBe(0);
    expect(c1.cachedKeys).toBe(0);
  });

  it('works the same on a CDN', () => {
    const t = design({ keys: 16 });
    const cdn = node('cdn', 'c1');
    cdn.config.hitRate = 0.8;
    cdn.config.cacheKeys = 16;
    t.nodes[1] = cdn;
    const s = runFor(t, 30).snapshot().nodes.c1!;
    expect(s.hitRate).toBeGreaterThan(0.55);
    expect(s.hitRate).toBeLessThan(0.7);
    expect(s.cachedKeys).toBe(16);
  });
});
