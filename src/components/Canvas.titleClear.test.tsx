// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas, { NODE_H, NODE_W } from './Canvas';
import { PRESETS } from '../sim/presets';

/**
 * The answer card on a phone, when neither pan clears the titles under it.
 * jsdom has no layout, so the surface and the card get rects by hand: a 390
 * by 420 strip with a card across its full width. Each title's rect follows
 * its box under the world transform, so the titles move with the camera.
 */

const SURFACE = { left: 0, top: 0, width: 390, height: 420 };
const CARD = { left: 0, top: 48, width: 390, height: 182 };

function translateOf(el: Element | null): [number, number, number] {
  const m = /translate\(([-\d.e]+),([-\d.e]+)\)(?: scale\(([-\d.e]+)\))?/.exec(
    el?.getAttribute('transform') ?? '',
  );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 1)] : [0, 0, 1];
}

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains('cv-surface')) return rect(SURFACE);
    if (this.hasAttribute('data-titles-clear')) return rect(CARD);
    if (this.classList.contains('cv-node-name')) {
      const [vx, vy, k] = translateOf(this.ownerDocument.querySelector('.cv-svg > g'));
      const [nx, ny] = translateOf(this.closest('.cv-node'));
      return rect({
        left: vx + (nx + 12) * k,
        top: vy + (ny + 10) * k,
        width: 120 * k,
        height: 18 * k,
      });
    }
    return rect({ left: 0, top: 0, width: 0, height: 0 });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function view(): { x: number; y: number; k: number } {
  const [x, y, k] = translateOf(container.querySelector('.cv-svg > g'));
  return { x, y, k };
}

describe('the answer card on a phone', () => {
  it('keeps the named box on screen rather than refitting it away', () => {
    const preset = PRESETS.find((p) => p.id === 'full-stack');
    if (!preset) throw new Error('no full-stack preset');
    const topology = preset.topology;
    const named = topology.nodes.find((n) => n.id === 'workers');
    if (!named) throw new Error('no workers node');
    const card = document.createElement('div');
    card.setAttribute('data-titles-clear', '');
    document.body.appendChild(card);
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
          spotlightId="workers"
          spotlightKey={1}
        />,
      ),
    );
    const v = view();
    const left = named.x * v.k + v.x;
    const top = named.y * v.k + v.y;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + NODE_W * v.k).toBeLessThanOrEqual(SURFACE.width);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + NODE_H * v.k).toBeLessThanOrEqual(SURFACE.height);
  });
});
