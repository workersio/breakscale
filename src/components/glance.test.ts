import { describe, expect, it } from 'vitest';
import { DETAIL_ZOOM, FIT_MIN_NARROW } from './fit';
import { GLANCE_NAME_PX, GLANCE_VALUE_PX, glanceLayout, glanceScale } from './glance';

describe('glanceScale', () => {
  it('is off on a mouse, whatever the zoom', () => {
    expect(glanceScale(0.4, false)).toBe(0);
  });

  it('is off at and above the detail zoom, where the full card draws', () => {
    expect(glanceScale(DETAIL_ZOOM, true)).toBe(0);
    expect(glanceScale(1, true)).toBe(0);
  });

  it('keeps the value at 12 screen px across the fitted range', () => {
    for (const k of [0.4, 0.45, 0.5, 0.6, 0.69]) {
      const s = glanceScale(k, true);
      // Quantised to 0.05, so within 2.5 percent of the target.
      expect(GLANCE_VALUE_PX * s * k).toBeGreaterThan(11.6);
      expect(GLANCE_VALUE_PX * s * k).toBeLessThan(12.4);
    }
  });

  it('stops growing past the phone fit floor', () => {
    expect(glanceScale(0.2, true)).toBe(glanceScale(FIT_MIN_NARROW, true));
  });
});

describe('glanceLayout', () => {
  it('fits both lines above the meter at the largest scale it is given', () => {
    const s = glanceScale(FIT_MIN_NARROW, true);
    const g = glanceLayout(s);
    // The value's descent stays clear of the meter at y=80.
    expect(g.valueY + g.valueSize * 0.25).toBeLessThanOrEqual(80);
    // The value's cap height starts below the name's line box.
    expect(g.valueY - g.valueSize * 0.75).toBeGreaterThan(8 + g.nameSize * 1.2 - 2);
  });

  it('scales the name to 11 screen px', () => {
    expect(glanceLayout(2).nameSize).toBe(GLANCE_NAME_PX * 2);
  });
});
