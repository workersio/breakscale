import { describe, expect, it } from 'vitest';
import { parseDesignFile } from './designFile';
import { Engine } from './sim/engine';
import { makeNode } from './sim/presets';
import { Rng } from './sim/random';
import type { NodeKind, Topology } from './sim/types';
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
