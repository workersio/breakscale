// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { TOUR_KEY } from './tourSteps';

/**
 * An answer belongs to the run it was read from. In the whole app, a Reset
 * starts a new run, and once that run's clock passes the old answer's time
 * the old sentence must not come back.
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

let container: HTMLDivElement;
let root: Root;

function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  });
}

function button(name: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!el) throw new Error(`no button ${name}`);
  return el;
}

function run(ms: number): void {
  for (let t = 0; t < ms; t += 100) {
    act(() => {
      vi.advanceTimersByTime(100);
    });
  }
}

const answer = () => document.querySelector('.fp [role="status"]')?.textContent ?? '';

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
  localStorage.setItem(TOUR_KEY, '1');
  window.history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Find the problem across runs', () => {
  it('does not bring an old answer back after a Reset', () => {
    run(2000);
    press(button('Find the problem'));
    expect(answer()).toMatch(/^Nothing is struggling right now\./);
    press(button('Reset simulation'));
    expect(answer()).toBe('');
    // Well past the time the old answer was read at.
    run(4000);
    expect(answer()).toBe('');
  });
});
