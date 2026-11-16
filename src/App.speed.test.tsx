// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * Play speed from the bar and from [ and ]. The engine only ever sees
 * advance(dt) in frame-sized steps (speed.test.ts); this is the shell.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = true;
  }
}

const SESSION_KEY = 'breakscale.session.v1';

function ownDesign(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'mine-client', label: 'My client' };
  const svc = { ...makeNode('service', 240, 0), id: 'mine-svc', label: 'My service' };
  return {
    nodes: [client, svc],
    edges: [{ id: 'mine-client->mine-svc', from: client.id, to: svc.id, weight: 1 }],
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

/** A press the way a finger or a mouse makes one, ending in the click. */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0 }));
  });
}

const clock = () => document.querySelector('.cv-ledger-time')?.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ topology: ownDesign(), rps: 50, presetId: null }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const speedBtn = () => document.querySelector<HTMLButtonElement>('.transport-speed')!;

function keyDown(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });
}

/** Sim seconds on the ledger after `ms` of frames from a zeroed clock. */
function simAfter(ms: number): number {
  press(document.querySelector('[aria-label="Reset simulation"]')!);
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  return Number.parseFloat(clock() ?? 'NaN');
}

describe('play speed', () => {
  it('starts at 1x and the button steps round the speeds', () => {
    mount();
    expect(speedBtn().textContent).toBe('1×');
    press(speedBtn());
    expect(speedBtn().textContent).toBe('2×');
    press(speedBtn());
    expect(speedBtn().textContent).toBe('4×');
    press(speedBtn());
    expect(speedBtn().textContent).toBe('0.5×');
    expect(speedBtn().getAttribute('aria-label')).toBe(
      'Speed 0.5 times. Press for 1 times',
    );
  });

  it('[ and ] step slower and faster, hold at the ends, and are said aloud', () => {
    mount();
    keyDown(']');
    keyDown(']');
    keyDown(']');
    expect(speedBtn().textContent).toBe('4×');
    keyDown('[');
    expect(speedBtn().textContent).toBe('2×');
    expect(document.querySelector('.traffic [aria-live="polite"]')?.textContent).toBe(
      'Speed 2 times',
    );
    keyDown('[');
    keyDown('[');
    keyDown('[');
    expect(speedBtn().textContent).toBe('0.5×');
    // A modifier belongs to the browser.
    keyDown(']', { metaKey: true });
    expect(speedBtn().textContent).toBe('0.5×');
  });

  it('2x moves the clock twice as far in the same frames', () => {
    mount();
    const one = simAfter(2000);
    keyDown(']');
    const two = simAfter(2000);
    expect(one).toBeGreaterThan(1);
    expect(two / one).toBeGreaterThan(1.8);
    expect(two / one).toBeLessThan(2.2);
  });
});
