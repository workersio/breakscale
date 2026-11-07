import { describe, expect, it } from 'vitest';
import { FIT_MAX, FIT_MIN, FIT_MIN_NARROW, fitViewport } from './fit';
import type { FitBounds, FitRect } from './fit';

/* Hold the line's three cards in a row: client at x=40, database at x=660,
   184 wide and 88 tall. 804 x 88 world px. */
const threeInARow: FitBounds = { minX: 40, minY: 200, maxX: 844, maxY: 288 };

/* A 390x844 phone during a brief: the canvas runs from under the header
   (top 295) to the tab bar (bottom 788). */
const phoneSurface: FitRect = { left: 0, top: 295, width: 390, height: 493 };
const sheetFolded = 69;
const sheetOpen = 246;
const above = (sheet: number): FitRect => ({
  ...phoneSurface,
  height: phoneSurface.height - sheet,
});

/** The fitted content's rect on screen. */
function onScreen(b: FitBounds, surface: FitRect, view: FitRect) {
  const v = fitViewport(b, surface, view);
  if (!v) throw new Error('no fit');
  return {
    k: v.k,
    left: surface.left + v.x + b.minX * v.k,
    right: surface.left + v.x + b.maxX * v.k,
    top: surface.top + v.y + b.minY * v.k,
    bottom: surface.top + v.y + b.maxY * v.k,
  };
}

describe('fit with the challenge sheet up on a phone', () => {
  it('centres the diagram in the room above the folded sheet', () => {
    const view = above(sheetFolded);
    const r = onScreen(threeInARow, phoneSurface, view);
    expect((r.top + r.bottom) / 2).toBeCloseTo(view.top + view.height / 2, 5);
    expect(r.bottom).toBeLessThan(view.top + view.height);
  });

  it('centres it again above the open sheet, never under it', () => {
    const view = above(sheetOpen);
    const r = onScreen(threeInARow, phoneSurface, view);
    expect((r.top + r.bottom) / 2).toBeCloseTo(view.top + view.height / 2, 5);
    expect(r.bottom).toBeLessThan(phoneSurface.top + phoneSurface.height - sheetOpen);
  });

  it('zooms out below 0.7 so three cards fit a 390px width', () => {
    const r = onScreen(threeInARow, phoneSurface, above(sheetFolded));
    expect(r.k).toBeLessThan(FIT_MIN);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(390);
    expect((r.left + r.right) / 2).toBeCloseTo(195, 5);
  });

  it('stops at the phone floor and centres what overflows', () => {
    const wide: FitBounds = { minX: 0, minY: 0, maxX: 2000, maxY: 300 };
    const r = onScreen(wide, phoneSurface, above(sheetFolded));
    expect(r.k).toBe(FIT_MIN_NARROW);
    expect((r.left + r.right) / 2).toBeCloseTo(195, 5);
  });

  it('returns null for a canvas with no area yet', () => {
    expect(fitViewport(threeInARow, phoneSurface, { ...phoneSurface, height: 0 })).toBe(
      null,
    );
  });
});

describe('fit on a desktop', () => {
  const surface: FitRect = { left: 0, top: 0, width: 1440, height: 900 };

  it('keeps the 0.7 floor, even when open rails leave less than 720px', () => {
    // Rail on the left, challenge panel on the right.
    const view: FitRect = { left: 224, top: 0, width: 500, height: 900 };
    const r = onScreen(threeInARow, surface, view);
    expect(r.k).toBe(FIT_MIN);
  });

  it('frames the diagram clear of the side panel when it fits', () => {
    const view: FitRect = { left: 224, top: 0, width: 852, height: 900 };
    const r = onScreen(threeInARow, surface, view);
    expect(r.left).toBeGreaterThanOrEqual(view.left);
    expect(r.right).toBeLessThanOrEqual(view.left + view.width);
    expect((r.left + r.right) / 2).toBeCloseTo(view.left + view.width / 2, 5);
  });

  it('never blows a small diagram up past the ceiling', () => {
    const one: FitBounds = { minX: 0, minY: 0, maxX: 184, maxY: 88 };
    expect(onScreen(one, surface, surface).k).toBe(FIT_MAX);
  });
});
