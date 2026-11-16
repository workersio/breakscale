// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * The command palette and presenting mode, through the shell: the chord,
 * the menu row, typing, the arrows, Enter and Escape; then P and the three
 * fault keys.
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

/** A press the way a mouse makes one, ending in the click. */
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

/** A key on whatever has focus, bubbling to the window like a real one. */
function key(k: string, init: KeyboardEventInit = {}): void {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

/** Typing into the focused box the way React hears it. */
function type(text: string): void {
  const input = document.activeElement as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const dialog = () =>
  document.querySelector('[role="dialog"][aria-label="Search actions"]');
const combobox = () => document.querySelector<HTMLInputElement>('.cp-input');
const nodeLabels = () =>
  Array.from(document.querySelectorAll('[data-hit="node"]')).map((n) =>
    n.getAttribute('data-id'),
  );

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

describe('command palette', () => {
  it('Ctrl+K opens it with focus in the box; typing "netf" and Enter opens Netflix', () => {
    mount();
    const opener = document.querySelector<HTMLButtonElement>('.app-menu-btn');
    opener?.focus();
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(combobox());

    type('netf');
    const first = document.querySelector('.cp-row');
    expect(first?.textContent).toContain('Netflix');
    expect(combobox()?.getAttribute('aria-activedescendant')).toBe(first?.id);

    key('Enter');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(dialog()).toBeNull();
    expect(nodeLabels()).not.toContain('mine-client');
    expect(nodeLabels().length).toBeGreaterThan(10);
    // Focus goes back where it was.
    expect(document.activeElement).toBe(opener);
  });

  it('the arrows move the active row and wrap; Escape closes without running', () => {
    mount();
    key('k', { code: 'KeyK', metaKey: true });
    const rows = () => Array.from(document.querySelectorAll('.cp-row'));
    const active = () => combobox()?.getAttribute('aria-activedescendant');
    expect(active()).toBe(rows()[0]?.id);
    key('ArrowDown');
    expect(active()).toBe(rows()[1]?.id);
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    key('ArrowUp');
    expect(active()).toBe(rows().at(-1)?.id);
    key('Escape');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(dialog()).toBeNull();
    expect(nodeLabels()).toContain('mine-client');
  });

  it('is the first row of the menu, and a recent command comes first next time', () => {
    mount();
    press(document.querySelector('.app-menu-btn')!);
    const first = document.querySelector('.mn-item');
    expect(first?.textContent).toContain('Search actions');
    press(first!);
    expect(dialog()).not.toBeNull();
    type('reset the run');
    key('Enter');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    key('k', { code: 'KeyK', ctrlKey: true });
    expect(document.querySelector('.cp-row')?.textContent).toContain('Reset the run');
  });

  it('a row that cannot run says why and does nothing on Enter', () => {
    mount();
    key('k', { code: 'KeyK', ctrlKey: true });
    type('fit the diagram');
    const row = document.querySelector('.cp-row');
    expect(row?.getAttribute('aria-disabled')).toBeNull();
    type('pin this run');
    // Nothing has been measured with the fake clock still at zero.
    const pin = document.querySelector('.cp-row');
    expect(pin?.getAttribute('aria-disabled')).toBe('true');
    expect(pin?.querySelector('.cp-why')?.textContent).toMatch(/^Nothing measured yet/);
    key('Enter');
    expect(dialog()).not.toBeNull();
  });

  it('crashing a part from it selects that part and records the fault', () => {
    mount();
    key('k', { code: 'KeyK', ctrlKey: true });
    type('crash my serv');
    expect(document.querySelector('.cp-row')?.textContent).toContain(
      'Crash My service',
    );
    key('Enter');
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const svc = document.querySelector('[data-hit="node"][data-id="mine-svc"]');
    expect(svc?.classList.contains('is-faulted')).toBe(true);
    expect(svc?.classList.contains('is-selected')).toBe(true);
  });
});

describe('presenting', () => {
  const app = () => document.querySelector('.app');

  it('P turns it on and off, closing the side panels only while it is on', () => {
    mount();
    expect(app()?.classList.contains('is-presenting')).toBe(false);
    const railWas = document
      .querySelector('.app-body')
      ?.classList.contains('has-library');
    key('p');
    expect(app()?.classList.contains('is-presenting')).toBe(true);
    expect(document.querySelector('.app-body')?.classList.contains('has-library')).toBe(
      false,
    );
    expect(document.querySelector('.pb-hint')?.textContent).toBe(
      'Click a part or Tab to one. X crashes it, W slows it, R fixes it.',
    );
    press(document.querySelector('.pb-exit button:last-child')!);
    expect(app()?.classList.contains('is-presenting')).toBe(false);
    expect(document.querySelector('.app-body')?.classList.contains('has-library')).toBe(
      railWas,
    );
  });

  it('X, W and R break and fix the focused part, and say why when they cannot', () => {
    mount();
    key('p');
    const svc = document.querySelector<SVGGElement>(
      '[data-hit="node"][data-id="mine-svc"]',
    );
    act(() => svc?.focus());
    const state = () => document.querySelector('.pb-state')?.textContent;
    expect(document.querySelector('.pb-label')?.textContent).toBe('My service');
    expect(state()).toBe('Running');

    key('x');
    expect(state()).toBe('Crashed');
    key('x');
    expect(document.querySelector('.app-toast')?.textContent).toBe(
      'My service is already crashed. R fixes it.',
    );
    key('r');
    expect(state()).toBe('Running');
    key('w');
    expect(state()).toBe('Slowed 5×');
    // The inspector stays shut the whole time.
    expect(
      document.querySelector('.app-body')?.classList.contains('has-inspector'),
    ).toBe(false);
  });

  it('X does nothing outside presenting, and the keys wait while a dialog is open', () => {
    mount();
    const svc = document.querySelector<SVGGElement>(
      '[data-hit="node"][data-id="mine-svc"]',
    );
    act(() => svc?.focus());
    key('x');
    expect(svc?.classList.contains('is-faulted')).toBe(false);
    key('p');
    key('k', { code: 'KeyK', ctrlKey: true });
    // Typed into the palette's box, so it is text, not a crash.
    key('x');
    expect(
      document
        .querySelector('[data-hit="node"][data-id="mine-svc"]')
        ?.classList.contains('is-faulted'),
    ).toBe(false);
  });

  it('is in the menu and in the palette', () => {
    mount();
    press(document.querySelector('.app-menu-btn')!);
    const row = Array.from(document.querySelectorAll('.mn-item')).find((b) =>
      b.textContent?.includes('Start presenting'),
    );
    expect(row).toBeDefined();
    press(row!);
    expect(app()?.classList.contains('is-presenting')).toBe(true);
    key('k', { code: 'KeyK', ctrlKey: true });
    type('stop pres');
    key('Enter');
    expect(app()?.classList.contains('is-presenting')).toBe(false);
  });
});
