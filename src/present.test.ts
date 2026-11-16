// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { presentKeyAction } from './present';

const ev = (key: string, init: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...init,
});

describe('presentKeyAction', () => {
  it('Shift+P toggles the mode from either side', () => {
    expect(presentKeyAction(ev('P', { shiftKey: true }), false)).toBe('toggle');
    expect(presentKeyAction(ev('P', { shiftKey: true }), true)).toBe('toggle');
  });

  /* A bare P put the owner into presenting by accident, side panels gone.
     Caps Lock types "P" with no Shift held, so that is not Shift+P either. */
  it('a bare P, or P with Caps Lock, does nothing', () => {
    expect(presentKeyAction(ev('p'), false)).toBeNull();
    expect(presentKeyAction(ev('P'), false)).toBeNull();
    expect(presentKeyAction(ev('p'), true)).toBeNull();
  });

  it('X, W and R act only while presenting', () => {
    expect(presentKeyAction(ev('x'), true)).toBe('crash');
    expect(presentKeyAction(ev('w'), true)).toBe('slow');
    expect(presentKeyAction(ev('R'), true)).toBe('fix');
    for (const k of ['x', 'w', 'r']) expect(presentKeyAction(ev(k), false)).toBeNull();
  });

  it('leaves chords and typing alone', () => {
    expect(
      presentKeyAction(ev('P', { metaKey: true, shiftKey: true }), false),
    ).toBeNull();
    expect(presentKeyAction(ev('r', { ctrlKey: true }), true)).toBeNull();
    const input = document.createElement('input');
    expect(presentKeyAction(ev('x', { target: input }), true)).toBeNull();
    expect(
      presentKeyAction(ev('P', { shiftKey: true, target: input }), false),
    ).toBeNull();
  });
});
