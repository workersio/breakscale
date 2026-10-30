import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { defaultConfig } from './presets';
import type { NodeConfig, NodeKind, Topology } from './types';

const node = (id: string, kind: NodeKind, o: Partial<NodeConfig>) => ({
  id,
  kind,
  label: id,
  x: 0,
  y: 0,
  config: { ...defaultConfig(kind), ...o },
});

// Kinds that run their own slot pool (state.busy stays 0) next to a plain
// service as the control.
const KINDS: readonly NodeKind[] = [
  'service',
  'db',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'vectordb',
  'replica',
  'shard',
  'coldstorage',
];

function arrivalsBehindLb(kind: NodeKind): number[] {
  const store: Partial<NodeConfig> = {
    capacity: 4,
    shardCapacity: 4,
    shardCount: 1,
    replicaCount: 1,
    readFraction: 1,
    instances: 1,
    serviceMs: 20,
    serviceCv: 0,
    queueLimit: 64,
    lockMs: 0,
    // vectordb: no index-size or recall surcharge, so serviceMs is the cost.
    indexSizeK: 0,
    recallTarget: 0,
  };
  const t: Topology = {
    nodes: [
      node('client', 'client', { rps: 300, timeoutMs: 5000 }),
      node('lb', 'lb', { capacity: 1000, serviceMs: 0, queueLimit: 1000 }),
      node('s0', kind, store),
      node('s1', kind, store),
      node('s2', kind, store),
    ],
    edges: [
      { id: 'c->lb', from: 'client', to: 'lb', weight: 1 },
      { id: 'lb->s0', from: 'lb', to: 's0', weight: 1 },
      { id: 'lb->s1', from: 'lb', to: 's1', weight: 1 },
      { id: 'lb->s2', from: 'lb', to: 's2', weight: 1 },
    ],
  };
  const e = new Engine(t, 1);
  for (let i = 0; i < 600; i++) e.advance(1000 / 60);
  const n = e.snapshot().nodes;
  return ['s0', 's1', 's2'].map((id) => n[id]!.arrivalRate);
}

describe('least-loaded lb in front of pooled kinds', () => {
  for (const kind of KINDS) {
    it(`spreads load across ${kind} nodes`, () => {
      const rates = arrivalsBehindLb(kind);
      // 300 rps over three nodes whose ceiling is 4 x 1000/20 = 200 rps each:
      // one node alone cannot keep up, so every node must get real traffic.
      for (const r of rates) expect(r, rates.join()).toBeGreaterThan(50);
    });
  }

  it('stays deterministic', () => {
    expect(arrivalsBehindLb('db')).toEqual(arrivalsBehindLb('db'));
  });
});
