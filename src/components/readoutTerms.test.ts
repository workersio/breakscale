import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';
import { GLOSSARY_BY_ID } from '../content/glossary';
import { readoutFor } from './Canvas';
import { allReadoutTermIds, readoutTermFor } from './readoutTerms';

/**
 * The words on a node's box are explained in the inspector through
 * `readoutTermFor`. These pin that every explanation it hands out exists,
 * and that every word a real run puts on a box was given one or was
 * decided to be plain enough without, so a new readout label cannot ship
 * unexplained by accident.
 */

/** Words read as plain English with no entry of their own. */
const PLAIN = new Set([
  'in',
  'out',
  'passed',
  'search',
  'index',
  'append',
  'new',
  'jobs',
  'deliver',
  'publish',
  'flushed',
  'acked',
  'running',
  'high in',
  'next run',
  'burst',
  // The autoscaler's phase word sits in the label slot.
  'observing',
  'warming',
  'cooldown',
  'steady',
]);

function scaled(t: Topology, factor: number): Topology {
  return {
    ...t,
    nodes: t.nodes.map((n) =>
      n.kind === 'client' && n.config.rps !== undefined
        ? { ...n, config: { ...n.config, rps: n.config.rps * factor } }
        : n,
    ),
  };
}

/** Every (kind, label) the presets print, at their default load and at 4x. */
function labelsSeen(): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  for (const preset of PRESETS) {
    for (const factor of [1, 4]) {
      const topology = scaled(preset.topology, factor);
      const engine = new Engine(topology, 1);
      for (let i = 0; i < 60; i += 1) engine.advance(100);
      const snap = engine.snapshot();
      for (const node of topology.nodes) {
        const stats = snap.nodes[node.id];
        if (!stats) continue;
        const r = readoutFor(node.kind, stats, node.config);
        for (const label of [r.primary.label, r.a.label, r.b.label]) {
          if (!label) continue;
          const set = seen.get(node.kind) ?? new Set<string>();
          set.add(label);
          seen.set(node.kind, set);
        }
      }
    }
  }
  return seen;
}

describe('readout terms', () => {
  it('points only at glossary entries that exist', () => {
    expect(allReadoutTermIds().filter((id) => !GLOSSARY_BY_ID.has(id))).toEqual([]);
  });

  it('explains or deliberately skips every word a preset puts on a box', () => {
    const seen = labelsSeen();
    // A guard on the guard: the sweep has to reach a real spread of kinds.
    expect(seen.size).toBeGreaterThan(15);
    const unexplained: string[] = [];
    for (const [kind, labels] of seen) {
      for (const label of labels) {
        const id = readoutTermFor(kind as Parameters<typeof readoutTermFor>[0], label);
        if (!id && !PLAIN.has(label)) unexplained.push(`${kind}: ${label}`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it('resolves a shared word per kind where it means something different', () => {
    expect(readoutTermFor('ratelimiter', 'refused')).toBe('throttled');
    expect(readoutTermFor('breaker', 'refused')).toBe('rejected');
    expect(readoutTermFor('websocket', 'refused')).toBe('conn-refused');
    expect(readoutTermFor('lambda', 'cold')).toBe('cold-start');
    expect(readoutTermFor('shard', 'cold')).toBe('shard');
  });

  it('explains the three words on a plain server', () => {
    expect(readoutTermFor('service', 'busy')).toBe('utilisation');
    expect(readoutTermFor('service', 'p99')).toBe('p99');
    expect(readoutTermFor('service', 'waiting')).toBe('backlog');
  });
});
