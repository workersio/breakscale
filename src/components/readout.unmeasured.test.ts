import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { NodeStats, Topology } from '../sim/types';
import { readoutFor } from './Canvas';

/**
 * A box that has not finished a request has no p99. It used to print "0ms",
 * which reads as instant, while the header said n/a for the same moment.
 */

function preset(id: string): Topology {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`no preset ${id}`);
  return found.topology;
}

function statsAfter(topology: Topology, ms: number): Record<string, NodeStats> {
  const engine = new Engine(topology, 1);
  for (let t = 0; t < ms; t += 100) engine.advance(100);
  return engine.snapshot().nodes;
}

function cells(topology: Topology, id: string, stats: NodeStats) {
  const node = topology.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  const r = readoutFor(node.kind, stats, node.config);
  return [r.primary, r.a, r.b];
}

describe('p99 on a box before anything is measured', () => {
  it('reads n/a on every box before the run starts', () => {
    const t = preset('single-server');
    const stats = statsAfter(t, 0);
    for (const id of ['api', 'db']) {
      const nodeStats = stats[id];
      if (!nodeStats) throw new Error(`no stats for ${id}`);
      const p99 = cells(t, id, nodeStats).find((c) => c.label === 'p99');
      expect(p99?.value).toBe('n/a');
    }
  });

  it('reads a real latency once requests finish', () => {
    const t = preset('single-server');
    const db = statsAfter(t, 5000).db;
    if (!db) throw new Error('no db stats');
    expect(db.throughput).toBeGreaterThan(0);
    const p99 = cells(t, 'db', db).find((c) => c.label === 'p99');
    expect(p99?.value).toMatch(/^\d+(\.\d+)?ms$/);
  });

  it('keeps a measured 0ms when the box is serving', () => {
    const t = preset('single-server');
    const db = statsAfter(t, 5000).db;
    if (!db) throw new Error('no db stats');
    const p99 = cells(t, 'db', { ...db, p99: 0 }).find((c) => c.label === 'p99');
    expect(p99?.value).toBe('0ms');
  });

  it('reads n/a on a standby region that gets no traffic', () => {
    const t = preset('multi-region');
    const eu = statsAfter(t, 10_000)['eu-api'];
    if (!eu) throw new Error('no eu-api stats');
    expect(eu.throughput).toBe(0);
    const p99 = cells(t, 'eu-api', eu).find((c) => c.label === 'p99');
    expect(p99?.value).toBe('n/a');
  });
});
