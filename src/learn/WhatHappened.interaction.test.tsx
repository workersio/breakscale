// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';
import { WhatHappened } from './WhatHappened';

/**
 * The panel against a real engine run: it stays away while the run is
 * healthy, comes up by itself on a fault, folds to a button on a real press
 * of Close or on Escape, opens again from that button, and empties on Reset.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function press(el: Element, pointerType = 'mouse'): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 };
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerdown', { ...at, buttons: 1, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerup', { ...at, buttons: 0, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  });
}

const topology: Topology = (() => {
  const p = PRESETS.find((x) => x.id === 'single-server');
  if (!p) throw new Error('no single-server');
  return p.topology;
})();
const db = topology.nodes.find((n) => n.kind === 'db')?.id ?? '';

/** Advance `seconds` at the app's 10Hz, rendering every snapshot. */
function play(engine: Engine, seconds: number): void {
  for (let i = 0; i < seconds * 10; i++) {
    engine.advance(100);
    const snapshot = engine.snapshot();
    act(() => root.render(<WhatHappened topology={topology} snapshot={snapshot} />));
  }
}

const panel = () => container.querySelector('.wh-panel');
const reopen = () => container.querySelector('.wh-reopen');

describe('What just happened', () => {
  it('shows nothing while the run is healthy', () => {
    const engine = new Engine(topology, 1);
    play(engine, 5);
    expect(container.querySelector('.wh')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it.each(['mouse', 'touch'])(
    'comes up on a fault and folds on a real %s press',
    (pointerType) => {
      const engine = new Engine(topology, 1);
      play(engine, 2);
      act(() => {
        engine.injectFailure(db, 'slow', { factor: 5 });
      });
      play(engine, 6);
      const p = panel();
      expect(p?.getAttribute('aria-label')).toBe('What just happened');
      const first = p?.querySelector('.wh-line');
      expect(first?.querySelector('.wh-at')?.textContent).toBe('2.0s');
      expect(first?.querySelector('.wh-text')?.textContent).toBe(
        'Database slowed down 5x.',
      );

      const close = container.querySelector('.wh-close');
      if (!close) throw new Error('no close');
      press(close, pointerType);
      expect(panel()).toBeNull();
      expect(reopen()?.textContent).toBe('What just happened');

      // Folded, it stays folded while the same story goes on...
      play(engine, 1);
      expect(panel()).toBeNull();

      // ...and opens from the button.
      const btn = reopen();
      if (!btn) throw new Error('no reopen');
      press(btn, pointerType);
      expect(panel()?.querySelectorAll('.wh-line').length).toBeGreaterThan(1);
    },
  );

  it('tells a screen reader when it opens by itself, from a status mounted beforehand', () => {
    const engine = new Engine(topology, 1);
    play(engine, 2);
    const live = container.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe('');
    act(() => {
      engine.injectFailure(db, 'slow', { factor: 5 });
    });
    play(engine, 2);
    expect(panel()).not.toBeNull();
    // The same node, so it was registered before it had anything to say.
    expect(container.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toBe('What just happened: Database slowed down 5x.');
    // Closed, it has nothing more to say until something new goes wrong.
    const close = container.querySelector('.wh-close');
    if (!close) throw new Error('no close');
    press(close);
    expect(live?.textContent).toBe('');
  });

  it('folds on Escape and opens again when something new goes wrong', () => {
    const engine = new Engine(topology, 1);
    play(engine, 1);
    act(() => {
      engine.injectFailure(db, 'slow', { factor: 5 });
    });
    play(engine, 3);
    const p = panel();
    if (!p) throw new Error('no panel');
    act(() => {
      p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel()).toBeNull();
    // The line forming behind the slow database is news.
    play(engine, 6);
    expect(panel()).not.toBeNull();
  });

  it('empties on Reset', () => {
    const engine = new Engine(topology, 1);
    act(() => {
      engine.injectFailure(db, 'crash');
    });
    play(engine, 3);
    expect(panel()).not.toBeNull();
    engine.clearFailure(db);
    engine.reset();
    const snapshot = engine.snapshot();
    act(() => root.render(<WhatHappened topology={topology} snapshot={snapshot} />));
    expect(container.querySelector('.wh')).toBeNull();
  });
});
