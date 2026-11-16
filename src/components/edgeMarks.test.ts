import { describe, expect, it } from 'vitest';
import { MARK_OFFSET, markOffset, midLeg } from './edgeMarks';
import { routeEdge } from './edgeRoute';

const BOX = { w: 184, h: 88 };

describe('midLeg', () => {
  it('finds the leg under the label on a straight run, normal pointing down', () => {
    const r = routeEdge({ x: 0, y: 0, ...BOX }, { x: 400, y: 0, ...BOX }, 0);
    const leg = midLeg(r.points, r.label);
    expect(leg).not.toBeNull();
    expect(leg?.ux).toBeCloseTo(1);
    expect(leg?.uy).toBeCloseTo(0);
    expect(leg?.ny).toBe(1);
    expect(leg?.nx).toBe(0);
    expect((leg?.back ?? 0) + (leg?.ahead ?? 0)).toBeGreaterThan(200);
  });

  it('points against travel on a back edge and keeps the normal down', () => {
    const r = routeEdge({ x: 400, y: 0, ...BOX }, { x: 0, y: 0, ...BOX }, 0);
    const leg = midLeg(r.points, r.label);
    expect(leg?.ux).toBeCloseTo(-1);
    expect(leg?.ny).toBe(1);
  });

  it('puts marks to the right of a vertical leg', () => {
    const r = routeEdge({ x: 0, y: 0, ...BOX }, { x: 0, y: 300, ...BOX }, 0);
    const leg = midLeg(r.points, r.label);
    expect(leg?.uy).toBeCloseTo(1);
    expect(leg?.nx).toBe(1);
  });

  it('returns null with no leg', () => {
    expect(midLeg([{ x: 0, y: 0 }], { x: 0, y: 0 })).toBeNull();
    expect(
      midLeg(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        { x: 5, y: 40 },
      ),
    ).toBeNull();
  });
});

describe('markOffset', () => {
  it('keeps marks clear of the bends on a short leg', () => {
    expect(markOffset(200)).toBe(MARK_OFFSET);
    expect(markOffset(30)).toBe(16);
    expect(markOffset(5)).toBe(0);
  });
});
