// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { PATH_KEY } from './pathProgress';
import { TOUR_KEY } from './tourSteps';
import { TASK_HIDDEN_KEY } from './useExampleTask';

/**
 * "Your task" in the whole app, on the running engine, pressed with real
 * pointer sequences. Every tick here comes from the simulation advancing,
 * never from the test setting a step.
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

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

function press(el: Element, pointerType = 'mouse'): void {
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

function button(name: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!el) throw new Error(`no button ${name}`);
  return el;
}

const card = () => document.querySelector<HTMLElement>('.task-card');
const count = () => card()?.querySelector('.task-count')?.textContent ?? '';
const title = () => document.getElementById('task-title')?.textContent ?? '';
const slider = () =>
  document.querySelector<HTMLInputElement>('.traffic-load input[type="range"]');

/** Run the simulation until `done` or the time runs out, in app frames. */
function runUntil(done: () => boolean, seconds: number): void {
  for (let i = 0; i < seconds * 10 && !done(); i += 1) {
    act(() => {
      vi.advanceTimersByTime(100);
    });
  }
}

function setField(label: string, value: string): void {
  const row = [...document.querySelectorAll('.ins label.row-k')].find(
    (l) => l.textContent?.trim() === label,
  );
  const input = row?.closest('.ins-field-row, .ins-field')?.querySelector('input');
  if (!input) throw new Error(`no field ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
  // Not a first visit, so the tour does not take the corner.
  localStorage.setItem(TOUR_KEY, '1');
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('your task', () => {
  it('opens with the example, says what to do, and sits in canvas chrome', () => {
    mount();
    expect(card()).not.toBeNull();
    expect(count()).toBe('Your task, 1 of 3');
    expect(title()).toBe('Find the part that fills up first, then give it room.');
    expect(card()?.closest('[data-chrome]')).not.toBeNull();
    const steps = [...(card()?.querySelectorAll('.task-step') ?? [])];
    expect(steps.map((s) => s.getAttribute('data-at'))).toEqual([
      'now',
      'next',
      'next',
    ]);
    expect(steps[0]?.getAttribute('aria-current')).toBe('step');
  });

  it('ticks off from the run and ends with the lesson and the next step', () => {
    mount();
    press(button('Set it to 200'), 'touch');
    expect(slider()?.getAttribute('aria-valuetext')).toBe('200 requests per second');
    expect(count()).toBe('Your task, 2 of 3');
    // Nothing ticks before the engine shows it: Database has to fill first.
    expect(card()?.querySelector('[data-at="now"]')?.textContent).toContain(
      'Watch Database',
    );
    runUntil(() => count() === 'Your task, 3 of 3', 30);
    expect(count()).toBe('Your task, 3 of 3');
    // The part it is about is ringed on the canvas.
    expect(document.querySelector('.cv-spotlight')).not.toBeNull();
    press(button('Select Database'), 'touch');
    setField('Slots per instance', '12');
    runUntil(() => title() === 'What you learned', 40);
    expect(title()).toBe('What you learned');
    expect(count()).toBe('Your task, done');
    expect(JSON.parse(localStorage.getItem(PATH_KEY) ?? '{}')).toEqual({
      explored: ['single-server'],
    });
    press(button('Next: Load balanced'), 'touch');
    expect(count()).toBe('Your task, 1 of 4');
    expect(title()).toBe(
      'Find out whether more servers help when they share one database.',
    );
  });

  it('does not tick a watching step at the starting load', () => {
    mount();
    runUntil(() => false, 15);
    expect(count()).toBe('Your task, 1 of 3');
  });

  it('folds to a chip that opens it again, and remembers the fold', () => {
    mount();
    press(button('Hide'), 'touch');
    expect(card()).toBeNull();
    const chip = button('Show your task, 1 of 3');
    expect(chip.textContent).toBe('Your task, 1 of 3');
    act(() => root.unmount());
    container.remove();
    mount();
    expect(card()).toBeNull();
    press(button('Show your task, 1 of 3'), 'touch');
    expect(card()).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(TASK_HIDDEN_KEY) ?? '{}')).toEqual({
      hidden: [],
    });
  });

  it('waits for the first-visit tour', () => {
    localStorage.removeItem(TOUR_KEY);
    mount();
    expect(document.querySelector('.tour-card')).not.toBeNull();
    expect(card()).toBeNull();
    expect(document.querySelector('.task-chip')).toBeNull();
    press(button('Skip tour'), 'touch');
    expect(card()).not.toBeNull();
  });

  it('is not shown inside a challenge', () => {
    window.history.replaceState(null, '', '/?challenge=hold-the-line');
    mount();
    expect(document.querySelector('section.chal')).not.toBeNull();
    expect(card()).toBeNull();
    expect(document.querySelector('.task-chip')).toBeNull();
  });

  it('starts over when the same example is opened again', () => {
    mount();
    press(button('Set it to 200'), 'touch');
    expect(count()).toBe('Your task, 2 of 3');
    press(button('Menu'));
    press(button('Examples'));
    const ss = [...document.querySelectorAll<HTMLElement>('.ex-grid button')].find(
      (b) => b.textContent?.includes('Single server'),
    );
    if (!ss) throw new Error('no Single server card');
    press(ss);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(slider()?.getAttribute('aria-valuetext')).toBe('50 requests per second');
    expect(count()).toBe('Your task, 1 of 3');
  });
});
