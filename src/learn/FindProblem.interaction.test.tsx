// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from '../components/Canvas';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';
import { FindProblem } from './FindProblem';
import { currentFinding, spotlightOf, type Finding } from './finding';

/**
 * The button, the answer and the ring together, driven with the pointer
 * sequence a browser sends, against a real engine run.
 */

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

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function press(el: Element, pointerType = 'mouse'): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 };
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

function loaded(
  id: string,
  factor: number,
  seconds: number,
): { engine: Engine; topology: Topology } {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`no preset ${id}`);
  const topology: Topology = {
    ...preset.topology,
    nodes: preset.topology.nodes.map((n) =>
      n.kind === 'client'
        ? { ...n, config: { ...n.config, rps: n.config.rps * factor } }
        : n,
    ),
  };
  const engine = new Engine(topology, 1);
  for (let i = 0; i < seconds * 10; i += 1) engine.advance(100);
  return { engine, topology };
}

let selected: string[] = [];
let setSnap: ((s: SimSnapshot) => void) | null = null;

function Harness({ engine, topology }: { engine: Engine; topology: Topology }) {
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => engine.snapshot());
  useEffect(() => {
    setSnap = setSnapshot;
  }, []);
  const [finding, setFinding] = useState<Finding | null>(null);
  const shown = currentFinding(finding, topology, snapshot);
  return (
    <>
      <Canvas
        topology={topology}
        snapshot={snapshot}
        selectedIds={new Set()}
        onSelectionChange={() => {}}
        onMoveNode={() => {}}
        onConnect={() => {}}
        onDeleteSelection={() => {}}
        onDropNode={() => {}}
        spotlightId={spotlightOf(shown)}
      />
      <FindProblem
        topology={topology}
        snapshot={snapshot}
        finding={shown}
        onChange={setFinding}
        onSelect={(id) => selected.push(id)}
      />
    </>
  );
}

function button(name: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === name || x.getAttribute('aria-label') === name,
  );
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

const status = () => container.querySelector('.fp [role="status"]');
const ring = () => container.querySelector('.cv-spotlight');

describe('Find the problem', () => {
  beforeEach(() => {
    selected = [];
  });

  it('rings the database and says why, then Escape clears both', () => {
    const run = loaded('single-server', 5.4, 10);
    act(() => root.render(<Harness {...run} />));
    expect(ring()).toBeNull();

    press(button('Find the problem'));
    expect(status()?.textContent).toMatch(
      /^Database: all 6 slots busy, \d+ waiting in line/,
    );
    expect(ring()).not.toBeNull();
    expect(ring()?.textContent).toBe('Here');

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(ring()).toBeNull();
    expect(status()?.textContent).toBe('');
  });

  it('works from a touch tap, and Select it hands over the node', () => {
    const run = loaded('single-server', 5.4, 10);
    act(() => root.render(<Harness {...run} />));
    press(button('Find the problem'), 'touch');
    press(button('Select it'), 'touch');
    const db = run.topology.nodes.find((n) => n.kind === 'db')?.id;
    expect(selected).toEqual([db]);
    // Pressing an action in the answer must not dismiss it.
    expect(ring()).not.toBeNull();
  });

  it('clears on a press on the bare canvas, and on the close button', () => {
    const run = loaded('single-server', 5.4, 10);
    act(() => root.render(<Harness {...run} />));
    press(button('Find the problem'));
    const surface = container.querySelector('.cv-surface');
    if (!surface) throw new Error('no surface');
    press(surface);
    expect(ring()).toBeNull();

    press(button('Find the problem'));
    expect(ring()).not.toBeNull();
    press(button('Close'));
    expect(ring()).toBeNull();
  });

  it('says nothing is struggling at the starting load, with no ring', () => {
    const run = loaded('single-server', 1, 10);
    act(() => root.render(<Harness {...run} />));
    press(button('Find the problem'));
    expect(status()?.textContent).toMatch(/^Nothing is struggling right now\./);
    expect(ring()).toBeNull();
  });

  it('keeps its status in the accessibility tree while there is no answer', () => {
    const run = loaded('single-server', 1, 2);
    act(() => root.render(<Harness {...run} />));
    const live = status();
    expect(live).not.toBeNull();
    expect(live?.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    // The visible copy is not read twice.
    press(button('Find the problem'));
    expect(container.querySelector('.fp-text')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(status()).toBe(live);
  });

  it('hands focus back to the trigger when the answer closes around it', () => {
    const run = loaded('single-server', 5.4, 10);
    act(() => root.render(<Harness {...run} />));
    press(button('Find the problem'));
    const select = button('Select it');
    act(() => select.focus());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(ring()).toBeNull();
    expect(document.activeElement).toBe(button('Find the problem'));

    press(button('Find the problem'));
    const close = button('Close');
    act(() => close.focus());
    press(close);
    expect(document.activeElement).toBe(button('Find the problem'));
  });

  it('drops a stale answer when the clock goes back', () => {
    const run = loaded('single-server', 5.4, 10);
    act(() => root.render(<Harness {...run} />));
    press(button('Find the problem'));
    expect(ring()).not.toBeNull();
    const fresh = new Engine(run.topology, 1);
    act(() => setSnap?.(fresh.snapshot()));
    expect(ring()).toBeNull();
  });
});
