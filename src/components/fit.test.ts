import { describe, expect, it } from 'vitest';
import {
  FIT_MAX,
  FIT_MIN,
  FIT_MIN_NARROW,
  FIT_MIN_TIGHT,
  cuePan,
  fitViewport,
  overflowOf,
} from './fit';
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
function onScreen(b: FitBounds, surface: FitRect, view: FitRect, tight = false) {
  const v = fitViewport(b, surface, view, tight);
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

  it('fits all three cards on a 360px phone', () => {
    const surface: FitRect = { left: 0, top: 160, width: 360, height: 524 };
    const r = onScreen(threeInARow, surface, surface);
    expect(r.k).toBeGreaterThanOrEqual(FIT_MIN_NARROW);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right).toBeLessThanOrEqual(360);
  });

  it('stops at the phone floor and starts what overflows at its left end', () => {
    // Centred, a diagram this wide showed its middle with neither end on
    // screen. The left end is the traffic source, where a flow is read from.
    const wide: FitBounds = { minX: 0, minY: 0, maxX: 2000, maxY: 300 };
    const r = onScreen(wide, phoneSurface, above(sheetFolded));
    expect(r.k).toBe(FIT_MIN_NARROW);
    expect(r.left).toBeCloseTo(24, 5);
    expect(r.right).toBeGreaterThan(390);
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

/* Loud and quiet, the widest brief: 1484 x 348 world px. */
const loudAndQuiet: FitBounds = { minX: 0, minY: 0, maxX: 1484, maxY: 348 };

describe('fit during a brief on a desktop', () => {
  const surface: FitRect = { left: 0, top: 0, width: 1440, height: 900 };
  // 1440 wide with the components rail (224) and the brief (364) open, under
  // the bar (80).
  const beside: FitRect = { left: 224, top: 80, width: 852, height: 820 };

  it('keeps every card clear of the brief, zooming out past 0.7 to do it', () => {
    const r = onScreen(loudAndQuiet, surface, beside, true);
    expect(r.k).toBeLessThan(FIT_MIN);
    expect(r.k).toBeGreaterThanOrEqual(FIT_MIN_TIGHT);
    expect(r.left).toBeGreaterThanOrEqual(beside.left);
    expect(r.right).toBeLessThanOrEqual(beside.left + beside.width);
  });

  it('left the last cards under the brief before, which is the bug', () => {
    const r = onScreen(loudAndQuiet, surface, beside);
    expect(r.right).toBeGreaterThan(beside.left + beside.width);
  });

  it('takes a tighter margin first when that keeps the numbers', () => {
    // 760 wide fits a 700px room at 0.7 only with the 24px margin.
    const mid: FitBounds = { minX: 0, minY: 0, maxX: 960, maxY: 88 };
    const room: FitRect = { ...beside, width: 720 };
    const r = onScreen(mid, surface, room, true);
    expect(r.k).toBeGreaterThanOrEqual(FIT_MIN);
    expect(r.left).toBeGreaterThanOrEqual(room.left);
    expect(r.right).toBeLessThanOrEqual(room.left + room.width);
  });

  it('never goes below the tight floor, and starts at the left when it spills', () => {
    const room: FitRect = { ...beside, width: 500 };
    const r = onScreen(loudAndQuiet, surface, room, true);
    expect(r.k).toBe(FIT_MIN_TIGHT);
    expect(r.left).toBeCloseTo(room.left + 24, 5);
  });

  it('leaves an example at the 0.7 floor', () => {
    // FIT_MIN's reason still holds outside a brief: the numbers stay, and
    // the overflow runs off to the right rather than under the rail.
    const r = onScreen(loudAndQuiet, surface, beside);
    expect(r.k).toBe(FIT_MIN);
    expect(r.left).toBeCloseTo(beside.left + 64, 5);
  });

  it('means nothing on a phone, which has its own floor', () => {
    const r = onScreen(loudAndQuiet, phoneSurface, above(sheetFolded), true);
    expect(r.k).toBe(FIT_MIN_NARROW);
  });
});

describe('edge cues', () => {
  const view = { left: 0, top: 300, right: 390, bottom: 700 };

  it('names the sides that still have boxes past them', () => {
    expect(overflowOf({ left: 24, top: 400, right: 690, bottom: 600 }, view)).toEqual({
      left: false,
      right: true,
      any: true,
    });
    expect(overflowOf({ left: 24, top: 400, right: 366, bottom: 600 }, view).any).toBe(
      false,
    );
    expect(overflowOf({ left: 24, top: 200, right: 366, bottom: 600 }, view).any).toBe(
      true,
    );
  });

  it('pans most of a screen toward the hidden side', () => {
    const dx = cuePan('right', { left: 24, top: 400, right: 1200, bottom: 600 }, view);
    expect(dx).toBeCloseTo(-390 * 0.8, 5);
  });

  it('stops with the far end in, at the fit margin', () => {
    const box = { left: 24, top: 400, right: 500, bottom: 600 };
    const dx = cuePan('right', box, view);
    expect(box.right + dx).toBeCloseTo(390 - 24, 5);
    const after = { ...box, left: box.left + dx, right: box.right + dx };
    expect(overflowOf(after, view)).toMatchObject({ left: true, right: false });
    expect(cuePan('right', after, view)).toBe(0);
  });

  it('pans back the other way', () => {
    const box = { left: -200, top: 400, right: 366, bottom: 600 };
    expect(box.left + cuePan('left', box, view)).toBeCloseTo(24, 5);
  });
});
