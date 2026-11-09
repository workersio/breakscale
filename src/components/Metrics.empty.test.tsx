// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Metrics } from './Metrics';
import type { ChartsIdle } from './Metrics';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';

/**
 * The charts before anything has been measured. A snapshot straight out of
 * a fresh engine has p99 0 and goodput 0 because nothing has run, not
 * because the system is fast and idle, so none of those zeros may reach
 * the screen as a reading.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  // jsdom has no layout; the charts measure their width with this.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const simple = PRESETS.find((p) => p.id === 'single-server')!.topology;

function render(engine: Engine, idle?: ChartsIdle): void {
  act(() => root.render(<Metrics snapshot={engine.snapshot()} idle={idle} />));
}

const headline = (label: string) =>
  container.querySelector(`section[aria-label^="${label}"] .mx-readout`);

describe('charts before the first run', () => {
  it('state n/a, never a zero, for what has not been measured', () => {
    const engine = new Engine(simple);
    expect(engine.snapshot().history.length).toBe(0);
    render(engine, 'not-started');

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\b0ms\b/);
    expect(headline('Latency')?.textContent).toBe('n/a');
    expect(headline('Latency')?.classList.contains('is-unmeasured')).toBe(true);
    expect(headline('Throughput')?.textContent).toBe('n/a');
    expect(headline('Failures')?.textContent).toBe('n/a');
    for (const v of container.querySelectorAll('.mx-legend .mx-key-value')) {
      expect(v.textContent).toBe('n/a');
    }
  });

  it('says why the plots are empty', () => {
    const engine = new Engine(simple);
    render(engine, 'not-started');
    expect(container.querySelector('.mx-empty')?.textContent).toBe(
      'Press play to start the clock.',
    );
    expect(container.querySelector('.tr-empty')?.textContent).toBe(
      'Press play to start the clock.',
    );

    // A running clock with nothing on the canvas still records samples,
    // every one of them zero. None of them may be drawn as a reading.
    const bare = new Engine({ nodes: [], edges: [] });
    for (let i = 0; i < 30; i++) bare.advance(100);
    expect(bare.snapshot().history.length).toBeGreaterThan(0);
    render(bare, 'no-client');
    for (const r of container.querySelectorAll('.mx-readout')) {
      expect(r.textContent).toBe('n/a');
    }
    expect(container.querySelector('.mx-empty')?.textContent).toBe(
      'Add a client to send traffic.',
    );
    expect(container.querySelector('.mx-clean')?.textContent).toBe(
      'Add a client to send traffic.',
    );
    expect(container.querySelector('.tr-empty')?.textContent).toBe(
      'Add a client to send traffic.',
    );
  });

  it('keeps the plain waiting line while the clock runs', () => {
    render(new Engine(simple));
    expect(container.querySelector('.mx-empty')?.textContent).toBe(
      'Waiting for traffic',
    );
  });

  it('shows the measured numbers once traffic has run', () => {
    const engine = new Engine(simple);
    for (let i = 0; i < 30; i++) engine.advance(100);
    const snap = engine.snapshot();
    expect(snap.history.length).toBeGreaterThan(0);
    expect(snap.system.goodputRps).toBeGreaterThan(0);
    render(engine);

    expect(headline('Latency')?.textContent).not.toBe('n/a');
    expect(headline('Latency')?.classList.contains('is-unmeasured')).toBe(false);
    expect(headline('Throughput')?.textContent).not.toBe('n/a');
    expect(container.querySelector('.mx-empty')).toBeNull();
  });
});
