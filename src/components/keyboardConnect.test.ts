import { describe, expect, it } from 'vitest';
import { connectOrder, firstPick, nearestToward, stepPick } from './keyboardConnect';
import { rovingIndex } from './roving';
import { libraryShown } from '../oneRail';

/*
 *   a(0,0)    b(200,0)    c(400,0)
 *             d(200,150)  e(400,300)
 */
const P = [
  { id: 'b', x: 200, y: 0 },
  { id: 'c', x: 400, y: 0 },
  { id: 'd', x: 200, y: 150 },
  { id: 'e', x: 400, y: 300 },
];

describe('keyboard connect picking', () => {
  it('reads the diagram left to right, then down', () => {
    expect(connectOrder(P).map((p) => p.id)).toEqual(['b', 'd', 'c', 'e']);
  });

  it('offers the nearest part downstream first', () => {
    expect(firstPick({ x: 0, y: 0 }, P)).toBe('b');
  });

  it('falls back to the nearest part when nothing is to the right', () => {
    expect(firstPick({ x: 500, y: 10 }, P)).toBe('c');
    expect(firstPick({ x: 0, y: 0 }, [])).toBeNull();
  });

  it('prefers a part straight ahead over a closer one off to the side', () => {
    expect(nearestToward({ x: 200, y: 0 }, P, 'right', 'b')?.id).toBe('c');
    expect(nearestToward({ x: 200, y: 0 }, P, 'down', 'b')?.id).toBe('d');
    expect(nearestToward({ x: 200, y: 0 }, P, 'up', 'b')).toBeNull();
  });

  it('steps by direction, then by reading order, so every part is reachable', () => {
    expect(stepPick('b', P, 'down')).toBe('d');
    expect(stepPick('b', P, 'right')).toBe('c');
    // Nothing above b: the one before it in reading order, wrapping round.
    expect(stepPick('b', P, 'up')).toBe('e');
    expect(stepPick('e', P, 'down')).toBe('b');
    // Every part is reachable from every other with the arrows.
    for (const start of P) {
      const seen = new Set([start.id]);
      const queue = [start.id];
      while (queue.length > 0) {
        const at = queue.shift()!;
        for (const dir of ['left', 'right', 'up', 'down'] as const) {
          const next = stepPick(at, P, dir);
          if (next && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size).toBe(P.length);
    }
  });

  it('starts from the first in order when the current pick is gone', () => {
    expect(stepPick('gone', P, 'right')).toBe('b');
    expect(stepPick('b', [], 'right')).toBeNull();
  });
});

describe('roving focus', () => {
  it('moves one row, stops at the ends, and ignores other keys', () => {
    expect(rovingIndex('ArrowDown', 0, 3)).toBe(1);
    expect(rovingIndex('ArrowDown', 2, 3)).toBe(2);
    expect(rovingIndex('ArrowUp', 0, 3)).toBe(0);
    expect(rovingIndex('Home', 2, 3)).toBe(0);
    expect(rovingIndex('End', 0, 3)).toBe(2);
    expect(rovingIndex('a', 0, 3)).toBeNull();
    expect(rovingIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('one rail at a time', () => {
  it('hides the wanted rail only where one fits and the inspector is shown', () => {
    expect(libraryShown(true, false, true)).toBe(true);
    expect(libraryShown(true, true, true)).toBe(false);
    expect(libraryShown(true, true, false)).toBe(true);
    expect(libraryShown(false, true, false)).toBe(false);
  });
});
