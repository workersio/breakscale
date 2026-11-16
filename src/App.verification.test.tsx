// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { challengeById } from './sim/challenges';

/**
 * A brief from the "Checking correctness" track, played the way a reader
 * plays it: open it, let the check fail it on the data, put idempotency
 * keys on Payments with a real press, and watch the check pass it.
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

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
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

function must(name: string): HTMLElement {
  const el = [
    ...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]'),
  ].find(
    (b) =>
      b.getAttribute('aria-label') === name ||
      b.textContent?.trim() === name ||
      b.querySelector('.ex-item-name')?.textContent === name,
  );
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const chip = () => document.querySelector('.chal-chip')?.textContent;
const panel = () => document.querySelector('section.chal');

function settleCheck(): void {
  for (let i = 0; i < 80; i++) {
    advance(250);
    const c = chip();
    if (c && c !== 'Changed' && c !== 'Not checked yet' && c !== 'Checking') return;
  }
}

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

describe('Charged twice', () => {
  it('fails on the data, names a charged request, and passes with keys at Payments', () => {
    const brief = challengeById('charged-twice');
    if (!brief) throw new Error('no brief');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<App />));

    press(must('Menu'));
    press(must('Challenges'));
    press(must(brief.name));
    advance(400);
    expect(panel()?.textContent).toContain(brief.name);

    settleCheck();
    // The design as the brief hands it over, so the miss is the brief's own.
    expect(chip()).toBe('As it starts');
    expect(panel()?.textContent).toMatch(
      /\d+ payments were charged more than once, and the goal is none\./,
    );
    press(must('Details'));
    expect(panel()?.textContent).toMatch(/Request \d+ was charged twice at Payments/);
    expect(panel()?.textContent).toContain('Then it plays 5s more');

    const pay = [...document.querySelectorAll('[data-hit="node"]')].find(
      (n) => n.getAttribute('data-id') === 'pay',
    );
    if (!pay) throw new Error('no Payments on the canvas');
    press(pay);
    const toggle = [...document.querySelectorAll('.ins .ins-toggle')].find((l) =>
      l.textContent?.includes('idempotency key'),
    );
    const box = toggle?.querySelector('input');
    if (!box) throw new Error('no idempotency key toggle');
    // Whether Payments charges is the brief's, not the reader's.
    const charges = [...document.querySelectorAll('.ins .ins-toggle')].find((l) =>
      l.textContent?.includes('charges money'),
    );
    expect(charges?.querySelector('input')?.disabled).toBe(true);
    press(box);
    expect(box.checked).toBe(true);

    settleCheck();
    expect(chip()).toBe('Passed');
    expect(panel()?.textContent).toContain(brief.lesson);
  }, 60_000);
});
