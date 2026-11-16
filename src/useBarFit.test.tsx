// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { rowOverflows, useBarFit } from './useBarFit';

/**
 * jsdom has no layout, so the geometry is stubbed: each island reports a
 * width, and the traffic control's content width depends on whether the bar
 * is laid out as one row. That dependency is the point of the hook: the
 * answer must come from the ROW layout even while the bar is drawn compact,
 * or it could never find its way back to one row.
 */

let barWidth = 1000;
const TRAFFIC_NEEDS = 500;

function stubGeometry(bar: HTMLElement): void {
  const rect = (right: number) => ({ right }) as DOMRect;
  bar.getBoundingClientRect = () => rect(barWidth);
  for (const island of bar.querySelectorAll<HTMLElement>('.app-island')) {
    Object.defineProperty(island, 'scrollWidth', {
      get: () => 100,
      configurable: true,
    });
    Object.defineProperty(island, 'clientWidth', {
      get: () => 100,
      configurable: true,
    });
    island.getBoundingClientRect = () => rect(Math.min(barWidth, 900));
  }
  const traffic = bar.querySelector<HTMLElement>('.traffic')!;
  // In a row the brand and menu islands take 600px of the bar; compact, the
  // control has the full width.
  const width = () => (bar.dataset.fit === 'row' ? barWidth - 600 : barWidth);
  Object.defineProperty(traffic, 'clientWidth', { get: width, configurable: true });
  Object.defineProperty(traffic, 'scrollWidth', {
    get: () => Math.max(width(), TRAFFIC_NEEDS),
    configurable: true,
  });
}

let observed: ResizeObserverCallback | null = null;
class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    observed = cb;
  }
  observe() {}
  disconnect() {}
}

function Bar() {
  const ref = useRef<HTMLElement | null>(null);
  const compact = useBarFit(ref);
  return (
    <header
      className="app-bar"
      data-fit={compact ? 'compact' : 'row'}
      ref={(el) => {
        ref.current = el;
        if (el) stubGeometry(el);
      }}
    >
      <div className="app-island" />
      <div className="app-island">
        <div className="traffic" />
      </div>
    </header>
  );
}

let container: HTMLDivElement;
let root: Root;
const fit = () => document.querySelector<HTMLElement>('.app-bar')!.dataset.fit;
const resize = (w: number) => {
  barWidth = w;
  act(() => observed?.([], {} as ResizeObserver));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  barWidth = 1200;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useBarFit', () => {
  it('keeps one row while the traffic control fits beside the other islands', () => {
    act(() => root.render(<Bar />));
    expect(fit()).toBe('row');
  });

  it('goes compact when the row would overflow, and back when it fits again', () => {
    act(() => root.render(<Bar />));
    resize(1000); // 400px for a control that needs 500
    expect(fit()).toBe('compact');
    resize(1050);
    expect(fit()).toBe('compact');
    resize(1100); // exactly 500
    expect(fit()).toBe('row');
  });
});

describe('rowOverflows', () => {
  function bar(): HTMLElement {
    const el = document.createElement('header');
    el.innerHTML =
      '<div class="app-island"></div><div class="app-island"><div class="traffic"></div></div>';
    el.dataset.fit = 'row';
    stubGeometry(el);
    return el;
  }

  it('is false when everything fits', () => {
    barWidth = 1200;
    expect(rowOverflows(bar())).toBe(false);
  });

  it('is true when an island runs past the bar', () => {
    barWidth = 1200;
    const el = bar();
    el.getBoundingClientRect = () => ({ right: 850 }) as DOMRect;
    expect(rowOverflows(el)).toBe(true);
  });

  it('allows a pixel of rounding', () => {
    barWidth = 1099.5;
    expect(rowOverflows(bar())).toBe(false);
  });
});
