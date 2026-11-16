// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { presentKeyAction } from './present';

const ev = (key: string, init: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  target: null,
  ...init,
});

describe('presentKeyAction', () => {
  it('P toggles the mode from either side', () => {
    expect(presentKeyAction(ev('p'), false)).toBe('toggle');
    expect(presentKeyAction(ev('P'), true)).toBe('toggle');
  });

  it('X, W and R act only while presenting', () => {
    expect(presentKeyAction(ev('x'), true)).toBe('crash');
    expect(presentKeyAction(ev('w'), true)).toBe('slow');
    expect(presentKeyAction(ev('R'), true)).toBe('fix');
    for (const k of ['x', 'w', 'r']) expect(presentKeyAction(ev(k), false)).toBeNull();
  });

  it('leaves chords and typing alone', () => {
    expect(presentKeyAction(ev('p', { metaKey: true }), false)).toBeNull();
    expect(presentKeyAction(ev('r', { ctrlKey: true }), true)).toBeNull();
    const input = document.createElement('input');
    expect(presentKeyAction(ev('x', { target: input }), true)).toBeNull();
  });
});
