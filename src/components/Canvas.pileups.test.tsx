// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Engine } from '../sim/engine';
import { defaultConfig } from '../sim/presets';
import { EO_FIRST, EO_LOST, EO_RETRY } from '../sim/edgeOutcomes';
import type { SimSnapshot, Topology } from '../sim/types';
import { __resetPreferences } from '../content/preferences';
import { SETTLE_SNAPSHOTS } from './settledHealth';

/**
 * Piling up and dropping, mounted: the waiting-line bar and its hold, the
 * refusing brim, the retry loop, the loss ticks and the cut label.
 */

const TOPOLOGY: Topology = {
  nodes: [
    {
      id: 'client',
      kind: 'client',
      label: 'Client',
      x: 0,
      y: 0,
      config: { ...defaultConfig('client'), rps: 50 },
    },
    {
      id: 'api',
      kind: 'service',
      label: 'API',
      x: 400,
      y: 0,
      config: { ...defaultConfig('service'), queueLimit: 64 },
    },
  ],
  edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1, lossRate: 0.1 }],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  __resetPreferences();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  __resetPreferences();
});

const BASE: SimSnapshot = (() => {
  const e = new Engine(TOPOLOGY, 5);
  for (let i = 0; i < 60; i++) e.advance(1000 / 60);
  return e.snapshot();
})();

/** The base snapshot at `timeMs`, with the API's line as given. */
function snap(
  timeMs: number,
  queued: number,
  shedRate = 0,
  edgeState: SimSnapshot['edgeState'] = BASE.edgeState,
): SimSnapshot {
  const api = BASE.nodes.api!;
  return {
    ...BASE,
    system: { ...BASE.system, timeMs },
    nodes: { ...BASE.nodes, api: { ...api, queued, queueLimit: 64, shedRate } },
    edgeState,
  };
}

type Reader = (id: string, out: Float64Array) => boolean;
const NONE: Reader = () => false;

function render(snapshot: SimSnapshot, read: Reader = NONE) {
  act(() =>
    root.render(
      <Canvas
        topology={TOPOLOGY}
        snapshot={snapshot}
        readOutcomes={read}
        selectedIds={new Set()}
        onSelectionChange={() => {}}
        onMoveNode={() => {}}
        onConnect={() => {}}
        onDeleteSelection={() => {}}
        onDropNode={() => {}}
      />,
    ),
  );
}

function apiNode(): Element | null {
  return container.querySelector('[data-hit="node"][data-id="api"]');
}

describe('the waiting-line bar', () => {
  it('appears once a line has held for the settle run, and not before', () => {
    render(snap(1000, 0));
    for (let i = 1; i <= SETTLE_SNAPSHOTS; i++) {
      expect(apiNode()?.querySelector('.cv-line'), `snapshot ${i}`).toBeNull();
      render(snap(1000 + i * 100, 40));
    }
    const line = apiNode()?.querySelector('.cv-line');
    expect(line).not.toBeNull();
    expect(line?.classList.contains('is-refusing')).toBe(false);
    // 40 of 64 across the meter's width.
    const fill = Number(line?.querySelector('.cv-line-fill')?.getAttribute('width'));
    const track = Number(line?.querySelector('.cv-line-track')?.getAttribute('width'));
    expect(fill / track).toBeCloseTo(40 / 64, 5);
    expect(line?.querySelector('title')?.textContent).toBe('40 of 64 waiting in line');
    expect(apiNode()?.getAttribute('aria-label')).toContain('40 of 64 waiting in line');
  });

  it('marks the brim refusing at once when the full line turns calls away', () => {
    render(snap(1000, 0));
    render(snap(1100, 64, 312));
    const line = apiNode()?.querySelector('.cv-line');
    expect(line?.classList.contains('is-refusing')).toBe(true);
    expect(apiNode()?.getAttribute('aria-label')).toContain('turning calls away');
    // Calm returns only after the settle run.
    for (let i = 2; i <= SETTLE_SNAPSHOTS; i++) {
      render(snap(1000 + i * 100, 20, 0));
      expect(apiNode()?.querySelector('.cv-line.is-refusing')).not.toBeNull();
    }
    render(snap(1000 + (SETTLE_SNAPSHOTS + 1) * 100, 20, 0));
    expect(apiNode()?.querySelector('.cv-line.is-refusing')).toBeNull();
    expect(apiNode()?.querySelector('.cv-line')).not.toBeNull();
  });
});

describe('marks on the wire', () => {
  function reader(retry: number, lost: number): Reader {
    return (_id, out) => {
      out.fill(0);
      out[EO_FIRST] = 100;
      out[EO_RETRY] = retry;
      out[EO_LOST] = lost;
      return true;
    };
  }

  it('draws the retry loop only while calls are being tried again', () => {
    render(snap(1000, 0), reader(0, 0));
    expect(container.querySelector('.cv-edge-retry')).toBeNull();
    render(snap(1100, 0), reader(240, 0));
    expect(container.querySelector('.cv-edge-retry-loop')).not.toBeNull();
    // A 216px gap between the cards has room for the long caption.
    expect(container.querySelector('.cv-edge-label.is-retry')?.textContent).toBe(
      '+240/s tried again',
    );
  });

  it('marks a lossy link, faint until a drop is measured', () => {
    render(snap(1000, 0), reader(0, 0));
    expect(container.querySelector('.cv-edge-loss')).not.toBeNull();
    expect(container.querySelector('.cv-edge-loss.is-dropping')).toBeNull();
    // 12 lost of 100 + 20 sent.
    render(snap(1100, 0), reader(20, 12));
    expect(container.querySelector('.cv-edge-loss.is-dropping')).not.toBeNull();
    const caption = [...container.querySelectorAll('.cv-edge-label')].find((t) =>
      t.textContent?.endsWith('lost'),
    );
    expect(caption?.textContent).toBe('10% lost');
  });

  it('names a cut wire and explains it on hover', () => {
    render(snap(1000, 0, 0, { 'client->api': 'cut' }));
    expect(container.querySelector('.cv-edge-label.is-severed')?.textContent).toBe(
      'cut',
    );
    expect(container.querySelector('.cv-edge-hit title')?.textContent).toBe(
      'Network split. Calls fail at the caller.',
    );
    // A severed wire draws no loss ticks over its break.
    expect(container.querySelector('.cv-edge-loss')).toBeNull();
  });
});
