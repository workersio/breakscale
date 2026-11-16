import { describe, expect, it } from 'vitest';
import {
  EDGE_OUTCOME_SLOTS,
  EO_CUT,
  EO_FAILED,
  EO_FIRST,
  EO_LOST,
  EO_OK,
  EO_REFUSED,
  EO_RETRY,
} from '../sim/edgeOutcomes';
import {
  DOT_FAILED,
  DOT_KINDS,
  DOT_LOST,
  DOT_OK,
  DOT_PENDING,
  DOT_REFUSED,
  distanceAlong,
  DOT_SPEED_PX,
  dotRate,
  flattenRoute,
  outcomeMix,
  pickOutcome,
  pointAt,
} from './dotFlow';
import { EDGE_RADIUS, routeEdge } from './edgeRoute';

function rates(fill: Partial<Record<number, number>>): Float64Array {
  const r = new Float64Array(EDGE_OUTCOME_SLOTS);
  for (const [k, v] of Object.entries(fill)) r[Number(k)] = v ?? 0;
  return r;
}

describe('outcome mix', () => {
  it('splits sends by how they ended', () => {
    const mix = new Float64Array(DOT_KINDS);
    const m = outcomeMix(
      rates({
        [EO_FIRST]: 80,
        [EO_RETRY]: 20,
        [EO_OK]: 70,
        [EO_FAILED]: 10,
        [EO_REFUSED]: 15,
        [EO_LOST]: 5,
      }),
      mix,
    );
    expect(m.sent).toBe(100);
    expect(m.retryShare).toBeCloseTo(0.2);
    expect(mix[DOT_OK]).toBeCloseTo(0.7);
    expect(mix[DOT_FAILED]).toBeCloseTo(0.1);
    expect(mix[DOT_REFUSED]).toBeCloseTo(0.15);
    expect(mix[DOT_LOST]).toBeCloseTo(0.05);
    expect(mix[DOT_PENDING]).toBe(0);
  });

  it('shows the gap between sent and answered as no answer yet', () => {
    const mix = new Float64Array(DOT_KINDS);
    outcomeMix(rates({ [EO_FIRST]: 100, [EO_OK]: 40 }), mix);
    expect(mix[DOT_OK]).toBeCloseTo(0.4);
    expect(mix[DOT_PENDING]).toBeCloseTo(0.6);
  });

  it('never sums past one when answers outrun sends', () => {
    const mix = new Float64Array(DOT_KINDS);
    outcomeMix(rates({ [EO_FIRST]: 50, [EO_OK]: 60, [EO_CUT]: 20 }), mix);
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('is all zero with nothing sent', () => {
    const mix = new Float64Array(DOT_KINDS).fill(9);
    expect(outcomeMix(rates({}), mix).sent).toBe(0);
    expect(Array.from(mix)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('pickOutcome', () => {
  it('keeps every kind within one dot of its share, at every point', () => {
    const mix = new Float64Array([0.9, 0.03, 0.05, 0.02, 0, 0]);
    const acc = new Float64Array(DOT_KINDS);
    const counts = new Array<number>(DOT_KINDS).fill(0);
    for (let n = 1; n <= 1000; n++) {
      counts[pickOutcome(acc, 0, mix)]!++;
      for (let k = 0; k < DOT_KINDS; k++) {
        expect(Math.abs(counts[k]! - mix[k]! * n)).toBeLessThanOrEqual(1);
      }
    }
    expect(counts).toEqual([900, 30, 50, 20, 0, 0]);
  });
});

describe('dot rate', () => {
  it('adds one more dot a second, give or take, per doubling', () => {
    expect(dotRate(0)).toBe(0);
    expect(dotRate(1)).toBeCloseTo(1.25);
    expect(dotRate(2047) - dotRate(1023)).toBeCloseTo(1.25, 2);
  });

  it('ranks wires: a busier one always carries more dots', () => {
    const rates = [0.5, 3, 20, 140, 900, 2000, 5000];
    const dots = rates.map(dotRate);
    for (let i = 1; i < dots.length; i++)
      expect(dots[i]!).toBeGreaterThan(dots[i - 1]!);
  });

  it('keeps dots apart on the busiest wire the app can make', () => {
    // At the fixed speed, the gap between dots in screen px.
    expect(DOT_SPEED_PX / dotRate(5000)).toBeGreaterThan(6);
  });
});

describe('track', () => {
  it('follows the drawn fillets, not the corner', () => {
    const r = routeEdge(
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 300, y: 200, w: 100, h: 40 },
    );
    const t = flattenRoute(r.points, EDGE_RADIUS);
    const corner = r.points[1]!;
    // Every flattened point stays off the hard corner by close to the
    // fillet's own inset, which is r(1 - 1/sqrt 2) = 3.5px at the apex.
    for (let i = 0; i < t.xy.length; i += 2) {
      const d = Math.hypot(t.xy[i]! - corner.x, t.xy[i + 1]! - corner.y);
      expect(d).toBeGreaterThan(3);
    }
    const p = { x: 0, y: 0 };
    pointAt(t, 0, p);
    expect(p).toEqual({ x: r.points[0]!.x, y: r.points[0]!.y });
    pointAt(t, t.length, p);
    const end = r.points[r.points.length - 1]!;
    expect(p.x).toBeCloseTo(end.x);
    expect(p.y).toBeCloseTo(end.y);
  });

  it('finds the break mark along the wire', () => {
    const r = routeEdge({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 });
    const t = flattenRoute(r.points, EDGE_RADIUS);
    const s = distanceAlong(t, r.label);
    const p = { x: 0, y: 0 };
    pointAt(t, s, p);
    expect(p.x).toBeCloseTo(r.label.x, 1);
    expect(p.y).toBeCloseTo(r.label.y, 1);
  });
});
