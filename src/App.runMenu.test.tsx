// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * Pause, Step and Reset from the menu. A touch screen has no Space or S key,
 * and on a narrow bar the menu is the place every layout can always reach.
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

function openMenu(): HTMLButtonElement[] {
  press(document.querySelector('[aria-label="Menu"]')!);
  return [...document.querySelectorAll<HTMLButtonElement>('.mn-item')];
}

function item(label: string): HTMLButtonElement {
  const el = openMenu().find(
    (b) => b.querySelector('.mn-label')?.textContent === label,
  );
  if (!el) throw new Error(`no menu item ${label}`);
  return el;
}

const toggle = () =>
  document.querySelector('.transport-toggle')!.getAttribute('aria-label');
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

describe('the run controls in the menu', () => {
  it('come first after Search actions, with their keys, and a rule after them', () => {
    mount();
    const rows = openMenu().map((b) => b.textContent);
    expect(rows.slice(0, 4)).toEqual([
      'Search actionsCtrl+K',
      'PauseSpace',
      'StepS',
      'Reset',
    ]);
    const seps = Array.from(document.querySelectorAll('.mn [role="separator"]'));
    expect(seps.map((s) => s.previousElementSibling?.textContent).slice(0, 2)).toEqual([
      'Search actionsCtrl+K',
      'Reset',
    ]);
  });

  it('pause and play the run', () => {
    mount();
    expect(toggle()).toBe('Pause');
    press(item('Pause'));
    expect(toggle()).toBe('Play');
    press(item('Play'));
    expect(toggle()).toBe('Pause');
  });

  it('step one tick from a stopped clock, and reset it to zero', () => {
    mount();
    press(item('Pause'));
    expect(clock()).toBe('0.0s');
    press(item('Step'));
    expect(clock()).toBe('0.1s');
    expect(toggle()).toBe('Play');
    press(item('Step'));
    expect(clock()).toBe('0.2s');
    press(item('Reset'));
    expect(clock()).toBe('0.0s');
  });
});
