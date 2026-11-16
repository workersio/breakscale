// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TrafficControl } from './Inspector';
import type { SystemStats } from '../sim/types';

/**
 * The bar's load control on a touch screen, and its p99 slot in an outage.
 * A finger on a short log track jumps 50 to 5k in one drag, so touch adds
 * step buttons and makes the scale marks tappable.
 */

let container: HTMLDivElement;
let root: Root;

/* jsdom has no PointerEvent; React reads pointerType off this one. */
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

/** A press the way a finger makes one, ending in the click. */
function press(el: Element | null | undefined, pointerType = 'touch'): void {
  if (!el) throw new Error('nothing to press');
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
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

function stubPointer(coarse: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

const SYSTEM: SystemStats = {
  timeMs: 10_000,
  offeredRps: 50,
  goodputRps: 50,
  errorRate: 0,
  p50: 30,
  p95: 80,
  p99: 120,
  totalRequests: 500,
  totalFailed: 0,
};

function show(
  rps: number,
  onRpsChange: (rps: number) => void,
  system: SystemStats = SYSTEM,
): void {
  act(() =>
    root.render(
      <TrafficControl
        rps={rps}
        onRpsChange={onRpsChange}
        running
        onToggleRun={() => {}}
        onStep={() => {}}
        onReset={() => {}}
        system={system}
        lost={0}
        empty={false}
        noTrafficSource={false}
      />,
    ),
  );
}

function button(name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
    ) ?? null
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('load control on a touch screen', () => {
  it('steps along a ladder of round numbers', () => {
    stubPointer(true);
    const change = vi.fn();
    show(50, change);
    press(button('More load'));
    expect(change).toHaveBeenLastCalledWith(70);
    press(button('Less load'));
    expect(change).toHaveBeenLastCalledWith(30);
    // Off the ladder, a press goes to the next rung that way.
    show(260, change);
    press(button('More load'));
    expect(change).toHaveBeenLastCalledWith(300);
  });

  it('cannot step past either end', () => {
    stubPointer(true);
    show(5000, vi.fn());
    expect(button('More load')?.disabled).toBe(true);
    show(1, vi.fn());
    expect(button('Less load')?.disabled).toBe(true);
  });

  it('sets the load from a tapped scale mark', () => {
    stubPointer(true);
    const change = vi.fn();
    show(50, change);
    press(button('1k'));
    expect(change).toHaveBeenLastCalledWith(1000);
    // Out of the tab order: the slider already reaches every value.
    expect(button('1k')?.tabIndex).toBe(-1);
  });

  it('adds nothing for a mouse', () => {
    stubPointer(false);
    show(50, vi.fn());
    expect(button('More load')).toBeNull();
    expect(button('1k')).toBeNull();
  });
});

describe('p99 in an outage', () => {
  it('says no replies instead of n/a while requests fail and none return', () => {
    stubPointer(false);
    show(50, vi.fn(), { ...SYSTEM, goodputRps: 0, p99: 0, errorRate: 1 });
    expect(container.querySelector('.traffic-no-replies')?.textContent).toBe(
      'no replies',
    );
  });

  it('keeps the measured figure otherwise', () => {
    stubPointer(false);
    show(50, vi.fn());
    expect(container.querySelector('.traffic-no-replies')).toBeNull();
    expect(container.querySelector('.num-hero')?.textContent).toBe('120ms');
  });
});
