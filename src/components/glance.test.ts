import { describe, expect, it } from 'vitest';
import { DETAIL_ZOOM, FIT_MIN_NARROW } from './fit';
import {
  GLANCE_NAME_PX,
  GLANCE_VALUE_PX,
  MIN_TAP_PX,
  glanceLayout,
  glanceScale,
  nodeHitPad,
} from './glance';

describe('glanceScale', () => {
  it('is off at and above the detail zoom, where the full card draws', () => {
    expect(glanceScale(DETAIL_ZOOM)).toBe(0);
    expect(glanceScale(1)).toBe(0);
  });

  it('keeps the value at 12 screen px across the fitted range', () => {
    for (const k of [0.4, 0.45, 0.5, 0.6, 0.69]) {
      const s = glanceScale(k);
      // Quantised to 0.05, so within 2.5 percent of the target.
      expect(GLANCE_VALUE_PX * s * k).toBeGreaterThan(11.6);
      expect(GLANCE_VALUE_PX * s * k).toBeLessThan(12.4);
    }
  });

  it('stops growing past the phone fit floor', () => {
    expect(glanceScale(0.2)).toBe(glanceScale(FIT_MIN_NARROW));
  });
});

describe('glanceLayout', () => {
  it('fits both lines above the meter at the largest scale it is given', () => {
    const s = glanceScale(FIT_MIN_NARROW);
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

describe('nodeHitPad', () => {
  it('makes a card at the phone fit floor at least 44 screen px tall to a finger', () => {
    const k = FIT_MIN_NARROW;
    const s = glanceScale(k);
    const pad = nodeHitPad(s, 88);
    expect((88 + pad * 2) * k).toBeGreaterThanOrEqual(MIN_TAP_PX - 0.5);
  });

  it('adds nothing where the card is already tall enough', () => {
    expect(nodeHitPad(glanceScale(0.6), 88)).toBe(0);
    expect(nodeHitPad(0, 88)).toBe(0);
  });
});
