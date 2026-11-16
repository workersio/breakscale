import { describe, expect, it } from 'vitest';
import { shortcutLabel } from './modKey';

describe('shortcutLabel', () => {
  it('keeps Ctrl off a Mac', () => {
    expect(shortcutLabel('Ctrl+Z', false)).toBe('Ctrl+Z');
    expect(shortcutLabel('Ctrl+Shift+Z', false)).toBe('Ctrl+Shift+Z');
  });

  it('shows the Mac symbols on a Mac', () => {
    expect(shortcutLabel('Ctrl+Z', true)).toBe('⌘Z');
    expect(shortcutLabel('Ctrl+Shift+Z', true)).toBe('⇧⌘Z');
    expect(shortcutLabel('Ctrl+/', true)).toBe('⌘/');
    expect(shortcutLabel('Ctrl while dragging', true)).toBe('⌘ while dragging');
  });

  it('leaves keys without Ctrl alone', () => {
    expect(shortcutLabel('Shift+1', true)).toBe('Shift+1');
    expect(shortcutLabel('Space', true)).toBe('Space');
  });
});
