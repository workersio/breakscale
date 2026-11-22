import { describe, expect, it } from 'vitest';
import { formatElapsed, formatPct, formatShareDown, NA } from './components/format';
import { parseDesignFile } from './designFile';
import { decodeTopology, encodeTopology } from './share';
import { packTopology, unpackTopology } from './share/wire';
import { Engine } from './sim/engine';
import { sanitizeFaults } from './sim/faults';
import { makeNode } from './sim/presets';
import { Rng } from './sim/random';
import type { NodeKind, SimEdge, Topology } from './sim/types';
import { trafficPeriodMs } from './sim/workload';

/*
 * Values only a hand-written file, script or link can carry: each one used
 * to come out as NaN, Infinity%, a broken link or a page held for seconds.
 * The repros are the ones in issues #122 to #127.
 */

function clientTo(kind: NodeKind, config: Record<string, number>): Topology {
  const target = makeNode(kind, 200, 0);
  return {
    nodes: [
      { ...makeNode('client', 0, 0), id: 'c' },
      { ...target, id: 's', config: { ...target.config, ...config } },
    ],
    edges: [{ id: 'e', from: 'c', to: 's', weight: 1 }],
  };
}

function nonFinite(value: unknown, path = 'snapshot', out: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => nonFinite(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFinite(v, `${path}.${k}`, out);
  }
  return out;
}
describe('#122: huge service settings draw finite times', () => {
  it('serviceTime stays finite for a huge spread or mean', () => {
    expect(new Rng(1).serviceTime(100, 1.3407807929942598e153)).toBeGreaterThanOrEqual(
      0,
    );
    for (const [mean, cv] of [
      [100, 1.3407807929942598e153],
      [100, 1e154],
      [100, 1e300],
      [1.7976931348623157e308, 0.2],
      [1.7976931348623157e308, 1e300],
      [1.7976931348623157e308, 0],
    ]) {
      const rng = new Rng(7);
      for (let i = 0; i < 2000; i++) {
        const ms = rng.serviceTime(mean, cv);
        expect(Number.isFinite(ms) && ms >= 0, `${mean}, ${cv} -> ${ms}`).toBe(true);
      }
    }
  });

  it('draws in range exactly as the unclamped gamma does', () => {
    for (const [mean, cv] of [
      [5, 0.3],
      [40, 1],
      [250, 2],
      [1e9, 0.5],
    ]) {
      const a = new Rng(3);
      const b = new Rng(3);
      const shape = 1 / (cv * cv);
      for (let i = 0; i < 500; i++) {
        expect(a.serviceTime(mean, cv)).toBe(b.gamma(shape, mean / shape));
      }
    }
  });

  it('a design with serviceCv 1e200 reports finite latencies', () => {
    const t = parseDesignFile(
      JSON.stringify({
        app: 'breakscale',
        version: 1,
        topology: clientTo('service', { serviceCv: 1e200 }),
      }),
    );
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const engine = new Engine(t.topology, 1);
    for (let i = 0; i < 300; i++) engine.advance(1000 / 60);
    expect(nonFinite(engine.snapshot())).toEqual([]);
  });

  it.each(['queue', 'retryqueue', 'writebehind'] as const)(
    'a %s with serviceMs 1.7e308 reports finite percentiles',
    (kind) => {
      const engine = new Engine(clientTo(kind, { serviceMs: 1.7e308 }), 0);
      for (let i = 0; i < 30; i++) engine.advance(1000 / 60);
      const s = engine.snapshot().nodes.s;
      for (const p of [s.p50, s.p95, s.p99]) expect(Number.isFinite(p)).toBe(true);
      expect(nonFinite(engine.snapshot())).toEqual([]);
    },
  );

  it('trafficPeriodMs is 0 when the period overflows in milliseconds', () => {
    const config = makeNode('client', 0, 0).config;
    expect(trafficPeriodMs({ ...config, trafficPeriodS: 1.8e305 })).toBe(0);
    expect(trafficPeriodMs({ ...config, trafficPeriodS: 30 })).toBe(30_000);
  });
});

describe('#123: a partition that lists one connection twice', () => {
  const t: Topology = {
    nodes: [
      { ...makeNode('client', 0, 0), id: 'n0' },
      { ...makeNode('lb', 200, 0), id: 'n1' },
    ],
    edges: [{ id: 'e0', from: 'n0', to: 'n1', weight: 1 }],
    faults: [
      {
        atMs: 0,
        action: 'inject',
        nodeId: 'n0',
        kind: 'partition',
        opts: { edgeIds: ['e0', 'e0'] },
      },
    ],
  };

  it('sanitizeFaults keeps each connection once', () => {
    const [f] = sanitizeFaults(t.faults, t);
    expect(f.action === 'inject' && f.opts?.edgeIds).toEqual(['e0']);
  });

  it('builds a link that opens with the partition intact', async () => {
    const r = await decodeTopology(await encodeTopology(t));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.topology.faults).toEqual([
      {
        atMs: 0,
        action: 'inject',
        nodeId: 'client-1',
        kind: 'partition',
        opts: { edgeIds: ['client-1->lb-1'] },
      },
    ]);
  });

  it('opens the link from the issue, built before repeats were dropped', async () => {
    const r = await decodeTopology('d3.AWNiZAADxgnMIIqJiVGGgYGJgQEA');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const [f] = r.topology.faults ?? [];
    expect(f.action === 'inject' && f.opts?.edgeIds).toEqual(['client-1->lb-1']);
  });
});

describe('#124: readouts never print Infinity or negative seconds', () => {
  it.each([
    ['formatPct(1e307)', () => formatPct(1e307), NA],
    ['formatShareDown(1.8e305)', () => formatShareDown(1.8e305), NA],
    ['formatElapsed(MAX_VALUE)', () => formatElapsed(Number.MAX_VALUE), NA],
  ])('%s', (_, run, want) => {
    expect(run()).toBe(want);
  });

  it('formatElapsed keeps the seconds in 00..59 past 2^53 seconds', () => {
    expect(formatElapsed(270217779711706100)).toBe('4503629661861768m 32s');
  });

  it('reads sane values as before', () => {
    expect(formatPct(0.5)).toBe('50%');
    expect(formatPct(3)).toBe('300%');
    expect(formatShareDown(0.9996)).toBe('99.9%');
    expect(formatElapsed(59.94)).toBe('59.9s');
    expect(formatElapsed(125.3)).toBe('2m 05s');
    expect(formatElapsed(3599.99)).toBe('59m 59s');
  });
});

describe('#125: a short link with many repeated connections opens fast', () => {
  const LINK = 'd3.Ae3BQQEAAAQEsCOgbCKr4bGtdtIBAAAAAAAAAAAAAAAAAAAAAAAAIF8c';

  it('decodes the issue link in well under a second', async () => {
    const t0 = performance.now();
    const r = await decodeTopology(LINK);
    const ms = performance.now() - t0;
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.topology.edges).toHaveLength(10_000);
    // Was about 2700ms in bun on an M-series Mac; now about 3ms.
    expect(ms).toBeLessThan(500);
  });

  it('names repeats exactly as the old probe did', () => {
    const a = { ...makeNode('service', 0, 0), id: 'a' };
    const b = { ...makeNode('service', 200, 0), id: 'b' };
    const pairs: [string, string][] = [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'b'],
      ['a', 'a'],
      ['a', 'b'],
      ['a', 'a'],
      ['b', 'a'],
    ];
    const edges: SimEdge[] = pairs.map(([from, to], i) => ({
      id: `e${i}`,
      from,
      to,
      weight: 1,
    }));
    const back = unpackTopology(packTopology({ nodes: [a, b], edges }));
    // The probe this replaced: the first free of base, base~2, base~3...
    const taken = new Set<string>();
    const want = pairs.map(([from, to]) => {
      const base = `service-${from === 'a' ? 1 : 2}->service-${to === 'a' ? 1 : 2}`;
      let id = base;
      for (let k = 2; taken.has(id); k++) id = `${base}~${k}`;
      taken.add(id);
      return id;
    });
    expect(back?.edges.map((e) => e.id)).toEqual(want);
  });
});
