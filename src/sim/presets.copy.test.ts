import { describe, expect, it } from 'vitest';
import { isNote } from './annotations';
import { Engine } from './engine';
import { PRESETS } from './presets';
import type { NodeStats, Topology } from './types';

/**
 * Example copy, held to the engine.
 *
 * Each case pins a claim a preset's notes or description makes to what the
 * engine measures, so a retune that makes the copy wrong fails here instead
 * of teaching a student something false. Every one of these claims was wrong
 * once: the load balanced database was said to top out at 480, the full
 * stack lesson blamed the sharded store for errors the job queue was making,
 * and the Uber breaker was said to trip at 4x when it mostly stays closed.
 *
 * Bounds are loose on purpose. They separate the true story from the false
 * one, not one decimal from the next.
 */

const FRAME = 1000 / 60;
const SEEDS = [1, 2, 3];

function preset(id: string) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
}

function noteText(id: string, noteId: string): string {
  const note = (preset(id).topology.annotations ?? [])
    .filter(isNote)
    .find((n) => n.id === noteId);
  if (!note) throw new Error(`no note ${noteId} on ${id}`);
  return note.text;
}

interface Run {
  /** Per node, the mean of each numeric field over one-second samples. */
  readonly mean: Record<string, Record<string, number>>;
}

/** Scales every client the way the load slider does, warms up, then samples. */
function measure(
  id: string,
  mult: number,
  seed: number,
  warmS = 15,
  windowS = 20,
): Run {
  const topology: Topology = structuredClone(preset(id).topology);
  for (const n of topology.nodes) {
    if (n.kind === 'client') n.config.rps = Math.round((n.config.rps ?? 0) * mult);
  }
  const engine = new Engine(topology, seed);
  for (let i = 0; i < 60 * warmS; i += 1) engine.advance(FRAME);
  const sums: Record<string, Record<string, number>> = {};
  for (let s = 0; s < windowS; s += 1) {
    for (let i = 0; i < 60; i += 1) engine.advance(FRAME);
    for (const [nodeId, snap] of Object.entries(engine.snapshot().nodes)) {
      const acc = (sums[nodeId] ??= {});
      for (const [field, v] of Object.entries(snap as NodeStats)) {
        if (typeof v === 'number') acc[field] = (acc[field] ?? 0) + v / windowS;
      }
    }
  }
  return { mean: sums };
}

describe('example copy agrees with the engine', () => {
  it('load balanced: the database tops out near 430 a second, not 480', () => {
    expect(noteText('load-balanced', 'lb-note-db')).toContain('near 430');
    for (const seed of SEEDS) {
      const db = measure('load-balanced', 4, seed).mean.db;
      expect(db.throughput, `seed ${seed}`).toBeGreaterThan(400);
      expect(db.throughput, `seed ${seed}`).toBeLessThan(450);
    }
  });

  it('full stack: at 4x the client errors come from the full job queue', () => {
    expect(noteText('full-stack', 'fs-note-lesson')).toContain('job queue');
    for (const seed of SEEDS) {
      const m = measure('full-stack', 4, seed).mean;
      // The queue accounts for nearly all of the client's failures, while the
      // sharded store, which the old note blamed, turns almost nothing away.
      expect(m.queue.shedRate, `seed ${seed}`).toBeGreaterThan(0.9 * m.client.shedRate);
      expect(m.shards.shedRate ?? 0, `seed ${seed}`).toBeLessThan(2);
    }
  });

  it('specialised stores: the vector index caps near 240, cold storage throttles', () => {
    const vectors = preset('specialised-stores').topology.nodes.find(
      (n) => n.id === 'vectors',
    );
    expect(vectors?.config.capacity).toBe(12);
    expect(noteText('specialised-stores', 'ss-note-lesson')).not.toContain('sheds');
    const m = measure('specialised-stores', 4, 1).mean;
    expect(m.vectors.throughput).toBeGreaterThan(220);
    expect(m.vectors.throughput).toBeLessThan(260);
    expect(m.glacier.throttledRate).toBeGreaterThan(5);
  });

  it('event driven: at 2x the audit log drops messages and the indexer lags', () => {
    const text = noteText('event-driven', 'ed-note-fanout');
    expect(text).toContain('audit log');
    expect(text).toContain('search indexer');
    for (const seed of SEEDS) {
      const m = measure('event-driven', 2, seed).mean;
      expect(m.audit.shedRate, `seed ${seed}`).toBeGreaterThan(10);
      expect(m.broker.consumerLag, `seed ${seed}`).toBeGreaterThan(200);
      // The three the note says keep up do keep up.
      for (const id of ['billing', 'push', 'metrics']) {
        expect(m[id].shedRate ?? 0, `${id} seed ${seed}`).toBe(0);
      }
    }
  });

  it('uber: at 4x payments turns riders away and about a third of its calls fail', () => {
    const p = preset('uber');
    expect(p.description).not.toContain('without a single rider-facing error');
    const text = noteText('uber', 'ub-note-pay');
    expect(text).toContain('about a third');
    expect(text).toContain('Crash payments');
    for (const seed of SEEDS) {
      // Two minutes, long enough to see the rare trips the note admits to.
      const run = measure('uber', 4, seed, 15, 105);
      expect(run.mean.payments.shedRate, `seed ${seed}`).toBeGreaterThan(2);
      const share = run.mean['pay-brk'].breakerErrorRate;
      expect(share, `seed ${seed}`).toBeGreaterThan(0.2);
      expect(share, `seed ${seed}`).toBeLessThan(0.4);
    }
  }, 60_000);

  it('spotify: three read copies, and the gateway keeps the primary from pinning', () => {
    const pldb = preset('spotify').topology.nodes.find((n) => n.id === 'pldb');
    expect(pldb?.config.replicaCount).toBe(3);
    expect(noteText('spotify', 'sp-note-playlist')).toContain('three read copies');
    expect(preset('spotify').description).not.toContain('idle');
    const m = measure('spotify', 4, 1).mean;
    expect(m.pldb.utilization).toBeLessThan(0.7);
  });

  it('circuit breaker: after a crash it stays open while payments is down', () => {
    expect(noteText('circuit-breaker', 'cb-note-trip')).toContain(
      'only if they succeed',
    );
    const engine = new Engine(structuredClone(preset('circuit-breaker').topology), 1);
    for (let i = 0; i < 60 * 10; i += 1) engine.advance(FRAME);
    engine.injectFailure('payments', 'crash');
    for (let i = 0; i < 60 * 4; i += 1) engine.advance(FRAME);
    // From here the breaker probes every three seconds and the probes fail,
    // so it never reports closed again.
    for (let i = 0; i < 60 * 15; i += 1) {
      engine.advance(FRAME);
      expect(engine.snapshot().nodes.breaker.breakerState).not.toBe('closed');
    }
  });
});
