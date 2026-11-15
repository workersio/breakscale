// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Inspector } from './Inspector';
import { DEFAULT_DUP_RATE, faultActionsFor, faultViewFor } from './faultWiring';
import { applyFaultChange, undoableFaultActions } from './faultUndo';
import type { FaultChange } from './faultUndo';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';

/**
 * Requests delivered twice, driven the way a student drives it: select a
 * cable on the canvas with a real pointer sequence, pick a share, press
 * Duplicate, and read the result back from the engine and the inspector.
 * Wired through the same faultViewFor, faultActionsFor and
 * undoableFaultActions the shell uses.
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

const entries: FaultChange[] = [];

function Harness({ engine, topology }: { engine: Engine; topology: Topology }) {
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => engine.snapshot());
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set());
  const nodes = topology.nodes.filter((n) => sel.has(n.id));
  const actions = useMemo(
    () =>
      undoableFaultActions(
        engine,
        faultActionsFor(engine, () => setSnapshot(engine.snapshot())),
        {
          history: { commitFault: (_label, _before, change) => entries.push(change) },
          before: {
            topology,
            selectedIds: new Set(),
            rps: 0,
            presetId: null,
            challengeId: null,
          },
        },
      ),
    [engine, topology],
  );
  const faults = {
    ...faultViewFor(engine, topology, snapshot, {
      node: null,
      nodeCount: nodes.length,
      edgeCount: sel.size - nodes.length,
      ids: sel,
    }),
    ...actions,
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
        node={null}
        stats={null}
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

function mount(presetId: string): { engine: Engine; topology: Topology } {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`${presetId} preset missing`);
  const engine = new Engine(preset.topology);
  for (let i = 0; i < 20; i++) engine.advance(100);
  act(() => root.render(<Harness engine={engine} topology={preset.topology} />));
  return { engine, topology: preset.topology };
}

function hit(id: string): Element {
  const el = container.querySelector(`[data-hit="edge"][data-id="${id}"]`);
  if (!el) throw new Error(`no edge hit for ${id}`);
  return el;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.ins button')].find(
    (b) => b.textContent?.trim() === name,
  );
}

function statuses(): string[] {
  return [...container.querySelectorAll('.ins-fault-status')].map(
    (p) => p.textContent ?? '',
  );
}

describe('requests delivered twice, on a selected cable', () => {
  it('Duplicate records the chosen share, says so, and Deliver once stops it', () => {
    entries.length = 0;
    const { engine } = mount('circuit-breaker');
    press(hit('breaker->payments'));
    const select = container.querySelector<HTMLSelectElement>('select[id$="-dup"]');
    if (!select) throw new Error('no share select');
    expect(Number(select.value)).toBe(DEFAULT_DUP_RATE);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      '1%',
      '5%',
      '10%',
      '25%',
    ]);
    expect(button('Deliver once')?.getAttribute('aria-disabled')).toBe('true');

    act(() => {
      select.value = '0.25';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const now = engine.snapshot().system.timeMs;
    const dup = button('Duplicate');
    if (!dup) throw new Error('no Duplicate button');
    press(dup);
    expect(engine.faultSchedule()).toEqual([
      { atMs: now, action: 'duplicate', edgeId: 'breaker->payments', rate: 0.25 },
    ]);
    expect(statuses()[1]).toBe(
      'Delivering 25% of requests twice since 2.0s, 0 requests so far. The second copy does the work again, and nobody hears its answer.',
    );
    // Pressing it again at the same share changes nothing.
    expect(dup.getAttribute('aria-disabled')).toBe('true');
    press(dup);
    expect(engine.faultSchedule()).toHaveLength(1);

    const once = button('Deliver once');
    if (!once) throw new Error('no Deliver once button');
    expect(once.getAttribute('aria-disabled')).toBe('false');
    press(once);
    expect(engine.faultSchedule().at(-1)).toEqual({
      atMs: now,
      action: 'undup',
      edgeId: 'breaker->payments',
    });
    expect(engine.activeDuplicates()).toEqual([]);
    expect(statuses()).toHaveLength(1);

    // Each press is an undo entry that puts the cable back as it was.
    expect(entries.map((e) => e.target)).toEqual(['dup', 'dup']);
    const last = entries[1];
    if (!last) throw new Error('no entry');
    applyFaultChange(engine, last, 'undo', now, () => {});
    expect(engine.activeDuplicates().map((d) => d.rate)).toEqual([0.25]);
  });

  it('is not offered on a controller cable, which carries no requests', () => {
    mount('autoscaling-service');
    press(hit('scaler->api'));
    expect(button('Cut cable')).toBeDefined();
    expect(button('Duplicate')).toBeUndefined();
    press(hit('api->db'));
    expect(button('Duplicate')).toBeDefined();
  });
});
