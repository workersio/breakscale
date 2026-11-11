import { describe, expect, it } from 'vitest';
import { TITLE_GAP, titleClearPan } from './titleClear';
import type { Box } from './titleClear';

const box = (left: number, top: number, w: number, h: number): Box => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

// The answer card in the top-left corner of a 1440 by 900 canvas.
const CARD = box(12, 90, 340, 120);
const VIEW = box(0, 48, 1440, 852);

describe('clearing titles from under the answer card', () => {
  it('stays put when no title is under the card', () => {
    expect(titleClearPan(CARD, [box(400, 100, 120, 16)], VIEW, null)).toEqual({
      dx: 0,
      dy: 0,
    });
  });

  it('pans down just past the card when that is the shorter way', () => {
    const titles = [box(40, 190, 120, 16)];
    const pan = titleClearPan(CARD, titles, VIEW, null);
    expect(pan).toEqual({ dx: 0, dy: CARD.bottom + TITLE_GAP - 190 });
  });

  it('pans right when that is shorter than down', () => {
    const titles = [box(300, 100, 120, 16)];
    const pan = titleClearPan(CARD, titles, VIEW, null);
    expect(pan).toEqual({ dx: CARD.right + TITLE_GAP - 300, dy: 0 });
  });

  it('does not push another title under the card', () => {
    // Down by 28 clears the first title but lands the second on the card.
    const titles = [box(300, 190, 120, 16), box(40, 60, 120, 16)];
    const pan = titleClearPan(CARD, titles, VIEW, null);
    expect(pan).toEqual({ dx: CARD.right + TITLE_GAP - 300, dy: 0 });
  });

  it('keeps the named box in view', () => {
    const titles = [box(40, 100, 120, 16)];
    // Right by 320 would carry the named box off the right edge.
    const keep = box(1200, 400, 200, 120);
    const pan = titleClearPan(CARD, titles, VIEW, keep);
    expect(pan).toEqual({ dx: 0, dy: CARD.bottom + TITLE_GAP - 100 });
  });

  it('gives up when neither pan keeps the named box in view, so the caller refits', () => {
    // A phone: the card spans the width and the named box sits at the bottom.
    const card = box(8, 90, 374, 140);
    const view = box(0, 48, 390, 700);
    const titles = [box(20, 120, 120, 16)];
    const keep = box(20, 600, 200, 120);
    expect(titleClearPan(card, titles, view, keep)).toBeNull();
  });
});
