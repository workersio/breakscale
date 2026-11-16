import { describe, expect, it } from 'vitest';
import { aimedIndex, formatAt, nearestBy, steppedIndex } from './chartReadout';

const ts = [0, 250, 500, 750, 1000].map((t) => ({ t }));
const id = (s: { t: number }) => s.t;

describe('nearestBy', () => {
  it('picks the closest key, the earlier one on a tie', () => {
    expect(nearestBy(ts, id, -50)).toBe(0);
    expect(nearestBy(ts, id, 120)).toBe(0);
    expect(nearestBy(ts, id, 125)).toBe(0);
    expect(nearestBy(ts, id, 126)).toBe(1);
    expect(nearestBy(ts, id, 760)).toBe(3);
    expect(nearestBy(ts, id, 5000)).toBe(4);
  });

  it('is -1 for nothing to pick from', () => {
    expect(nearestBy([], id, 3)).toBe(-1);
    expect(nearestBy(ts, id, Number.NaN)).toBe(-1);
  });
});

describe('formatAt', () => {
  it('says which 250ms sample it is, without trailing zeros', () => {
    expect(formatAt(12_250)).toBe('at 12.25s');
    expect(formatAt(12_500)).toBe('at 12.5s');
    expect(formatAt(13_000)).toBe('at 13s');
    expect(formatAt(0)).toBe('at 0s');
    expect(formatAt(10_000)).toBe('at 10s');
  });
});

describe('aimedIndex', () => {
  const x = (t: number) => t / 10; // 0..100px

  it('follows the pointer to the nearest sample', () => {
    expect(aimedIndex(ts, { kind: 'pointer', px: 48 }, x)).toBe(2);
    expect(aimedIndex(ts, null, x)).toBe(-1);
  });

  it('reads nothing over the part of the window the run has not reached', () => {
    const late = (t: number) => 50 + t / 20; // oldest sample at 50px
    expect(aimedIndex(ts, { kind: 'pointer', px: 43 }, late)).toBe(0);
    expect(aimedIndex(ts, { kind: 'pointer', px: 41 }, late)).toBe(-1);
  });

  it('holds a picked sample until it leaves the window', () => {
    expect(aimedIndex(ts, { kind: 'sample', t: 750, by: 'key' }, x)).toBe(3);
    const later = ts.slice(4);
    expect(aimedIndex(later, { kind: 'sample', t: 750, by: 'touch' }, x)).toBe(-1);
    // A reset: time starts again below the picked sample.
    expect(aimedIndex([{ t: 0 }], { kind: 'sample', t: 750, by: 'key' }, x)).toBe(-1);
  });
});

describe('steppedIndex', () => {
  it('starts at the newest and stops at the ends', () => {
    expect(steppedIndex('ArrowLeft', -1, 5)).toBe(4);
    expect(steppedIndex('ArrowRight', -1, 5)).toBe(4);
    expect(steppedIndex('ArrowLeft', 2, 5)).toBe(1);
    expect(steppedIndex('ArrowLeft', 0, 5)).toBe(0);
    expect(steppedIndex('ArrowRight', 4, 5)).toBe(4);
    expect(steppedIndex('Home', 3, 5)).toBe(0);
    expect(steppedIndex('End', 0, 5)).toBe(4);
  });

  it('ignores other keys and empty charts', () => {
    expect(steppedIndex('a', 2, 5)).toBeNull();
    expect(steppedIndex('ArrowLeft', -1, 0)).toBeNull();
  });
});
