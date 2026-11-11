// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { encodeTopology } from './share';
import { PRESETS, makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * The fault controls through the whole app: a press is an undo entry, the
 * Undo button and Ctrl+Z take it back, and the toast names it.
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

function must(name: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const status = () => document.querySelector('.ins-fault-status')?.textContent ?? '';
const toast = () => document.querySelector('.app-toast')?.textContent ?? '';

function selectService(): void {
  press(document.querySelector('[data-hit="node"][data-id="mine-svc"]')!);
}

/** A shortcut, bound by physical key the way the app reads it. */
function key(code: string, opts: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code, bubbles: true, ...opts }),
    );
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

describe('a fault control', () => {
  it('is undone by the Undo button and redone by Redo', () => {
    mount();
    selectService();
    expect(must('Undo').disabled).toBe(true);
    press(must('Crash'));
    expect(status()).toMatch(/^Crashed at/);
    expect(must('Undo').disabled).toBe(false);

    press(must('Undo'));
    expect(status()).toBe('Working normally.');
    expect(toast()).toBe('Undid crash');

    press(must('Redo'));
    expect(status()).toMatch(/^Crashed at/);
    expect(toast()).toBe('Redid crash');
  });

  it('is undone by Ctrl+Z', () => {
    mount();
    selectService();
    press(must('Crash'));
    key('KeyZ', { ctrlKey: true });
    expect(status()).toBe('Working normally.');
    expect(toast()).toBe('Undid crash');
  });

  it('leaves a crash in place when the edit after it is undone', () => {
    mount();
    selectService();
    press(must('Crash'));
    // A discrete design edit after the crash.
    key('KeyD', { ctrlKey: true });
    expect(document.querySelectorAll('[data-hit="node"]').length).toBe(3);
    press(must('Undo'));
    expect(document.querySelectorAll('[data-hit="node"]').length).toBe(2);
    selectService();
    expect(status()).toMatch(/^Crashed at/);
  });
});

describe('Forget saved faults', () => {
  const saved = () =>
    document.querySelector('.ins-fault-recorded .ins-hint')?.textContent;

  it('is undone by Ctrl+Z without touching the node, and redone by Ctrl+Shift+Z', () => {
    mount();
    selectService();
    press(must('Crash'));
    press(must('Fix'));
    expect(saved()).toMatch(/^2 faults are saved/);

    press(must('Forget saved faults'));
    expect(saved()).toBeUndefined();

    key('KeyZ', { ctrlKey: true });
    expect(toast()).toBe('Undid forget saved faults');
    expect(saved()).toMatch(/^2 faults are saved/);
    expect(status()).toBe('Working normally.');

    key('KeyZ', { ctrlKey: true, shiftKey: true });
    expect(toast()).toBe('Redid forget saved faults');
    expect(saved()).toBeUndefined();
    expect(status()).toBe('Working normally.');
  });
});

describe('a fault on a design opened from a share link', () => {
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });

  it('is not an edit, so undoing it does not save the link over the reader design', async () => {
    const shared = PRESETS.find((p) => p.id === 'cache-aside')!.topology;
    window.history.replaceState(null, '', `/#${await encodeTopology(shared)}`);
    vi.useRealTimers();
    mount();
    const nodes = () => document.querySelectorAll('[data-hit="node"]').length;
    for (let i = 0; i < 50 && nodes() !== shared.nodes.length; i++) await wait(10);
    expect(nodes()).toBe(shared.nodes.length);

    press(document.querySelector('[data-hit="node"][data-kind="db"]')!);
    press(must('Crash'));
    press(must('Undo'));
    press(must('Redo'));
    await wait(1200);
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as {
      topology: Topology;
    };
    expect(stored.topology).toEqual(ownDesign());
  });
});
