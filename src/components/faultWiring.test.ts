import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';
import { asReplacement, withSchedule } from './faultWiring';

/*
 * The two calls App makes around engine.setTopology: one when a whole new
 * design replaces the current one, one after an edit to it.
 */

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return structuredClone(p.topology);
}

/** Every snapshot over `frames` 60fps frames. */
function run(engine: Engine, frames: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < frames; i++) {
    engine.advance(1000 / 60);
    out.push(JSON.stringify(engine.snapshot()));
  }
  return out;
}

describe('asReplacement', () => {
  it('an example opened after a seeded replay runs as it does on a fresh load', () => {
    const fresh = run(new Engine(preset('load-balanced')), 300);

    const engine = new Engine({
      ...preset('circuit-breaker'),
      seed: 42,
      faults: [{ atMs: 500, action: 'inject', nodeId: 'payments', kind: 'crash' }],
    });
    run(engine, 120);
    engine.setTopology(asReplacement(preset('load-balanced')));
    engine.reset();

    expect(engine.runSeed()).toBe(1);
    expect(engine.faultSchedule()).toEqual([]);
    expect(run(engine, 300)).toEqual(fresh);
    expect(engine.exportTopology().seed).toBeUndefined();
  });

  it('keeps a seed and schedule the new design brings with it', () => {
    const t = asReplacement({
      ...preset('circuit-breaker'),
      seed: 7,
      faults: [{ atMs: 500, action: 'inject', nodeId: 'payments', kind: 'crash' }],
    });
    expect(t.seed).toBe(7);
    expect(t.faults).toHaveLength(1);
  });
});

describe('withSchedule', () => {
  it('leaves a design with no faults exactly as it was', () => {
    const t = preset('single-server');
    expect(withSchedule(t, [])).toBe(t);
  });

  it('picks up the entry an edit added, so the next edit keeps it', () => {
    const engine = new Engine(preset('load-balanced'));
    run(engine, 30);
    engine.recordCutEdge('lb->api1');
    const before: Topology = {
      ...preset('load-balanced'),
      faults: engine.faultSchedule(),
    };

    const without = {
      ...before,
      edges: before.edges.filter((e) => e.id !== 'lb->api1'),
    };
    engine.setTopology(without);
    const held = withSchedule(without, engine.faultSchedule());
    expect(held.faults?.map((f) => f.action)).toEqual(['cut', 'restore']);

    // The next edit hands back what the shell holds; the restore survives it.
    engine.setTopology({ ...held, edges: before.edges });
    expect(engine.faultSchedule().map((f) => f.action)).toEqual(['cut', 'restore']);
  });
});
