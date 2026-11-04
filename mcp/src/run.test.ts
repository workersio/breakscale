import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/sim/presets';
import type { Topology } from '../../src/sim/types';
import { DEFAULT_RUN, describeRun, runDesign } from './run';

const single = PRESETS.find((p) => p.id === 'single-server')!.topology;

describe('runDesign', () => {
  it('says the same thing for the same seed', () => {
    const a = describeRun(single, runDesign(single, DEFAULT_RUN), DEFAULT_RUN);
    const b = describeRun(single, runDesign(single, DEFAULT_RUN), DEFAULT_RUN);
    expect(a).toBe(b);
  });

  it('runs on the design’s own seed when it has one, and says which', () => {
    const seeded: Topology = { ...single, seed: 9 };
    const run = runDesign(seeded, DEFAULT_RUN);
    expect(run.seed).toBe(9);
    expect(describeRun(seeded, run, DEFAULT_RUN)).toContain('with seed 9');
    expect(JSON.stringify(run.snapshot)).toBe(
      JSON.stringify(runDesign(single, { ...DEFAULT_RUN, seed: 9 }).snapshot),
    );
    expect(runDesign(single, DEFAULT_RUN).seed).toBe(DEFAULT_RUN.seed);
  });

  it('plays the design’s fault schedule', () => {
    const db = single.nodes.find((n) => n.kind === 'db');
    if (!db) throw new Error('fixture has no db');
    const broken: Topology = {
      ...single,
      faults: [{ atMs: 5000, action: 'inject', nodeId: db.id, kind: 'crash' }],
    };
    const run = runDesign(broken, DEFAULT_RUN);
    expect(run.snapshot.failuresByReason.crashed).toBeGreaterThan(0);
    expect(runDesign(single, DEFAULT_RUN).snapshot.failuresByReason.crashed).toBe(0);
  });

  it('stops at its budget and says so', () => {
    const opts = { ...DEFAULT_RUN, budgetMs: 0 };
    const run = runDesign(single, opts);
    expect(run.simulatedMs).toBe(0);
    expect(describeRun(single, run, opts)).toContain('stopped at 0s of 30s');
  });

  it('names the component that saturates', () => {
    const heavy = structuredClone(single);
    for (const n of heavy.nodes) if (n.kind === 'client') n.config.rps *= 4;
    const text = describeRun(heavy, runDesign(heavy, DEFAULT_RUN), DEFAULT_RUN);
    const first = text.split('\n').find((l) => l.startsWith('- '));
    expect(first).toMatch(/\(db, id '/);
  });
});
