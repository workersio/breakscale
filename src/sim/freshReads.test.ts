import { describe, expect, it } from 'vitest';
import { playBaseline } from './breakit';
import type { SeedRun } from './breakit';
import { Engine } from './engine';
import { PRESETS } from './presets';
import type { SimSnapshot, Topology } from './types';

/**
 * Reads from the primary while the copies are behind, on the read replicas
 * example: a read of a record its replicas have not caught up on goes to
 * the primary and takes one of its write slots, so nobody reads the past.
 */

function replicas(freshReads?: number): Topology {
  const p = PRESETS.find((x) => x.id === 'read-replicas');
  if (!p) throw new Error('no read-replicas preset');
  const t = structuredClone(p.topology);
  if (freshReads === undefined) return t;
  return {
    ...t,
    nodes: t.nodes.map((n) =>
      n.kind === 'replica' ? { ...n, config: { ...n.config, freshReads } } : n,
    ),
  };
}

function snapshotAt(t: Topology, seconds: number): SimSnapshot {
  const e = new Engine(t, 1);
  for (let i = 0; i < seconds * 60; i++) e.advance(1000 / 60);
  return e.snapshot();
}

function staleReads(t: Topology): (number | null)[] {
  const it = playBaseline(t, { metric: 'staleReads', max: 0 });
  for (;;) {
    const step = it.next();
    if (step.done) return step.value.runs.map((r: SeedRun) => r.actual);
  }
}

describe('reads from the primary while the copies are behind', () => {
  it('plays exactly as before when it is off', () => {
    const before = JSON.stringify(snapshotAt(replicas(), 10));
    expect(JSON.stringify(snapshotAt(replicas(0), 10))).toBe(before);
  });

  it('leaves no read that misses its own saved write', () => {
    expect(staleReads(replicas())).toEqual([314, 307, 272]);
    expect(staleReads(replicas(1))).toEqual([0, 0, 0]);
  });

  it('serves no stale read at all, and says how many reads the primary took', () => {
    const off = snapshotAt(replicas(), 20).nodes.replicas;
    const on = snapshotAt(replicas(1), 20).nodes.replicas;
    expect(off?.staleReadRate).toBeGreaterThan(0);
    expect(off?.primaryReadShare).toBeUndefined();
    expect(on?.staleReadRate).toBe(0);
    // Every read the copies would have served stale went to the primary.
    expect(on?.primaryReadShare).toBeCloseTo(off?.staleReadRate ?? 0, 1);
    expect(on?.primaryReadShare).toBeGreaterThan(0);
  });
});
