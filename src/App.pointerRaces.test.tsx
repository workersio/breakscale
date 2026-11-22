// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { makeNode } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * Pointer races on the canvas, end to end through the shell: what a press
 * does when something else happens before it lifts. An Alt flick, Delete
 * pressed mid-hold, a pen lifted where the surface cannot see it, and a
 * second pointer landing during a drag. Each one used to leave the canvas
 * or the undo history in a state no single pointer could produce.
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

function design(): Topology {
  const a = { ...makeNode('service', 0, 0), id: 'n0', label: 'First' };
  const b = { ...makeNode('service', 480, 320), id: 'n1', label: 'Second' };
  return { nodes: [a, b], edges: [] };
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
interface Extra {
  pointerId?: number;
  pointerType?: string;
  buttons?: number;
  altKey?: boolean;
}

function ptr(type: string, el: EventTarget, at: At, extra: Extra = {}): void {
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
}

function key(k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
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
const surface = () => document.querySelector<HTMLElement>('.cv-surface')!;
const nodeIds = () =>
  [...document.querySelectorAll('.cv-node')].map((n) => n.getAttribute('data-id'));

/** A node's world position, read back from what the canvas painted. */
function pos(id: string): At {
  const t = node(id).getAttribute('transform') ?? '';
  const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(t);
  if (!m) throw new Error(`no transform on ${id}: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** The canvas's zoom, so screen deltas can be turned into world deltas. */
function zoom(): number {
  const t = document.querySelector('.cv-world')?.getAttribute('transform') ?? '';
  const m = /scale\(([-\d.]+)\)/.exec(t);
  return m ? Number(m[1]) : 1;
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
    JSON.stringify({ topology: design(), rps: 50, presetId: null }),
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

describe('alt+drag copy (#131)', () => {
  it('a three-event flick drops the copy where the pointer let go, not on the original', () => {
    mount();
    expect(zoom()).toBe(1);
    const start = pos('n0');
    ptr('pointerdown', node('n0'), { x: 40, y: 40 }, { altKey: true });
    ptr('pointermove', node('n0'), { x: 40, y: 50 }, { altKey: true });
    ptr('pointerup', node('n0'), { x: 40, y: 50 }, { altKey: true });

    const copy = nodeIds().find((id) => id !== 'n0' && id !== 'n1');
    expect(copy).toBeTruthy();
    expect(pos('n0')).toEqual(start);
    // 10px snapped to the 8px grid.
    expect(pos(copy!)).toEqual({ x: start.x, y: start.y + 8 });
  });

  it('a paced alt+drag lands where a plain drag of the same moves would', () => {
    mount();
    const start = pos('n0');
    ptr('pointerdown', node('n0'), { x: 40, y: 40 }, { altKey: true });
    ptr('pointermove', node('n0'), { x: 40, y: 50 }, { altKey: true });
    ptr('pointermove', node('n0'), { x: 40, y: 150 }, { altKey: true });
    ptr('pointerup', node('n0'), { x: 40, y: 150 }, { altKey: true });
    const copy = nodeIds().find((id) => id !== 'n0' && id !== 'n1')!;
    expect(pos(copy)).toEqual({ x: start.x, y: start.y + 112 });
    expect(pos('n0')).toEqual(start);
  });
});
