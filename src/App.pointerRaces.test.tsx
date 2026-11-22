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

/** Ctrl+Z as the shell reads it: by key position, not by letter. */
const undo = () => key('z', { code: 'KeyZ', ctrlKey: true });

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

describe('Delete while a node is held (#132)', () => {
  it('leaves nothing selected on release, and never reports a phantom connection', () => {
    mount();
    // Select n1 with a click, then press it again and hold.
    ptr('pointerdown', node('n1'), { x: 500, y: 340 });
    ptr('pointerup', node('n1'), { x: 500, y: 340 });
    expect(node('n1').classList.contains('is-selected')).toBe(true);

    ptr('pointerdown', node('n1'), { x: 500, y: 340 });
    key('Delete');
    expect(nodeIds()).toEqual(['n0']);
    ptr('pointerup', surface(), { x: 500, y: 340 });

    expect(document.querySelectorAll('.cv-node.is-selected').length).toBe(0);
    expect(/connections? selected/.test(document.body.textContent ?? '')).toBe(false);
  });

  it('a part undone away mid-press is not selected when the press lifts', () => {
    mount();
    ptr('pointerdown', node('n1'), { x: 500, y: 340 });
    ptr('pointerup', node('n1'), { x: 500, y: 340 });
    key('d', { code: 'KeyD', ctrlKey: true });
    const copy = nodeIds().find((id) => id !== 'n0' && id !== 'n1')!;
    expect(copy).toBeTruthy();

    ptr('pointerdown', node(copy), { x: 520, y: 360 });
    undo();
    expect(nodeIds()).toEqual(['n0', 'n1']);
    ptr('pointerup', surface(), { x: 520, y: 360 });
    expect(/connections? selected/.test(document.body.textContent ?? '')).toBe(false);
  });

  it('a drag in progress is kept as its own undo step before the delete', () => {
    mount();
    const start = pos('n1');
    ptr('pointerdown', node('n1'), { x: 500, y: 340 });
    ptr('pointermove', node('n1'), { x: 580, y: 340 });
    key('Delete');
    ptr('pointerup', surface(), { x: 580, y: 340 });
    expect(nodeIds()).toEqual(['n0']);

    undo();
    expect(nodeIds()).toEqual(['n0', 'n1']);
    expect(pos('n1')).toEqual({ x: start.x + 80, y: start.y });
    undo();
    expect(pos('n1')).toEqual(start);
  });
});
