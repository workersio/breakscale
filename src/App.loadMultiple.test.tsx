// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';

/**
 * The header's 1x through the whole app: a design built on an empty canvas
 * gets one from its first client, and a canvas cleared and rebuilt is not
 * measured against the design that was there before.
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

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

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

/** Add one component from the palette, the way a click on its row does. */
function add(kind: string): void {
  const row = document.querySelector(`.pal-row[data-kind="${kind}"]`);
  if (!row) throw new Error(`no palette row for ${kind}`);
  press(row);
}

/** Drag the load slider to a position: press, the value moves, release. */
function drag(to: number): void {
  const slider = document.querySelector<HTMLInputElement>('.traffic-load-track input')!;
  const at = { bubbles: true, cancelable: true, button: 0 };
  act(() => {
    slider.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    set.call(slider, String(to));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    slider.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
  });
}

const chip = () => document.querySelector('.traffic-multiple');

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function session(nodes: unknown[], rps: number): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ topology: { nodes, edges: [] }, rps, presetId: null }),
  );
}

describe('the load multiple', () => {
  it('appears for a design built on an empty canvas', () => {
    session([], 0);
    mount();
    add('client');
    expect(chip()?.textContent).toBe('1.0x');
    const slider = document.querySelector<HTMLInputElement>(
      '.traffic-load-track input',
    )!;
    drag(Number(slider.value) + 40);
    expect(chip()?.textContent).not.toBe('1.0x');
    expect(chip()?.getAttribute('aria-label')).toMatch(/where 1x is 50\/s$/);
  });

  it('starts again from the first client after the old ones are gone', () => {
    // A 1x of 400 left over from a design whose clients were all deleted.
    session([{ ...makeNode('service', 0, 0, 'Service'), id: 'svc' }], 400);
    mount();
    add('client');
    expect(chip()?.textContent).toBe('1.0x');
  });
});
