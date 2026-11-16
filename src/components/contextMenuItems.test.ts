import { describe, expect, it, vi } from 'vitest';
import { makeNode } from '../sim/presets';
import type { ActiveFailure, Topology } from '../sim/types';
import { menuItems, menuScope, menuTitle, placeMenu } from './contextMenuItems';
import type { MenuFacts, MenuTarget } from './contextMenuItems';
import { LONG_PRESS_MS, longPressable, startLongPress } from './pointerInput';

const topo: Topology = {
  nodes: [
    { ...makeNode('client', 0, 0), id: 'c', label: 'Client' },
    { ...makeNode('service', 240, 0), id: 's', label: 'API Server' },
    { ...makeNode('db', 480, 0), id: 'd', label: 'Database' },
  ],
  edges: [{ id: 's->d', from: 's', to: 'd', weight: 1 }],
};

function facts(over: Partial<MenuFacts> = {}): MenuFacts {
  return {
    topology: topo,
    selectedIds: new Set(),
    fault: null,
    canSlow: true,
    cable: null,
    lossRate: 0,
    canPaste: true,
    mac: false,
    coarse: false,
    ...over,
  };
}

const labels = (t: MenuTarget, f: MenuFacts) => menuItems(t, f).map((i) => i.label);
const S: MenuTarget = { kind: 'node', id: 's' };

describe('a part menu', () => {
  it('offers the common actions, the faults and delete', () => {
    expect(labels(S, facts())).toEqual([
      'Inspect',
      'Duplicate',
      'Copy',
      'Connect to…',
      'Crash',
      'Slow down 5x',
      'Delete',
    ]);
    expect(menuTitle(S, facts())).toBe('API Server');
  });

  it('prints the keys for the reader own platform, and none on touch', () => {
    const hints = (f: MenuFacts) => menuItems(S, f).map((i) => i.hint ?? '');
    expect(hints(facts())).toEqual(['', 'Ctrl+D', 'Ctrl+C', 'L', '', '', '']);
    expect(hints(facts({ mac: true }))[1]).toBe('⌘D');
    expect(hints(facts({ coarse: true })).every((h) => h === '')).toBe(true);
  });

  it('offers Fix for a fault in force, and Crash unless it is a crash', () => {
    const slow: ActiveFailure = { nodeId: 's', kind: 'slow', factor: 5, sinceMs: 0 };
    const crash: ActiveFailure = { nodeId: 's', kind: 'crash', sinceMs: 0 };
    expect(labels(S, facts({ fault: slow }))).toContain('Crash');
    expect(labels(S, facts({ fault: slow }))).toContain('Fix');
    expect(labels(S, facts({ fault: slow }))).not.toContain('Slow down 5x');
    expect(labels(S, facts({ fault: crash }))).not.toContain('Crash');
    expect(labels(S, facts({ fault: crash }))).toContain('Fix');
  });

  it('does not offer Slow for a kind with no service time', () => {
    expect(labels(S, facts({ canSlow: false }))).not.toContain('Slow down 5x');
  });

  it('stands for the whole selection when pressed inside one', () => {
    const sel = new Set(['s', 'd', 's->d']);
    expect(menuScope(S, sel, topo)).toEqual(['s', 'd']);
    expect(menuTitle(S, facts({ selectedIds: sel }))).toBe('2 components');
    expect(labels(S, facts({ selectedIds: sel }))).toEqual([
      'Inspect',
      'Duplicate all 2',
      'Copy all 2',
      'Delete all 2',
    ]);
    // A part outside the selection acts alone.
    expect(menuScope({ kind: 'node', id: 'c' }, sel, topo)).toEqual(['c']);
  });

  it('is empty for a part that is gone', () => {
    expect(menuItems({ kind: 'node', id: 'gone' }, facts())).toEqual([]);
  });
});

describe('a cable menu', () => {
  const E: MenuTarget = { kind: 'edge', id: 's->d' };
  it('offers cut, loss and delete for a working cable', () => {
    expect(labels(E, facts({ cable: 'connected' }))).toEqual([
      'Inspect',
      'Cut cable',
      'Add 10% packet loss',
      'Delete connection',
    ]);
    expect(menuTitle(E, facts())).toBe('API Server to Database');
  });
  it('offers Restore for a cut cable and nothing for a partitioned one', () => {
    expect(labels(E, facts({ cable: 'cut' }))).toContain('Restore cable');
    const part = labels(E, facts({ cable: 'partitioned' }));
    expect(part).not.toContain('Restore cable');
    expect(part).not.toContain('Cut cable');
  });
  it('offers to remove loss that is set', () => {
    expect(labels(E, facts({ cable: 'connected', lossRate: 0.05 }))).toContain(
      'Remove packet loss',
    );
  });
});

describe('the canvas menu', () => {
  const C: MenuTarget = { kind: 'canvas' };
  it('offers paste, add and fit', () => {
    expect(labels(C, facts())).toEqual([
      'Paste here',
      'Add component here',
      'Fit diagram',
    ]);
    expect(menuTitle(C, facts())).toBeNull();
  });
  it('shows Paste as inert with nothing to paste, and no Fit on an empty canvas', () => {
    const items = menuItems(
      C,
      facts({ canPaste: false, topology: { nodes: [], edges: [] } }),
    );
    expect(items.find((i) => i.action === 'paste')?.disabled).toBe(true);
    expect(items.map((i) => i.action)).not.toContain('fit');
  });
});

describe('where the menu sits', () => {
  const win = { w: 390, h: 844 };
  const size = { w: 200, h: 300 };
  it('puts a mouse menu at the pointer and flips it at the edges', () => {
    expect(placeMenu({ x: 50, y: 60 }, size, win, 'mouse')).toEqual({
      left: 50,
      top: 60,
    });
    expect(placeMenu({ x: 380, y: 800 }, size, win, 'mouse')).toEqual({
      left: 180,
      top: 500,
    });
  });
  it('keeps a touch menu clear of the finger, above it when there is room', () => {
    const above = placeMenu({ x: 195, y: 600 }, size, win, 'touch');
    expect(above.top + size.h).toBeLessThanOrEqual(600 - 20);
    const below = placeMenu({ x: 195, y: 100 }, size, win, 'touch');
    expect(below.top).toBeGreaterThanOrEqual(100 + 20);
    // Never off the side of a phone.
    const edge = placeMenu({ x: 5, y: 600 }, size, win, 'touch');
    expect(edge.left).toBe(8);
  });
  it('goes beside the finger on a phone on its side', () => {
    const land = { w: 844, h: 390 };
    const tall = { w: 208, h: 374 };
    const right = placeMenu({ x: 729, y: 205 }, tall, land, 'touch');
    expect(right.left + tall.w).toBeLessThanOrEqual(729 - 20);
    const left = placeMenu({ x: 100, y: 205 }, tall, land, 'touch');
    expect(left.left).toBeGreaterThanOrEqual(100 + 20);
  });
});

describe('long-press', () => {
  it('is for fingers and pens, not a mouse', () => {
    expect(longPressable('touch')).toBe(true);
    expect(longPressable('pen')).toBe(true);
    expect(longPressable('mouse')).toBe(false);
  });
  it('fires once after the delay, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    startLongPress(1, fire);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    const lp = startLongPress(2, late);
    vi.advanceTimersByTime(200);
    lp.cancel();
    lp.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(late).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
