// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';
import { ONE_RAIL_QUERY } from './oneRail';

/**
 * The keyboard and overlay pass: the skip link, the tab order, the rail as
 * one tab stop, F6, keyboard connect, the delete toast and its Undo, and one
 * rail at a time on a tablet held upright.
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
  const cache = { ...makeNode('cache', 480, 200), id: 'mine-cache', label: 'My cache' };
  return {
    nodes: [client, svc, db, cache],
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

/** A key press on whatever has focus, the way the browser sends it. */
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
const edge = (id: string) =>
  document.querySelector(`[data-hit="edge"][data-id="${id}"]`);
const body = () => document.querySelector('.app-body')!.classList;

/** Everything Tab stops on, in page order. */
function tabStops(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]',
    ),
  ].filter((el) => el.tabIndex >= 0 && !el.closest('[aria-hidden="true"]'));
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

describe('getting to the diagram from the keyboard', () => {
  it('starts with a skip link that puts focus on the diagram', () => {
    mount();
    const stops = tabStops();
    expect(stops[0]?.textContent).toBe('Skip to diagram');
    press(stops[0]!);
    expect(document.activeElement?.classList.contains('cv-node')).toBe(true);
  });

  it('reaches the diagram before the rails, and the rail is one stop', () => {
    mount();
    const stops = tabStops();
    const firstNode = stops.findIndex((el) => el.classList.contains('cv-node'));
    const firstRow = stops.findIndex((el) => el.classList.contains('pal-row'));
    expect(firstNode).toBeGreaterThan(0);
    expect(firstRow).toBeGreaterThan(firstNode);
    expect(stops.filter((el) => el.closest('.pal-rows'))).toHaveLength(1);
  });

  it('moves through the rail with the arrows and explains a row on ?', () => {
    mount();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.pal-row')];
    act(() => rows[0]!.focus());
    key('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1]!.tabIndex).toBe(0);
    expect(rows[0]!.tabIndex).toBe(-1);
    key('End');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    key('Home');
    expect(document.activeElement).toBe(rows[0]);
    key('?');
    expect(document.activeElement?.classList.contains('pal-explain')).toBe(true);
    // The row's own explanation, not the glossary panel.
    expect(document.querySelector('[role="dialog"][aria-label="Glossary"]')).toBeNull();
    // The first Escape shuts the explanation, the second goes back to the row.
    key('Escape');
    key('Escape');
    expect(document.activeElement).toBe(rows[0]);
    key('?');
    key('ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
  });

  it('steps between regions with F6 and back with Shift+F6', () => {
    mount();
    key('F6');
    expect(document.activeElement?.closest('.app-bar')).not.toBeNull();
    key('F6');
    expect(document.activeElement?.classList.contains('cv-node')).toBe(true);
    key('F6');
    expect(document.activeElement?.closest('.app-slot-left')).not.toBeNull();
    key('F6', { shiftKey: true });
    expect(document.activeElement?.classList.contains('cv-node')).toBe(true);
  });
});

describe('connecting from the keyboard', () => {
  it('makes one edge to the picked part, as one undo step', () => {
    mount();
    press(node('mine-svc'));
    key('l');
    const hint = () => document.querySelector('.cv-hint')?.textContent;
    // Downstream first: the nearest part to the right.
    expect(hint()).toBe(
      'Connect My service to My db. Arrows pick, Enter connects, Esc cancels.',
    );
    expect(document.activeElement).toBe(node('mine-db'));
    key('ArrowDown');
    expect(hint()).toContain('to My cache');
    // An arrow picks; it does not move the focused part.
    const t = node('mine-cache').getAttribute('transform');
    key('ArrowUp');
    expect(node('mine-cache').getAttribute('transform')).toBe(t);
    expect(hint()).toContain('to My db');
    key('Enter');
    expect(edge('mine-svc->mine-db')).not.toBeNull();
    expect(document.querySelectorAll('[data-hit="edge"]')).toHaveLength(2);
    expect(document.querySelector('.cv-hint')).toBeNull();
    expect(document.activeElement).toBe(node('mine-svc'));
    key('z', { ctrlKey: true, code: 'KeyZ' } as KeyboardEventInit);
    expect(edge('mine-svc->mine-db')).toBeNull();
    expect(edge('mine-client->mine-svc')).not.toBeNull();
  });

  it('offers only parts it can link to, and Escape keeps the selection', () => {
    mount();
    press(node('mine-client'));
    key('L');
    // Already linked to My service, so the first offer skips it.
    expect(document.querySelector('.cv-hint')?.textContent).not.toContain(
      'to My service',
    );
    key('Escape');
    expect(document.querySelector('.cv-hint')).toBeNull();
    expect(node('mine-client').classList.contains('is-selected')).toBe(true);
    expect(document.querySelectorAll('[data-hit="edge"]')).toHaveLength(1);
  });

  it('needs exactly one part selected', () => {
    mount();
    key('l');
    expect(document.querySelector('.cv-hint')).toBeNull();
  });
});

describe('deleting a part', () => {
  it('sits at the end of the inspector and offers an undo', () => {
    mount();
    press(node('mine-db'));
    const scroll = document.querySelector('.ins-scroll')!;
    const del = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Delete component',
    )!;
    // Inside the scrolling content, after everything else in it.
    expect(scroll.contains(del)).toBe(true);
    expect(scroll.lastElementChild?.contains(del)).toBe(true);
    press(del);
    expect(document.querySelector('.cv-node[data-id="mine-db"]')).toBeNull();
    const toast = document.querySelector('.app-toast')!;
    expect(toast.closest('.app-body')).not.toBeNull();
    expect(toast.firstChild?.textContent).toBe('Deleted My db');
    press(toast.querySelector('button')!);
    expect(document.querySelector('.cv-node[data-id="mine-db"]')).not.toBeNull();
  });

  it('Undo in the toast does nothing once something else was done', () => {
    mount();
    press(node('mine-db'));
    key('Delete');
    const undo = document.querySelector<HTMLButtonElement>('.app-toast button')!;
    expect(undo.textContent).toBe('Undo');
    press(node('mine-cache'));
    key('Delete');
    // The second toast replaced the first; its Undo takes back the cache.
    press(document.querySelector('.app-toast button')!);
    expect(document.querySelector('.cv-node[data-id="mine-cache"]')).not.toBeNull();
    expect(document.querySelector('.cv-node[data-id="mine-db"]')).toBeNull();
  });
});

describe('one rail at a time on a tablet held upright', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === ONE_RAIL_QUERY,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
        }) as unknown as MediaQueryList,
    );
  });

  it('starts with the components rail closed, and opening one closes the other', () => {
    mount();
    expect(body().contains('has-library')).toBe(false);
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('.stage-toggle-library')!;
    press(toggle());
    expect(body().contains('has-library')).toBe(true);
    press(node('mine-svc'));
    expect(body().contains('has-inspector')).toBe(true);
    expect(body().contains('has-library')).toBe(false);
    press(toggle());
    expect(body().contains('has-library')).toBe(true);
    expect(body().contains('has-inspector')).toBe(false);
  });

  it('keeps the rail open for a part added from it', () => {
    mount();
    press(document.querySelector('.stage-toggle-library')!);
    const row = document.querySelector<HTMLButtonElement>(
      '.pal-row[data-row="cache"]',
    )!;
    press(row);
    expect(document.querySelectorAll('.cv-node')).toHaveLength(5);
    expect(body().contains('has-library')).toBe(true);
    expect(body().contains('has-inspector')).toBe(false);
  });

  it('does not save the folded rail as the reader choice', () => {
    mount();
    expect(body().contains('has-library')).toBe(false);
    const saved = JSON.parse(localStorage.getItem('breakscale.layout.v1') ?? '{}') as {
      library?: boolean;
    };
    expect(saved.library).not.toBe(false);
  });
});
