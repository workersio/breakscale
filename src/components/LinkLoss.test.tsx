// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Inspector } from './Inspector';
import {
  DEFAULT_LOSS_RATE,
  faultActionsFor,
  faultViewFor,
  withEdgeLoss,
} from './faultWiring';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';

/**
 * Packet loss on a selected connection, driven the way a student drives it:
 * select the edge on the canvas with a real pointer sequence, pick a share,
 * press Set loss, and read it back from the topology and the engine.
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

/** The latest topology the harness committed, for the assertions. */
let current: Topology;

function commit(t: Topology): void {
  current = t;
}

function Harness({ engine, initial }: { engine: Engine; initial: Topology }) {
  const [topology, setTopology] = useState(initial);
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
  // The same steps as the shell's handler, minus the undo history.
  const onEdgeLoss = (edgeId: string, lossRate: number) => {
    const next = withEdgeLoss(topology, edgeId, lossRate);
    if (!next) return;
    setTopology(next);
    commit(next);
    engine.setTopology(next);
    setSnapshot(engine.snapshot());
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
        onEdgeLoss={onEdgeLoss}
      />
    </>
  );
}

function mount(): Engine {
  const preset = PRESETS.find((p) => p.id === 'circuit-breaker');
  if (!preset) throw new Error('circuit-breaker preset missing');
  const topology = structuredClone(preset.topology);
  const engine = new Engine(topology);
  commit(topology);
  act(() => root.render(<Harness engine={engine} initial={topology} />));
  return engine;
}

function hit(kind: 'node' | 'edge', id: string): Element {
  const el = container.querySelector(`[data-hit="${kind}"][data-id="${id}"]`);
  if (!el) throw new Error(`no ${kind} hit for ${id}`);
  return el;
}

function setLoss(): HTMLButtonElement {
  const b = [...container.querySelectorAll<HTMLButtonElement>('.ins button')].find(
    (x) => x.textContent?.trim() === 'Set loss',
  );
  if (!b) throw new Error('no Set loss button');
  return b;
}

function lossSelect(): HTMLSelectElement {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.textContent === 'Requests lost on the way',
  );
  const el = label && document.getElementById(label.getAttribute('for') ?? '');
  if (!(el instanceof HTMLSelectElement)) throw new Error('no loss select');
  return el;
}

function choose(select: HTMLSelectElement, value: number): void {
  act(() => {
    select.value = String(value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function lossOn(id: string): number | undefined {
  return current.edges.find((e) => e.id === id)?.lossRate;
}

describe('packet loss control', () => {
  it('is offered for one selected connection, and not for a node', () => {
    mount();
    press(hit('node', 'payments'));
    expect(container.textContent).not.toContain('Requests lost on the way');
    press(hit('edge', 'breaker->payments'));
    expect(lossSelect().value).toBe(String(DEFAULT_LOSS_RATE));
    expect(container.textContent).toContain('Delivers every request sent across it.');
  });

  it('Set loss writes the edge and the engine drops at that rate', () => {
    const engine = mount();
    press(hit('edge', 'breaker->payments'));
    choose(lossSelect(), 0.25);
    press(setLoss());
    expect(lossOn('breaker->payments')).toBe(0.25);
    expect(container.textContent).toContain(
      'Losing 25% of the requests sent across it.',
    );
    for (let i = 0; i < 30; i++) engine.advance(100);
    expect(engine.snapshot().failuresByReason['packet-loss']).toBeGreaterThan(0);
    // A press that would change nothing is inert and keeps focus.
    const b = setLoss();
    b.focus();
    expect(b.getAttribute('aria-disabled')).toBe('true');
    press(b);
    expect(document.activeElement).toBe(b);
  });

  it('None removes the field, so the design is as it was', () => {
    mount();
    press(hit('edge', 'breaker->payments'));
    press(setLoss());
    expect(lossOn('breaker->payments')).toBe(DEFAULT_LOSS_RATE);
    choose(lossSelect(), 0);
    press(setLoss());
    const edge = current.edges.find((e) => e.id === 'breaker->payments');
    expect(edge && 'lossRate' in edge).toBe(false);
  });

  it('shows a loaded value the list does not offer', () => {
    const preset = PRESETS.find((p) => p.id === 'circuit-breaker');
    if (!preset) throw new Error('circuit-breaker preset missing');
    const topology = structuredClone(preset.topology);
    topology.edges = topology.edges.map((e) =>
      e.id === 'api->breaker' ? { ...e, lossRate: 0.03 } : e,
    );
    const engine = new Engine(topology);
    act(() => root.render(<Harness engine={engine} initial={topology} />));
    press(hit('edge', 'api->breaker'));
    expect(lossSelect().value).toBe('0.03');
    expect(setLoss().getAttribute('aria-disabled')).toBe('true');
  });
});

describe('withEdgeLoss', () => {
  const t: Topology = {
    nodes: [],
    edges: [{ id: 'a->b', from: 'a', to: 'b', weight: 1 }],
  };

  it('returns null when nothing changes or the edge is missing', () => {
    expect(withEdgeLoss(t, 'a->b', 0)).toBeNull();
    expect(withEdgeLoss(t, 'x->y', 0.1)).toBeNull();
  });

  it('leaves the other edges and the input untouched', () => {
    const next = withEdgeLoss(t, 'a->b', 0.1);
    expect(next?.edges[0]).toEqual({
      id: 'a->b',
      from: 'a',
      to: 'b',
      weight: 1,
      lossRate: 0.1,
    });
    expect(t.edges[0]).toEqual({ id: 'a->b', from: 'a', to: 'b', weight: 1 });
  });
});
