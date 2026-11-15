import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { packTopology, unpackTopology } from '../share/wire';
import { Engine } from './engine';
import { hottestKeyShare, KEYSPACE, keyForDraw, keyTable } from './keys';
import { makeNode } from './presets';
import { Rng } from './random';
import type { SimNode, Topology } from './types';

/**
 * A client's key spread: an even draw over 64 keys, or a Zipf curve where a
 * few keys take most of the traffic.
 *
 * What is worth pinning: that an unset or zero skew keys exactly as before,
 * that skew moves the key and nothing else in the random stream, and that
 * the effect it exists to show is real, one shard pinned while the average
 * across the store stays where even keys put it.
 */

/** client -> sharded store, 8 x 4 slots x 25ms: 1280/s of capacity, 768/s offered. */
function shardTopology(skew?: number): { t: Topology; shard: SimNode } {
  // Fixed ids: makeNode numbers its nodes, and a hash compares two builds.
  const client = { ...makeNode('client', 0, 0, 'Client'), id: 'client' };
  const shard = { ...makeNode('shard', 240, 0, 'Shard'), id: 'shard' };
  client.config.rps = 768;
  if (skew !== undefined) client.config.keySkew = skew;
  shard.config.shardCount = 8;
  shard.config.shardCapacity = 4;
  shard.config.serviceMs = 25;
  const t: Topology = {
    nodes: [client, shard],
    edges: [{ id: 'c->s', from: client.id, to: shard.id, weight: 1 }],
  };
  return { t, shard };
}

/** client -> service: nothing on the path reads the key. */
function keylessTopology(skew?: number): Topology {
  const client = { ...makeNode('client', 0, 0, 'Client'), id: 'client' };
  const service = { ...makeNode('service', 240, 0, 'Service'), id: 'service' };
  client.config.rps = 300;
  if (skew !== undefined) client.config.keySkew = skew;
  return {
    nodes: [client, service],
    edges: [{ id: 'c->s', from: client.id, to: service.id, weight: 1 }],
  };
}

function snapshotHash(t: Topology, seed = 7, frames = 600): string {
  const engine = new Engine(t, seed);
  const h = createHash('sha256');
  for (let i = 1; i <= frames; i++) {
    engine.advance(1000 / 60);
    if (i % 6 === 0) h.update(JSON.stringify(engine.snapshot()));
  }
  return h.digest('hex');
}

function runFor(t: Topology, seconds: number, seed = 42): Engine {
  const engine = new Engine(t, seed);
  for (let i = 0; i < seconds * 60; i++) engine.advance(1000 / 60);
  return engine;
}

describe('key spread', () => {
  it('keys exactly as Math.floor(u * 64) at skew 0', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 10_000; i++) {
      const u = rng.next();
      expect(keyForDraw(u, 0)).toBe(Math.floor(u * KEYSPACE));
    }
  });

  it('follows 1 / (k + 1)^skew', () => {
    const rng = new Rng(3);
    const n = 200_000;
    const counts = new Uint32Array(KEYSPACE);
    for (let i = 0; i < n; i++) counts[keyForDraw(rng.next(), 1)]++;
    let h = 0;
    for (let k = 1; k <= KEYSPACE; k++) h += 1 / k;
    for (const k of [0, 1, 2, 9, 63]) {
      expect(counts[k] / n).toBeCloseTo(1 / (k + 1) / h, 2);
    }
    expect(hottestKeyShare(1)).toBeCloseTo(1 / h, 10);
  });

  it('hottest key shares, worked out over 64 keys', () => {
    expect(hottestKeyShare(0)).toBeCloseTo(1 / 64, 10);
    expect(hottestKeyShare(0.8)).toBeCloseTo(0.14, 2);
    expect(hottestKeyShare(1)).toBeCloseTo(0.211, 3);
    expect(hottestKeyShare(1.2)).toBeCloseTo(0.29, 2);
  });

  it('never keys outside the keyspace', () => {
    expect(keyForDraw(0, 2)).toBe(0);
    expect(keyForDraw(0.999_999_999_9, 2)).toBe(KEYSPACE - 1);
    expect(keyTable(1.5)[KEYSPACE - 1]).toBe(1);
  });

  it('leaves a run byte for byte unchanged when unset or zero', () => {
    const unset = snapshotHash(shardTopology().t);
    expect(snapshotHash(shardTopology(0).t)).toBe(unset);
  });

  it('takes the same draws with skew on, so a keyless path runs identically', () => {
    // Nothing on client -> service reads the key, so if skew moved any draw
    // after the key, these would differ.
    expect(snapshotHash(keylessTopology(1.2))).toBe(snapshotHash(keylessTopology()));
  });

  it('replays the same seed identically with skew on', () => {
    expect(snapshotHash(shardTopology(1).t)).toBe(snapshotHash(shardTopology(1).t));
  });

  it('pins one shard while the average stays where even keys put it', () => {
    const even = shardTopology();
    const evenRun = runFor(even.t, 30).snapshot();
    const evenShard = evenRun.nodes[even.shard.id];

    const zipf = shardTopology(1);
    const zipfRun = runFor(zipf.t, 30).snapshot();
    const zipfShard = zipfRun.nodes[zipf.shard.id];

    // Measured at seed 42, 30s: even 0.58 average, 0.73 busiest, 0% failed;
    // skew 1.0 0.58 average, 1.00 busiest, 11.3% failed.
    expect(evenShard.maxShardUtilization).toBeLessThan(0.85);
    expect(evenRun.system.errorRate).toBeLessThan(0.005);
    expect(zipfShard.maxShardUtilization).toBeGreaterThan(0.99);
    expect(zipfShard.shardUtilization[0]).toBe(zipfShard.maxShardUtilization);
    expect(Math.abs(zipfShard.utilization - evenShard.utilization)).toBeLessThan(0.05);
    expect(zipfRun.system.errorRate).toBeGreaterThan(0.05);
  });

  it('measures the hottest key on the store, and only while keys are skewed', () => {
    const even = shardTopology();
    const evenShard = runFor(even.t, 10).snapshot().nodes[even.shard.id];
    expect(evenShard.hottestKeyShare).toBeUndefined();
    expect(evenShard.hottestKeyShard).toBeUndefined();

    const zipf = shardTopology(1);
    const zipfShard = runFor(zipf.t, 10).snapshot().nodes[zipf.shard.id];
    expect(zipfShard.hottestKeyShard).toBe(0);
    expect(zipfShard.hottestKeyShare).toBeGreaterThan(0.17);
    expect(zipfShard.hottestKeyShare).toBeLessThan(0.26);
  });

  it('turns on and off live', () => {
    const { t, shard } = shardTopology();
    const engine = runFor(t, 5);
    const clientId = t.nodes[0].id;
    engine.updateNodeConfig(clientId, { keySkew: 1.2 });
    for (let i = 0; i < 5 * 60; i++) engine.advance(1000 / 60);
    expect(engine.snapshot().nodes[shard.id].hottestKeyShare).toBeGreaterThan(0.2);
    engine.updateNodeConfig(clientId, { keySkew: 0 });
    engine.advance(1000 / 60);
    expect(engine.snapshot().nodes[shard.id].hottestKeyShare).toBeUndefined();
  });

  it('rides a share link and back', () => {
    const { t } = shardTopology(1.2);
    const back = unpackTopology(packTopology(t));
    expect(back?.nodes[0].config.keySkew).toBe(1.2);
    const plain = unpackTopology(packTopology(shardTopology().t));
    expect(plain?.nodes[0].config.keySkew).toBeUndefined();
    // Off costs nothing on the wire.
    expect(packTopology(shardTopology(0).t).length).toBeGreaterThan(0);
    expect(packTopology(shardTopology().t)).toEqual(packTopology(shardTopology().t));
  });
});
