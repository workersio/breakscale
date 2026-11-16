// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas, { NODE_H, NODE_W } from './Canvas';
import type { CanvasProps } from './Canvas';
import { REVEAL_PAD } from './reveal';
import { DETAIL_ZOOM } from './fit';
import { PRESETS } from '../sim/presets';

/**
 * The camera when a panel opens over the part being worked on, and the tap
 * that reopens a sheet. jsdom has no layout, so the surface and the
 * uncovered-canvas sentinel get rects by hand; `room` is changed between
 * renders the way opening the inspector changes the real sentinel.
 */

const SURFACE = { left: 0, top: 0, width: 1280, height: 700 };
let room = { ...SURFACE };
/** A floating card over the canvas, and where it sits. */
let card: {
  el: Element;
  at: { left: number; top: number; width: number; height: number };
} | null = null;

function rect(r: { left: number; top: number; width: number; height: number }) {
  return {
    ...r,
    x: r.left,
    y: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    toJSON: () => ({}),
  } as DOMRect;
}

function translateOf(el: Element | null): [number, number, number] {
  const m = /translate\(([-\d.e]+),([-\d.e]+)\)(?: scale\(([-\d.e]+)\))?/.exec(
    el?.getAttribute('transform') ?? '',
  );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
}

let container: HTMLDivElement;
let root: Root;
let safe: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  room = { ...SURFACE };
  card = null;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains('cv-surface')) return rect(SURFACE);
    if (this.classList.contains('stage-safe')) return rect(room);
    if (card && this === card.el) return rect(card.at);
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  });
  safe = document.createElement('div');
  safe.className = 'stage-safe';
  document.body.appendChild(safe);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const preset = PRESETS.find((p) => p.id === 'single-server');
if (!preset) throw new Error('no single-server preset');
const topology = preset.topology;
const db = topology.nodes.find((n) => n.kind === 'db');
if (!db) throw new Error('no database');

function view(): { x: number; y: number; k: number } {
  const [x, y, k] = translateOf(container.querySelector('.cv-svg > g'));
  return { x, y, k };
}

const visibleRef = createRef<HTMLElement | null>() as { current: HTMLElement | null };

function render(props: Partial<CanvasProps> = {}) {
  visibleRef.current = safe;
  act(() =>
    root.render(
      <Canvas
        topology={topology}
        snapshot={null}
        selectedIds={new Set()}
        onSelectionChange={() => {}}
        onMoveNode={() => {}}
        onConnect={() => {}}
        onDeleteSelection={() => {}}
        onDropNode={() => {}}
        visibleRef={visibleRef}
        {...props}
      />,
    ),
  );
}

describe('revealing the part a panel opens on', () => {
  it('keeps a diagram that was all on screen all on screen beside the panel', () => {
    render();
    const before = view();
    // The inspector opens over the right of the canvas, on top of the
    // database's box. The whole diagram was on screen, so all of it stays.
    const dbRight = db.x * before.k + before.x + NODE_W * before.k;
    room = { ...SURFACE, width: dbRight - 40 };
    render({ reveal: { ids: [db.id], key: `inspect:${db.id}` } });
    expect(view()).toEqual(before);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const after = view();
    expect(after.k).toBeLessThan(before.k);
    expect(after.k).toBeGreaterThanOrEqual(DETAIL_ZOOM);
    for (const n of topology.nodes) {
      expect(n.x * after.k + after.x, n.id).toBeGreaterThanOrEqual(0);
      expect((n.x + NODE_W) * after.k + after.x, n.id).toBeLessThanOrEqual(room.width);
    }
  });

  it('pans the least distance that brings it out from under the panel', () => {
    render();
    const before = view();
    // Too narrow a room for the whole diagram at a zoom that keeps its
    // numbers: only the part asked about is moved, by the least distance.
    room = { ...SURFACE, width: 520 };
    render({ reveal: { ids: [db.id], key: `inspect:${db.id}` } });
    // Nothing moves until the panel has finished sliding in.
    expect(view()).toEqual(before);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const after = view();
    expect(after.k).toBe(before.k);
    expect(after.y).toBe(before.y);
    expect(db.x * after.k + after.x + NODE_W * after.k).toBeCloseTo(
      room.width - REVEAL_PAD,
      5,
    );
  });

  it('does not move a part that is already in view', () => {
    render();
    const before = view();
    render({ reveal: { ids: [db.id], key: `inspect:${db.id}` } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(view()).toEqual(before);
  });

  it('pans once per key, leaving a later pan to the reader', () => {
    render();
    const before = view();
    room = { ...SURFACE, width: 600 };
    const reveal = { ids: [db.id], key: `inspect:${db.id}` };
    render({ reveal });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const once = view();
    expect(once.x).not.toBe(before.x);
    room = { ...SURFACE, width: 400 };
    render({ reveal: { ...reveal } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(view()).toEqual(once);
  });

  it('keeps it clear of a floating card too', () => {
    render();
    const v = view();
    const top = db.y * v.k + v.y;
    const el = document.createElement('div');
    el.setAttribute('data-spot-avoid', '');
    document.body.appendChild(el);
    const cardRect = { left: 0, top: top - 10, width: SURFACE.width, height: 30 };
    card = { el, at: cardRect };
    render({ reveal: { ids: [db.id], key: `inspect:${db.id}` } });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const after = view();
    const boxTop = db.y * after.k + after.y;
    const boxBottom = boxTop + NODE_H * after.k;
    const clear = boxBottom <= cardRect.top || boxTop >= cardRect.top + cardRect.height;
    expect(clear).toBe(true);
  });
});

describe('tapping the part that is already selected', () => {
  function tap(el: Element) {
    for (const type of ['pointerdown', 'pointerup'] as const) {
      act(() => {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === 'pointerdown' ? 1 : 0,
            pointerId: 1,
            pointerType: 'touch',
            isPrimary: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      });
    }
  }

  it('tells the shell, so it can bring the inspector back', () => {
    const onReselect = vi.fn();
    const onSelectionChange = vi.fn();
    render({ selectedIds: new Set([db.id]), onReselect, onSelectionChange });
    const node = container.querySelector(`.cv-node[data-id="${db.id}"]`);
    if (!node) throw new Error('no database node');
    tap(node);
    expect(onReselect).toHaveBeenCalledTimes(1);
    // The selection itself did not change, so nothing else is told.
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('says nothing for a tap on a part that was not selected', () => {
    const onReselect = vi.fn();
    const onSelectionChange = vi.fn();
    render({ selectedIds: new Set(), onReselect, onSelectionChange });
    const node = container.querySelector(`.cv-node[data-id="${db.id}"]`);
    if (!node) throw new Error('no database node');
    tap(node);
    expect(onReselect).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
  });
});
