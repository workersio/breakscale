// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { challengeById } from '../sim/challenges';
import { TOUR_KEY } from './tourSteps';

/**
 * What the first-time walkthrough of the learning path found, kept fixed:
 * on a tablet the components rail left no canvas beside a brief, and on a
 * phone the folded task could not be opened while the settings sheet was
 * up. Pressed with real pointer sequences, in the whole app.
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

function press(el: Element, pointerType = 'touch'): void {
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

function find(name: string, scope: ParentNode = document): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
    ) ?? null
  );
}

function must(name: string, scope: ParentNode = document): HTMLElement {
  const el = find(name, scope);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

/** Open the path and press a step's own button. */
function fromPath(label: string): void {
  press(must('Menu'));
  press(must('Learning path'));
  const d = document.querySelector<HTMLElement>('[aria-labelledby="lp-title"]');
  if (!d) throw new Error('no learning path dialog');
  press(must(label, d));
  act(() => {
    vi.advanceTimersByTime(400);
  });
}

/** A window whose width matches only the given max-width queries. */
function windowAt(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) : query.includes('coarse'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      };
    }),
  );
}

const body = () => document.querySelector<HTMLElement>('.app-body');
const railOpen = () => body()?.classList.contains('has-library') ?? false;
const card = () => document.querySelector<HTMLElement>('.task-card');
const hold = challengeById('hold-the-line')!;

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

describe('on a tablet', () => {
  it('closes the components rail once as a brief opens, and leaves it to the student after', () => {
    windowAt(820);
    // The example's task card is already open on a first load, so the rail
    // went then. Opened again by hand, it stays.
    mount();
    expect(card()).not.toBeNull();
    expect(railOpen()).toBe(false);
    press(must('Show components'));
    expect(railOpen()).toBe(true);
    // A brief is a new panel opening, so it closes once more.
    fromPath(`Start step 3, ${hold.name}`);
    expect(document.querySelector('section.chal .chal-name')?.textContent).toBe(
      hold.name,
    );
    expect(railOpen()).toBe(false);
    press(must('Show components'));
    expect(railOpen()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(railOpen()).toBe(true);
  });

  it('leaves the rail alone on a desktop wide enough for both', () => {
    windowAt(1440);
    mount();
    expect(card()).not.toBeNull();
    expect(railOpen()).toBe(true);
    fromPath(`Start step 3, ${hold.name}`);
    expect(railOpen()).toBe(true);
  });
});

describe('on a phone', () => {
  it('opens the folded task from its chip, putting the settings sheet away', () => {
    windowAt(390);
    mount();
    expect(card()).not.toBeNull();
    // The task's own button selects the part, and the settings sheet that
    // comes up folds the card to its chip.
    press(must('Set it to 200'));
    const node = document.querySelector('[data-hit="node"][data-kind="db"]');
    if (!node) throw new Error('no database on the canvas');
    press(node);
    expect(document.querySelector('.ins')).not.toBeNull();
    expect(card()).toBeNull();
    const chip = document.querySelector<HTMLElement>('.task-chip');
    expect(chip?.getAttribute('aria-label')).toMatch(/^Show your task, \d of 3$/);
    press(chip!);
    expect(card()).not.toBeNull();
    expect(document.querySelector('.task-chip')).toBeNull();
  });
});
