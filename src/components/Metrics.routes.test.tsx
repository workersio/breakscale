// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Metrics } from './Metrics';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';

/*
 * The strip's per-route chart: one line per client, the hurting one in the
 * danger colour, a gap where a route had no reading, and nothing at all
 * for a design with a single client.
 */

const FRAME = 1000 / 60;

function preset(id: string): Topology {
  const t = PRESETS.find((p) => p.id === id)?.topology;
  if (!t) throw new Error(`no preset ${id}`);
  return t;
}

let container: HTMLDivElement;
let root: Root;

/** jsdom has no layout, so the charts measure nothing and keep their fallback width. */
class NoResize {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoResize;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function show(topology: Topology, slow?: string) {
  const engine = new Engine(topology, 1);
  for (let t = 0; t < 4000; t += FRAME) engine.advance(FRAME);
  if (slow) engine.injectFailure(slow, 'slow', { factor: 40 });
  for (let t = 0; t < 8000; t += FRAME) engine.advance(FRAME);
  const names = Object.fromEntries(topology.nodes.map((n) => [n.id, n.label]));
  act(() =>
    root.render(
      <Metrics
        snapshot={engine.snapshot()}
        nodeNames={names}
        routes={engine.routes()}
      />,
    ),
  );
}

function chart(): Element | null {
  return container.querySelector(
    '[aria-label="Each traffic source over the last 60 seconds"]',
  );
}

describe('the per-route chart', () => {
  it('draws one series per client, the hurting one in the danger colour', () => {
    show(preset('stripe'), 'reportsvc');
    const c = chart();
    if (!c) throw new Error('no route chart');
    const paths = [...c.querySelectorAll('path.mx-line')];
    expect(paths.map((p) => p.getAttribute('class'))).toEqual([
      'mx-line mx-route-0',
      'mx-line mx-route-1 is-danger',
    ]);
    expect(paths.every((p) => (p.getAttribute('d') ?? '').startsWith('M'))).toBe(true);
    const legend = [...c.querySelectorAll('.mx-key-route')].map((li) => li.textContent);
    expect(legend[0]).toMatch(/^Merchant API Calls\d/);
    expect(legend[1]).toBe('Dashboard Readers100%');
  });

  it('switches to p99, with a gap where a route has nothing succeeding', () => {
    show(preset('stripe'), 'reportsvc');
    const c = chart();
    if (!c) throw new Error('no route chart');
    const p99 = [...c.querySelectorAll('button')].find((b) => b.textContent === 'p99');
    if (!p99) throw new Error('no p99 button');
    act(() => p99.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(p99.getAttribute('aria-pressed')).toBe('true');
    const legend = [...c.querySelectorAll('.mx-key-route')].map((li) => li.textContent);
    expect(legend[1]).toBe('Dashboard Readersnone');
    // Dashboards had a p99 before the fault and none after: the line stops
    // where the readings stop rather than dropping to zero.
    const d = c.querySelectorAll('path.mx-line')[1]?.getAttribute('d') ?? '';
    const ys = [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every((y) => y < 100)).toBe(true);
  });

  it('is not there with a single client', () => {
    show(preset('single-server'));
    expect(chart()).toBeNull();
  });
});
