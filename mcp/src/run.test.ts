import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/sim/presets';
import type { Topology } from '../../src/sim/types';
import { buildTopology } from './design';
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

  it('drops requests on a lossy edge and says why', () => {
    const r = buildTopology({
      nodes: [
        { id: 'users', kind: 'client', config: { rps: 200 } },
        { id: 'api', kind: 'service' },
      ],
      edges: [{ from: 'users', to: 'api', lossRate: 0.1 }],
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const run = runDesign(r.topology, DEFAULT_RUN);
    const lost = run.snapshot.failuresByReason['packet-loss'];
    expect(lost).toBeGreaterThan(0);
    expect(describeRun(r.topology, run, DEFAULT_RUN)).toContain(
      `${lost} were lost on a lossy network link (lossRate)`,
    );
  });

  it('reports each traffic source on its own when there is more than one', () => {
    const stripe = PRESETS.find((p) => p.id === 'stripe')!.topology;
    const broken: Topology = {
      ...stripe,
      faults: [
        {
          atMs: 5000,
          action: 'inject',
          nodeId: 'reportsvc',
          kind: 'slow',
          opts: { factor: 40 },
        },
      ],
    };
    const run = runDesign(broken, DEFAULT_RUN);
    const text = describeRun(broken, run, DEFAULT_RUN);
    const lines = text.split('\n');
    const at = lines.indexOf(
      'By traffic source (each client and its own requests, end to end):',
    );
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^- Merchant API Calls \(id 'merchants'\): offered /);
    expect(lines[at + 2]).toMatch(
      /^- Dashboard Readers \(id 'dashboards'\): offered [\d.]+\/s, served 0\.0\/s, 100\.0% failed; over the run \d+ served, \d+ failed \(/,
    );
    const dash = run.routes.find((r) => r.clientId === 'dashboards')!;
    expect(lines[at + 2]).toContain(`${dash.totalFailed} failed`);
    // One client is the system, already reported.
    expect(
      describeRun(single, runDesign(single, DEFAULT_RUN), DEFAULT_RUN),
    ).not.toContain('By traffic source');
  });
});
