// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Inspector } from './Inspector';
import {
  DEFAULT_GLITCH_RATE,
  DEFAULT_SLOW_FACTOR,
  faultActionsFor,
  faultViewFor,
} from './faultWiring';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';

/**
 * The fault controls, driven the way a student drives them: select on the
 * canvas with a real pointer sequence, press a button in the inspector, and
 * read the result back from the engine's schedule and from the canvas.
 *
 * The harness wires Canvas and Inspector to a real Engine through the same
 * faultViewFor() and faultActionsFor() the shell uses, so what is tested is the shipped
 * wiring rather than a copy of it.
 */

/** jsdom has no PointerEvent, so provide the parts the handlers read. */
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

/**
 * A press as a browser delivers it: pointerdown, mousedown, pointerup,
 * mouseup, then the synthesized click, all at one point.
 */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0 }));
  });
}

function Harness({ engine, topology }: { engine: Engine; topology: Topology }) {
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => engine.snapshot());
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set());
  const nodes = topology.nodes.filter((n) => sel.has(n.id));
  const node = nodes.length === 1 ? nodes[0] : null;
  const faults = {
    ...faultViewFor(engine, topology, snapshot, {
      node,
      nodeCount: nodes.length,
      edgeCount: sel.size - nodes.length,
      ids: sel,
    }),
    ...faultActionsFor(engine, () => setSnapshot(engine.snapshot())),
  };
  return (
    <>
      <Canvas
        topology={topology}
        snapshot={snapshot}
        selectedIds={sel}
        onSelectionChange={setSel}
        onMoveNode={() => {}}
        onConnect={() => {}}
        onDeleteSelection={() => {}}
        onDropNode={() => {}}
      />
      <Inspector
        node={node}
        stats={node ? (snapshot.nodes[node.id] ?? null) : null}
        onChange={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        selectedNodes={nodes}
        selectedEdgeCount={sel.size - nodes.length}
        faults={faults}
      />
    </>
  );
}

function circuitBreaker(): { engine: Engine; topology: Topology } {
  const preset = PRESETS.find((p) => p.id === 'circuit-breaker');
  if (!preset) throw new Error('circuit-breaker preset missing');
  const engine = new Engine(preset.topology);
  // Two seconds in, so recorded entries carry a time that is not zero.
  for (let i = 0; i < 20; i++) engine.advance(100);
  return { engine, topology: preset.topology };
}

function mount(): { engine: Engine; topology: Topology } {
  const made = circuitBreaker();
  act(() => root.render(<Harness engine={made.engine} topology={made.topology} />));
  return made;
}

function hit(kind: 'node' | 'edge', id: string): Element {
  const el = container.querySelector(`[data-hit="${kind}"][data-id="${id}"]`);
  if (!el) throw new Error(`no ${kind} hit for ${id}`);
  return el;
}

function button(name: string): HTMLButtonElement {
  const all = [...container.querySelectorAll<HTMLButtonElement>('.ins button')];
  const found = all.find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  );
  if (!found) {
    const names = all.map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    throw new Error(`no button "${name}" in ${JSON.stringify(names)}`);
  }
  return found;
}

function status(): string {
  return container.querySelector('.ins-fault-status')?.textContent ?? '';
}

function nodeGroup(id: string): Element {
  const el = hit('node', id);
  return el.closest('.cv-node') ?? el;
}

describe('fault controls on a selected node', () => {
  it('Crash records an inject at the current time and the canvas marks the node', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));
    expect(status()).toBe('Working normally.');

    const now = engine.snapshot().system.timeMs;
    press(button('Crash'));

    expect(engine.faultSchedule()).toEqual([
      { atMs: now, action: 'inject', nodeId: 'payments', kind: 'crash' },
    ]);
    expect(engine.activeFailures().map((f) => [f.nodeId, f.kind])).toEqual([
      ['payments', 'crash'],
    ]);
    expect(status()).toBe(
      'Crashed at 2.0s. Every request sent to it fails until you fix it.',
    );
    const g = nodeGroup('payments');
    expect(g.classList.contains('is-faulted')).toBe(true);
    expect(g.getAttribute('aria-label')).toContain('faulted: crash');
    expect(g.querySelector('.cv-node-mark.is-fault')).not.toBeNull();
  });

  it('a button that would change nothing records nothing and keeps focus', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));

    // Fix on a healthy node.
    const fix = button('Fix');
    expect(fix.getAttribute('aria-disabled')).toBe('true');
    expect(fix.disabled).toBe(false);
    press(fix);
    expect(engine.faultSchedule()).toEqual([]);

    // Crash twice.
    press(button('Crash'));
    const crash = button('Crash');
    expect(crash.getAttribute('aria-disabled')).toBe('true');
    crash.focus();
    press(crash);
    expect(engine.faultSchedule()).toHaveLength(1);
    expect(document.activeElement).toBe(crash);
  });

  it('Fix records a clear and the canvas drops the mark', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));
    press(button('Crash'));
    for (let i = 0; i < 5; i++) engine.advance(100);
    const now = engine.snapshot().system.timeMs;
    press(button('Fix'));

    expect(engine.faultSchedule().at(-1)).toEqual({
      atMs: now,
      action: 'clear',
      nodeId: 'payments',
    });
    expect(engine.activeFailures()).toEqual([]);
    expect(nodeGroup('payments').classList.contains('is-faulted')).toBe(false);
    expect(status()).toBe('Working normally.');
  });

  it('Slow and Glitch send the chosen factor and rate', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));

    press(button('Slow'));
    expect(engine.faultSchedule().at(-1)).toMatchObject({
      action: 'inject',
      kind: 'slow',
      opts: { factor: DEFAULT_SLOW_FACTOR },
    });
    expect(status()).toMatch(/^Running 5x slower since 2\.0s\./);

    const factor = container.querySelector<HTMLSelectElement>(
      '#' + labelFor('How much slower'),
    );
    if (!factor) throw new Error('no factor select');
    act(() => {
      factor.value = '10';
      factor.dispatchEvent(new Event('change', { bubbles: true }));
    });
    press(button('Slow'));
    expect(engine.faultSchedule().at(-1)).toMatchObject({ opts: { factor: 10 } });
    expect(engine.activeFailures()[0]).toMatchObject({ kind: 'slow', factor: 10 });

    press(button('Glitch'));
    expect(engine.faultSchedule().at(-1)).toMatchObject({
      kind: 'errors',
      opts: { rate: DEFAULT_GLITCH_RATE },
    });
    expect(status()).toMatch(/^Failing 50% of requests since 2\.0s\./);
    expect(engine.faultSchedule()).toHaveLength(3);
  });

  it('lists the node cables with names that say which cable', () => {
    const { engine } = mount();
    press(hit('node', 'breaker'));
    const names = [...container.querySelectorAll('.ins-fault-cable button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(names).toEqual(['Cut cable from API Server', 'Cut cable to Payments API']);

    press(button('Cut cable to Payments API'));
    expect(engine.activeCuts()).toEqual(['breaker->payments']);
    expect(button('Restore to Payments API')).toBeTruthy();
  });

  it('Reset replays what was pressed at the moment it was pressed', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));
    press(button('Crash'));
    const atMs = engine.faultSchedule()[0]!.atMs;

    engine.reset();
    expect(engine.activeFailures()).toEqual([]);
    while (engine.snapshot().system.timeMs < atMs) engine.advance(50);
    expect(engine.activeFailures().map((f) => f.kind)).toEqual(['crash']);
  });
});

describe('fault controls on a selected cable', () => {
  it('Cut cable and Restore record against the edge and the canvas shows the break', () => {
    const { engine } = mount();
    press(hit('edge', 'breaker->payments'));
    expect(container.querySelector('.ins-empty-hint')?.textContent).toBe(
      'Circuit Breaker to Payments API. Press Delete to remove it.',
    );
    expect(status()).toBe('Connected.');

    const now = engine.snapshot().system.timeMs;
    press(button('Cut cable'));
    expect(engine.faultSchedule()).toEqual([
      { atMs: now, action: 'cut', edgeId: 'breaker->payments' },
    ]);
    const wire = hit('edge', 'breaker->payments').closest('.cv-edge');
    expect(wire?.classList.contains('is-state-cut')).toBe(true);
    expect(wire?.querySelector('.cv-edge-break')).not.toBeNull();
    expect(status()).toBe('Cut. Nothing crosses this cable until you restore it.');

    press(button('Restore'));
    expect(engine.faultSchedule().at(-1)).toEqual({
      atMs: now,
      action: 'restore',
      edgeId: 'breaker->payments',
    });
    expect(engine.activeCuts()).toEqual([]);
    expect(wire?.classList.contains('is-state-cut')).toBe(false);
  });

  it('a cable cut by a node partition points at the node instead of offering Restore', () => {
    const made = circuitBreaker();
    made.engine.injectFailure('payments', 'partition', {
      edgeIds: ['breaker->payments'],
    });
    act(() => root.render(<Harness engine={made.engine} topology={made.topology} />));
    press(hit('edge', 'breaker->payments'));
    expect(status()).toBe(
      'Cut because Payments API is cut off from its cables. Fix Payments API to reconnect it.',
    );
    const restore = button('Restore');
    expect(restore.getAttribute('aria-disabled')).toBe('true');
    press(restore);
    expect(made.engine.faultSchedule()).toEqual([]);
  });
});

describe('wiring', () => {
  it('a shell that mirrors the schedule into its topology keeps it across an edit', () => {
    const { engine, topology } = circuitBreaker();
    engine.recordFailure('payments', 'slow', { factor: 5 });
    for (let i = 0; i < 10; i++) engine.advance(100);
    engine.recordCutEdge('api->breaker');
    const recorded = engine.faultSchedule();

    // What App does after a record, then a later edit carrying that list.
    const mirrored: Topology = { ...topology, faults: recorded };
    engine.setTopology({
      ...mirrored,
      nodes: mirrored.nodes.map((n) =>
        n.id === 'api' ? { ...n, config: { ...n.config, capacity: 30 } } : n,
      ),
    });
    expect(engine.faultSchedule()).toEqual(recorded);
    engine.reset();
    for (let i = 0; i < 40; i++) engine.advance(100);
    expect(engine.activeFailures().map((f) => f.kind)).toEqual(['slow']);
    expect(engine.activeCuts()).toEqual(['api->breaker']);
  });

  it('builds nothing for an empty selection', () => {
    const { engine, topology } = circuitBreaker();
    const f = faultViewFor(engine, topology, engine.snapshot(), {
      node: null,
      nodeCount: 0,
      edgeCount: 0,
      ids: new Set(),
    });
    expect(f.fault).toBeNull();
    expect(f.cables).toEqual([]);
    expect(f.edge).toBeNull();
  });
});

describe('forgetting the saved faults', () => {
  it('shows only once something is saved, and Reset then starts a clean run', () => {
    const { engine } = mount();
    press(hit('node', 'payments'));
    expect(container.querySelector('.ins-fault-recorded')).toBeNull();

    press(button('Crash'));
    expect(container.querySelector('.ins-fault-recorded')?.textContent).toContain(
      '1 fault is saved with this run.',
    );
    press(button('Forget saved faults'));

    expect(engine.faultSchedule()).toEqual([]);
    expect(container.querySelector('.ins-fault-recorded')).toBeNull();
    // What is in force stays in force; only the replay is gone.
    expect(engine.activeFailures().map((f) => f.kind)).toEqual(['crash']);
    engine.reset();
    for (let i = 0; i < 40; i++) engine.advance(100);
    expect(engine.activeFailures()).toEqual([]);
  });

  it('is offered for a selected cable too', () => {
    const { engine } = mount();
    press(hit('edge', 'api->breaker'));
    press(button('Cut cable'));
    expect(container.querySelector('.ins-fault-recorded')?.textContent).toContain(
      '1 fault is saved',
    );
    press(button('Forget saved faults'));
    expect(engine.faultSchedule()).toEqual([]);
  });
});

/** The id of the control a visible label points at. */
function labelFor(text: string): string {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === text,
  );
  const id = label?.getAttribute('for');
  if (!id) throw new Error(`no label "${text}"`);
  return CSS.escape(id);
}
