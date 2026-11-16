// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { INCIDENTS } from '../sim/incidents';
import { PRESETS } from '../sim/presets';
import { TOUR_KEY } from './tourSteps';

/**
 * What a review of the path found, kept fixed: an outage's story over an
 * example left that example marked open, a keyboard lost its place when
 * the path dialog or the tour went, and undo framed the diagram again.
 * Pressed with real pointer sequences, in the whole app.
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

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function press(el: Element, detail = 1): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerdown', { ...at, buttons: 1, pointerType: 'mouse' }),
    );
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerup', { ...at, buttons: 0, pointerType: 'mouse' }),
    );
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail }));
  });
}

/** Enter on a focused button: a click with no pointer and a detail of 0. */
function enter(el: HTMLElement): void {
  act(() => {
    el.focus();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function key(code: string, init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code, ...init }),
    );
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

const dialog = () =>
  document.querySelector<HTMLElement>('[aria-labelledby="lp-title"]');

function openPath(): HTMLElement {
  press(must('Menu'));
  press(must('Learning path'));
  const d = dialog();
  if (!d) throw new Error('no learning path dialog');
  return d;
}

/** A window whose width matches only the given max-width queries. */
function windowAt(width: number): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) : false,
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

const card = () => document.querySelector<HTMLElement>('.task-card');
const story = () => document.querySelector<HTMLElement>('section.chal.inc');
const railOpen = () =>
  document.querySelector('.app-body')?.classList.contains('has-library') ?? false;
const first = PRESETS[0]!;
const s3 = INCIDENTS[0]!;

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

describe('an outage story over an example', () => {
  it('marks only the outage as current, and Start puts the story away', () => {
    mount();
    expect(card()).not.toBeNull();
    press(must(`Start step 43, ${s3.name}`, openPath()));
    advance(400);
    expect(story()).not.toBeNull();

    const d = openPath();
    const current = [...d.querySelectorAll('[aria-current="step"]')];
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain(s3.name);
    expect(d.textContent).not.toContain('It is open behind this dialog.');

    // Not open, so it loads: the story would otherwise stay over it.
    press(must(`Start step 1, ${first.name}`, d));
    advance(400);
    expect(story()).toBeNull();
    expect(card()).not.toBeNull();
  });
});

describe('a keyboard', () => {
  it('lands on the task card after opening an example from the path', () => {
    mount();
    const d = openPath();
    enter(must('Start step 2, Load balanced', d));
    advance(400);
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(card());
  });

  it('lands on the task card after skipping the tour', () => {
    localStorage.removeItem(TOUR_KEY);
    mount();
    const skip = must('Skip tour');
    enter(skip);
    expect(card()).not.toBeNull();
    expect(document.activeElement).toBe(card());
  });

  it('keeps its place when a step button it pressed goes away', () => {
    mount();
    const select = [...card()!.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.startsWith('Select '),
    );
    // The first step sets the load; the select comes once that is done.
    const load = [...card()!.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.startsWith('Set it to'),
    );
    const btn = (select ?? load)!;
    enter(btn);
    advance(100);
    expect(btn.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('is not moved by a pointer press on a step button', () => {
    mount();
    const load = [...card()!.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.startsWith('Set it to'),
    )!;
    press(load);
    advance(100);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('undo', () => {
  it('does not frame the diagram again or close the rail when the task card comes back', () => {
    windowAt(820);
    mount();
    expect(railOpen()).toBe(false);
    press(must('Show components'));
    expect(railOpen()).toBe(true);

    const db = document.querySelector('[data-hit="node"][data-kind="db"]');
    if (!db) throw new Error('no database on the canvas');
    press(db);
    key('Delete', { key: 'Delete' });
    expect(document.querySelector('[data-hit="node"][data-kind="db"]')).toBeNull();
    key('KeyZ', { key: 'z', ctrlKey: true });
    expect(document.querySelector('[data-hit="node"][data-kind="db"]')).not.toBeNull();
    expect(card()).not.toBeNull();
    /* Undo puts the selection back with the part, and on a tablet the
       inspector takes the rail's side while it shows, as it did before the
       delete. Letting go of the selection hands the side back to the rail. */
    expect(document.querySelector('.app-body.has-inspector')).not.toBeNull();
    key('Escape', { key: 'Escape' });
    expect(railOpen()).toBe(true);
  });
});
