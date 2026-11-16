// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Engine } from '../sim/engine';
import { defaultConfig } from '../sim/presets';
import type { Topology } from '../sim/types';
import { __resetPreferences, setPreference } from '../content/preferences';

/**
 * Traffic dots, mounted. The motion itself needs a browser; this pins what
 * decides whether there is any: the setting, reduced motion and the zoom, and
 * that the still bars carry the engine's measured mix.
 */

const TOPOLOGY: Topology = {
  nodes: [
    {
      id: 'client',
      kind: 'client',
      label: 'Client',
      x: 0,
      y: 0,
      config: { ...defaultConfig('client'), rps: 400 },
    },
    {
      id: 'api',
      kind: 'service',
      label: 'API',
      x: 320,
      y: 0,
      // Ceiling 1 * 1000 / 10 = 100 rps, so most calls are turned away.
      config: {
        ...defaultConfig('service'),
        capacity: 1,
        serviceMs: 10,
        queueLimit: 4,
      },
    },
  ],
  edges: [{ id: 'client->api', from: 'client', to: 'api', weight: 1 }],
};

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  width = 1;
  height = 1;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let container: HTMLDivElement;
let root: Root;
let reduce = false;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  reduce = false;
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('reduced-motion') ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  try {
    localStorage.removeItem('breakscale.trafficKey.open');
  } catch {
    // jsdom without storage: the key starts folded either way.
  }
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

function mount(
  engine: Engine,
  onSelectionChange: (ids: ReadonlySet<string>) => void = () => {},
) {
  act(() =>
    root.render(
      <Canvas
        topology={TOPOLOGY}
        snapshot={engine.snapshot()}
        readOutcomes={(id, out) => engine.readEdgeOutcomes(id, out)}
        selectedIds={new Set()}
        onSelectionChange={onSelectionChange}
        onMoveNode={() => {}}
        onConnect={() => {}}
        onDeleteSelection={() => {}}
        onDropNode={() => {}}
      />,
    ),
  );
}

function running(): Engine {
  const engine = new Engine(TOPOLOGY, 5);
  engine.setEdgeOutcomes(true);
  for (let i = 0; i < 180; i++) engine.advance(1000 / 60);
  return engine;
}

describe('traffic dots on the canvas', () => {
  it('draws a dot layer, hides the dashes, and shows the key', () => {
    localStorage.setItem('breakscale.trafficKey.open', '1');
    mount(running());
    expect(container.querySelector('.cv-dots')).not.toBeNull();
    expect(container.querySelectorAll('.cv-dots path')).toHaveLength(7);
    expect(container.querySelector('.cv-host')?.classList.contains('has-dots')).toBe(
      true,
    );
    const key = container.querySelector('.cv-key');
    expect(key?.getAttribute('data-chrome')).toBe('traffic-key');
    expect(key?.textContent).toContain('Turned away at the door');
    expect(key?.textContent).toContain('Busier connections carry more dots.');
  });

  it('turns off with the setting', () => {
    const engine = running();
    mount(engine);
    act(() => setPreference('trafficDots', false));
    expect(container.querySelector('.cv-dots')).toBeNull();
    expect(container.querySelector('.cv-key')).toBeNull();
    expect(container.querySelector('.cv-host')?.classList.contains('has-dots')).toBe(
      false,
    );
  });

  it('shows still bars instead with reduced motion, split by the measured mix', () => {
    reduce = true;
    localStorage.setItem('breakscale.trafficKey.open', '1');
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    mount(running());
    expect(container.querySelector('.cv-dots')).toBeNull();
    expect(container.querySelector('.cv-dots-still')).not.toBeNull();
    // No more frames are asked for than with the dots switched off: the
    // canvas has rAF work of its own, the dots add none.
    const withBars = raf.mock.calls.length;
    act(() => root.unmount());
    root = createRoot(container);
    raf.mockClear();
    setPreference('trafficDots', false);
    mount(running());
    expect(withBars).toBe(raf.mock.calls.length);
    act(() => setPreference('trafficDots', true));
    const refused = container
      .querySelector('.cv-dots-bar.is-refused')
      ?.getAttribute('d');
    const ok = container.querySelector('.cv-dots-bar.is-ok')?.getAttribute('d');
    const width = (d: string | null | undefined) =>
      Number(/h([\d.]+)/.exec(d ?? '')?.[1] ?? 0);
    // 400 offered against a 100 rps ceiling: about three in four turned away.
    expect(width(refused)).toBeGreaterThan(width(ok));
    expect(width(refused) + width(ok)).toBeGreaterThan(26);
    expect(container.querySelector('.cv-key')?.textContent).toContain(
      'Each bar shows how calls on that connection ended.',
    );
  });

  it('opens and folds the key with a real press, without panning or selecting', () => {
    const select = vi.fn();
    mount(running(), select);
    const toggle = container.querySelector<HTMLButtonElement>('.cv-key-toggle')!;
    // Folded at first, so it never sits over the example's note.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#cv-key-body')).toBeNull();
    const camera = () =>
      [...container.querySelectorAll('svg g[transform]')].map((g) =>
        g.getAttribute('transform'),
      );
    const before = camera();
    const press = (dx: number) => {
      const at = { bubbles: true, cancelable: true, clientX: 40, clientY: 500 };
      const end = { ...at, clientX: 40 + dx };
      act(() => {
        toggle.dispatchEvent(
          new FakePointerEvent('pointerdown', { ...at, buttons: 1 }),
        );
        toggle.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
      });
      act(() => {
        toggle.dispatchEvent(
          new FakePointerEvent('pointermove', { ...end, buttons: 1 }),
        );
        toggle.dispatchEvent(new FakePointerEvent('pointerup', { ...end, buttons: 0 }));
        toggle.dispatchEvent(new MouseEvent('mouseup', { ...end, buttons: 0 }));
        toggle.dispatchEvent(new MouseEvent('click', { ...end, buttons: 0 }));
      });
    };
    press(3);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('#cv-key-body')?.textContent).toContain(
      'Turned away at the door',
    );
    expect(toggle.textContent).toBe('Hide key');
    press(30);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('#cv-key-body')).toBeNull();
    expect(camera()).toEqual(before);
    expect(container.querySelector('.cv-marquee')).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });
});
