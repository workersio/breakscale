// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Metrics } from './Metrics';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import { formatMs, formatPct, formatRate } from './format';
import {
  compareRows,
  pinInWindow,
  pinLabel,
  pinRun,
  type PinnedRun,
} from './pinnedRun';
import type { SimSnapshot, SystemStats } from '../sim/types';

/**
 * Pin this run: the strip keeps one run's measured numbers and samples, and
 * reads them against the live ones. Nothing in a pin is computed; every
 * figure is one the bar or the charts printed at the time.
 */

let container: HTMLDivElement;
let root: Root;

/* jsdom has no PointerEvent; React reads pointerType off this one. */
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

/** A press the way a mouse makes one, ending in the click. */
function press(el: Element | null | undefined, pointerType = 'mouse'): void {
  if (!el) throw new Error('nothing to press');
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerdown', { ...at, buttons: 1, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerup', { ...at, buttons: 0, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

function runAt(rps: number, ms: number): SimSnapshot {
  const topo = structuredClone(PRESETS.find((p) => p.id === 'single-server')!.topology);
  for (const n of topo.nodes) if (n.kind === 'client') n.config = { ...n.config, rps };
  const engine = new Engine(topo, 7);
  for (let t = 0; t < ms; t += 50) engine.advance(50);
  // Detached, as the shell's 10Hz copy is from the engine's live buffers.
  return structuredClone(engine.snapshot());
}

const system = (s: Partial<SystemStats>): SystemStats =>
  ({ p99: 0, goodputRps: 0, errorRate: 0, timeMs: 0, ...s }) as SystemStats;

describe('pinRun and compareRows', () => {
  it('copies the bar figures and the samples, detached from the live buffer', () => {
    const snap = runAt(400, 20_000);
    const pin = pinRun(snap.system, snap.history, 400);
    expect(pin.p99).toBe(snap.system.p99);
    expect(pin.goodput).toBe(snap.system.goodputRps);
    expect(pin.errorRate).toBe(snap.system.errorRate);
    expect(pin.history).toEqual(snap.history);
    expect(pin.history[0]).not.toBe(snap.history[0]);
    expect(pinLabel(pin)).toBe('Pinned at 20s, 400/s');
  });

  it('reads then and now as the bar prints them, and says which way they moved', () => {
    const pin: PinnedRun = {
      atMs: 30_000,
      rps: 300,
      p99: 218,
      goodput: 150,
      errorRate: 0.07,
      history: [],
    };
    const rows = compareRows(
      pin,
      system({ p99: 127, goodputRps: 200, errorRate: 0 }),
      300,
    );
    expect(rows.map((r) => `${r.name} ${r.then} → ${r.now} ${r.tone}`)).toEqual([
      'p99 218ms → 127ms better',
      'Goodput 150/s → 200/s better',
      'Errors 7% → 0% better',
    ]);
  });

  it('calls no verdict on goodput at a different load, or on figures that print the same', () => {
    const pin: PinnedRun = {
      atMs: 0,
      rps: 300,
      p99: 120.2,
      goodput: 186,
      errorRate: 0,
      history: [],
    };
    const rows = compareRows(
      pin,
      system({ p99: 119.9, goodputRps: 400, errorRate: 0 }),
      500,
    );
    expect(rows.map((r) => r.tone)).toEqual(['same', 'same', 'same']);
  });

  it('calls drift no change at all', () => {
    // Measured in the browser: the same design at 50/s, pinned at 13s and
    // read again after a reset, went 49/s to 43/s and 131ms to 134ms.
    const pin: PinnedRun = {
      atMs: 0,
      rps: 50,
      p99: 131,
      goodput: 49,
      errorRate: 0.07,
      history: [],
    };
    const rows = compareRows(
      pin,
      system({ p99: 134, goodputRps: 43, errorRate: 0.068 }),
      50,
    );
    expect(rows.map((r) => `${r.then} → ${r.now} ${r.tone}`)).toEqual([
      '131ms → 134ms same',
      '49/s → 43/s same',
      '7% → 6.8% same',
    ]);
  });

  it('calls a real loss worse, and new failures worse', () => {
    const pin: PinnedRun = {
      atMs: 0,
      rps: 300,
      p99: 120,
      goodput: 300,
      errorRate: 0,
      history: [],
    };
    const rows = compareRows(
      pin,
      system({ p99: 160, goodputRps: 200, errorRate: 0.003 }),
      300,
    );
    expect(rows.map((r) => r.tone)).toEqual(['worse', 'worse', 'worse']);
  });

  it('an outage reads "no replies" and counts as the worst p99', () => {
    const pin: PinnedRun = {
      atMs: 0,
      rps: 300,
      p99: 90,
      goodput: 300,
      errorRate: 0,
      history: [],
    };
    const [p99] = compareRows(
      pin,
      system({ p99: 0, goodputRps: 0, errorRate: 1 }),
      300,
    );
    expect(p99).toMatchObject({ then: '90ms', now: 'no replies', tone: 'worse' });
  });

  it('keeps only samples inside the drawn window', () => {
    const snap = runAt(100, 30_000);
    const pin = pinRun(snap.system, snap.history, 100);
    const kept = pinInWindow(pin, 10_000, 12_000);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((p) => p.t >= 10_000 && p.t <= 12_000)).toBe(true);
  });
});

describe('the pin row in the strip', () => {
  const pinBtn = () =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Pin this run',
    );

  it('is absent before anything is measured', () => {
    const snap = runAt(100, 0);
    act(() =>
      root.render(<Metrics snapshot={snap} onPin={() => {}} idle="not-started" />),
    );
    expect(pinBtn()).toBeUndefined();
  });

  it('pins what is on screen, then reads it against now and draws it on two charts', () => {
    const before = runAt(400, 20_000);
    let pin: PinnedRun | null = null;
    act(() =>
      root.render(
        <Metrics snapshot={before} rps={400} onPin={(p) => (pin = p)} pin={null} />,
      ),
    );
    press(pinBtn());
    expect(pin).not.toBeNull();
    const held = pin as unknown as PinnedRun;
    expect(held.p99).toBe(before.system.p99);

    // A fresh run of a lighter load, as after Reset and a change.
    const after = runAt(100, 20_000);
    act(() =>
      root.render(<Metrics snapshot={after} rps={400} onPin={() => {}} pin={held} />),
    );
    const row = container.querySelector('.mx-pin')!;
    expect(row.querySelector('.mx-pin-label')?.textContent).toBe(
      'Pinned at 20s, 400/s',
    );
    const text = [...row.querySelectorAll('.mx-pin-row')].map((li) =>
      [...li.querySelectorAll('.mx-pin-then, .mx-pin-now')].map((n) => n.textContent),
    );
    expect(text).toEqual([
      [formatMs(before.system.p99), formatMs(after.system.p99)],
      [formatRate(before.system.goodputRps), formatRate(after.system.goodputRps)],
      [formatPct(before.system.errorRate), formatPct(after.system.errorRate)],
    ]);
    for (const name of ['Latency', 'Throughput']) {
      const chart = container.querySelector(`section[aria-label^="${name}"]`)!;
      const line = chart.querySelector('.mx-line-pin');
      expect(line?.getAttribute('points')?.split(' ').length, name).toBeGreaterThan(10);
      expect(chart.querySelector('.mx-key-pin'), name).not.toBeNull();
    }
  });

  it('clears', () => {
    const snap = runAt(100, 10_000);
    const held = pinRun(snap.system, snap.history, 100);
    const onPin = vi.fn();
    act(() =>
      root.render(<Metrics snapshot={snap} rps={100} onPin={onPin} pin={held} />),
    );
    press(container.querySelector('[aria-label="Clear the pinned run"]'));
    expect(onPin).toHaveBeenCalledWith(null);
  });
});
