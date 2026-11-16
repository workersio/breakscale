// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';
import { LONG_PRESS_MS } from './components/pointerInput';

/**
 * The canvas context menu, end to end: right-click and a held finger open
 * it, a moved press or a second finger does not, and its rows go through
 * the same paths as the keys (one undo step each, fresh ids on paste).
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
  const db = { ...makeNode('db', 480, 0), id: 'mine-db', label: 'My db' };
  return {
    nodes: [client, svc, db],
    edges: [
      { id: 'mine-client->mine-svc', from: client.id, to: svc.id, weight: 1 },
      { id: 'mine-svc->mine-db', from: svc.id, to: db.id, weight: 1 },
    ],
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

type At = { x: number; y: number };
const ptr = (
  type: string,
  el: Element,
  at: At,
  extra: { pointerId?: number; pointerType?: string; buttons?: number } = {},
) =>
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: at.x,
        clientY: at.y,
        pointerType: 'mouse',
        ...extra,
      }),
    );
  });

function click(el: Element): void {
  const at = { x: 5, y: 5 };
  ptr('pointerdown', el, at);
  ptr('pointerup', el, at);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function rightClick(el: Element, at: At = { x: 40, y: 40 }): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: at.x,
        clientY: at.y,
      }),
    );
  });
}

const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

/** A finger resting on `el` for the long-press delay, then lifting. */
function hold(el: Element, at: At = { x: 60, y: 60 }, lift = true): void {
  ptr('pointerdown', el, at, { pointerType: 'touch' });
  wait(LONG_PRESS_MS + 10);
  if (lift) ptr('pointerup', el, at, { pointerType: 'touch' });
}

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

const node = (id: string) =>
  document.querySelector<SVGGElement>(`.cv-node[data-id="${id}"]`)!;
const nodes = () => [...document.querySelectorAll<SVGGElement>('.cv-node')];
const edgeHit = (id: string) =>
  document.querySelector(`[data-hit="edge"][data-id="${id}"]`)!;
const surface = () => document.querySelector('.cv-surface')!;
const menu = () => document.querySelector<HTMLElement>('.cm');
const rows = () =>
  [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].map(
    (b) => b.querySelector('.mn-label')?.textContent,
  );
function row(label: string): HTMLButtonElement {
  const el = [
    ...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
  ].find((b) => b.querySelector('.mn-label')?.textContent === label);
  if (!el) throw new Error(`no row ${label}; rows are ${rows().join(', ')}`);
  return el;
}
const toast = () => document.querySelector('.app-toast')?.firstChild?.textContent;
const undo = () => key('z', { ctrlKey: true, code: 'KeyZ' } as KeyboardEventInit);

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

describe('opening the menu', () => {
  it('opens on a right-click, named for the part', () => {
    mount();
    rightClick(node('mine-svc'));
    expect(menu()).not.toBeNull();
    expect(menu()?.getAttribute('data-chrome')).not.toBeNull();
    expect(menu()?.getAttribute('aria-label')).toBe('My service');
    expect(rows()[0]).toBe('Inspect');
    expect(rows().some((r) => r?.startsWith('Crash'))).toBe(true);
    // The right-click selected nothing, so no inspector opened under it.
    expect(node('mine-svc').classList.contains('is-selected')).toBe(false);
  });

  it('opens on a held finger, and the lift does not select', () => {
    mount();
    hold(node('mine-db'));
    expect(menu()?.getAttribute('aria-label')).toBe('My db');
    expect(node('mine-db').classList.contains('is-selected')).toBe(false);
    expect(menu()).not.toBeNull();
  });

  it('does not open for a short tap, which still selects', () => {
    mount();
    const at = { x: 60, y: 60 };
    ptr('pointerdown', node('mine-db'), at, { pointerType: 'touch' });
    wait(200);
    ptr('pointerup', node('mine-db'), at, { pointerType: 'touch' });
    wait(LONG_PRESS_MS);
    expect(menu()).toBeNull();
    expect(node('mine-db').classList.contains('is-selected')).toBe(true);
  });

  it('does not open when the finger moves first: that is a drag', () => {
    mount();
    const before = node('mine-db').getAttribute('transform');
    ptr('pointerdown', node('mine-db'), { x: 60, y: 60 }, { pointerType: 'touch' });
    // A three-event flick: down, one big move, up, well inside the delay.
    ptr('pointermove', node('mine-db'), { x: 160, y: 140 }, { pointerType: 'touch' });
    ptr('pointerup', node('mine-db'), { x: 160, y: 140 }, { pointerType: 'touch' });
    wait(LONG_PRESS_MS + 10);
    expect(menu()).toBeNull();
    expect(node('mine-db').getAttribute('transform')).not.toBe(before);
  });

  it('does not open for two fingers: that is a pan or a pinch', () => {
    mount();
    const s = surface();
    ptr('pointerdown', s, { x: 50, y: 50 }, { pointerType: 'touch', pointerId: 1 });
    wait(100);
    ptr('pointerdown', s, { x: 150, y: 50 }, { pointerType: 'touch', pointerId: 2 });
    wait(LONG_PRESS_MS + 10);
    expect(menu()).toBeNull();
  });

  it('drags on from a hold, closing the menu', () => {
    mount();
    const before = node('mine-db').getAttribute('transform');
    hold(node('mine-db'), { x: 60, y: 60 }, false);
    expect(menu()).not.toBeNull();
    ptr('pointermove', node('mine-db'), { x: 140, y: 120 }, { pointerType: 'touch' });
    expect(menu()).toBeNull();
    ptr('pointerup', node('mine-db'), { x: 140, y: 120 }, { pointerType: 'touch' });
    expect(node('mine-db').getAttribute('transform')).not.toBe(before);
  });

  it('ignores the lift of the finger that opened it, landing on a row', () => {
    mount();
    hold(node('mine-db'));
    // Chrome sends the lift's click to the row now under the finger, with no
    // press on the menu before it.
    act(() => {
      row('Delete').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    });
    expect(menu()).not.toBeNull();
    expect(node('mine-db')).not.toBeNull();
  });

  it('does not open twice when Android also sends its own contextmenu', () => {
    mount();
    hold(node('mine-db'), { x: 60, y: 60 }, false);
    const first = menu();
    rightClick(node('mine-db'), { x: 60, y: 60 });
    expect(menu()).toBe(first);
  });

  it('closes on Escape without clearing the selection, and hands focus back', () => {
    mount();
    click(node('mine-svc'));
    act(() => node('mine-svc').focus());
    // The menu key: no pointer, so it opens under the focused part.
    rightClick(node('mine-svc'), { x: 0, y: 0 });
    expect(menu()?.getAttribute('data-via')).toBe('keyboard');
    expect(document.activeElement?.textContent).toBe('Inspect');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toContain('Duplicate');
    key('End');
    expect(document.activeElement?.textContent).toBe('Delete');
    key('Escape');
    expect(menu()).toBeNull();
    expect(node('mine-svc').classList.contains('is-selected')).toBe(true);
    expect(document.activeElement).toBe(node('mine-svc'));
  });
});

describe('what the rows do', () => {
  it('duplicates as one undo step, with a fresh id and the same settings', () => {
    mount();
    rightClick(node('mine-db'));
    click(row('Duplicate'));
    expect(menu()).toBeNull();
    expect(nodes()).toHaveLength(4);
    const copy = nodes().find((n) => !n.dataset.id?.startsWith('mine-'));
    expect(copy?.dataset.id).toMatch(/^db-\d+$/);
    undo();
    expect(nodes()).toHaveLength(3);
  });

  it('copies on touch and pastes where the canvas was held', () => {
    mount();
    hold(node('mine-svc'));
    click(row('Copy'));
    expect(toast()).toBe('Copied My service. Ctrl+V pastes at the pointer.');
    hold(surface(), { x: 300, y: 300 });
    expect(menu()?.getAttribute('aria-label')).toBe('Canvas');
    expect(rows()).toContain('Paste here');
    click(row('Paste here'));
    // The paste reads the in-app copy, so no promise is left to settle.
    expect(nodes()).toHaveLength(4);
    const ids = nodes().map((n) => n.dataset.id);
    expect(new Set(ids).size).toBe(4);
    undo();
    expect(nodes()).toHaveLength(3);
  });

  it('copies a part with its connection to another copied part', () => {
    mount();
    // Shift-click builds a two-part selection.
    click(node('mine-svc'));
    act(() => {
      const at = { bubbles: true, cancelable: true, clientX: 5, clientY: 5 };
      node('mine-db').dispatchEvent(
        new FakePointerEvent('pointerdown', { ...at, buttons: 1, shiftKey: true }),
      );
      node('mine-db').dispatchEvent(
        new FakePointerEvent('pointerup', { ...at, buttons: 0, shiftKey: true }),
      );
    });
    rightClick(node('mine-db'));
    expect(menu()?.getAttribute('aria-label')).toBe('2 components');
    click(row('Copy all 2'));
    rightClick(surface(), { x: 400, y: 400 });
    click(row('Paste here'));
    expect(nodes()).toHaveLength(5);
    // Two old connections plus the copied one between the copies.
    expect(document.querySelectorAll('[data-hit="edge"]')).toHaveLength(3);
  });

  it('crashes and fixes through the menu', () => {
    mount();
    rightClick(node('mine-db'));
    click(row('Crash'));
    rightClick(node('mine-db'));
    expect(rows()).toContain('Fix');
    expect(rows()).not.toContain('Crash');
    click(row('Fix'));
    rightClick(node('mine-db'));
    expect(rows()).toContain('Crash');
  });

  it('cuts and restores a connection, and deletes it', () => {
    mount();
    rightClick(edgeHit('mine-svc->mine-db'));
    expect(menu()?.getAttribute('aria-label')).toBe('My service to My db');
    click(row('Cut connection'));
    rightClick(edgeHit('mine-svc->mine-db'));
    click(row('Restore connection'));
    rightClick(edgeHit('mine-svc->mine-db'));
    expect(rows()).toContain('Add 10% packet loss');
    click(row('Delete connection'));
    expect(document.querySelector('[data-id="mine-svc->mine-db"]')).toBeNull();
    undo();
    expect(edgeHit('mine-svc->mine-db')).not.toBeNull();
  });

  it('arms a link from Connect to, finished by a tap on the target', () => {
    mount();
    hold(node('mine-client'));
    click(row('Connect to…'));
    expect(document.querySelector('.cv-hint')?.textContent).toBe(
      'Click a component to connect · Esc to cancel',
    );
    click(node('mine-db'));
    expect(edgeHit('mine-client->mine-db')).not.toBeNull();
  });

  it('deletes with an undo in the toast', () => {
    mount();
    rightClick(node('mine-db'));
    click(row('Delete'));
    expect(document.querySelector('.cv-node[data-id="mine-db"]')).toBeNull();
    expect(toast()).toBe('Deleted My db');
  });
});

describe('duplicate and copy in the inspector', () => {
  it('sit beside Delete and act on the selection', () => {
    mount();
    click(node('mine-db'));
    const foot = document.querySelector('.ins-foot')!;
    const labels = [...foot.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Duplicate', 'Copy', 'Delete component']);
    click(foot.querySelectorAll('button')[0]!);
    expect(nodes()).toHaveLength(4);
    click(document.querySelector('.ins-foot')!.querySelectorAll('button')[1]!);
    expect(toast()).toMatch(/^Copied /);
  });
});
