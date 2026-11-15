// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Inspector } from './Inspector';
import { faultActionsFor, faultViewFor } from './faultWiring';
import { Engine } from '../sim/engine';
import { defaultConfig } from '../sim/presets';
import type { NodeConfig, SimSnapshot, Topology } from '../sim/types';

/**
 * Restart and "Writes reach disk", driven the way a student drives them:
 * select the database on the canvas with a real pointer sequence, pick in
 * the inspector, and read the result back from the engine.
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

function design(db: Partial<NodeConfig>): Topology {
  const node = (id: string, kind: 'client' | 'service' | 'db', x: number) => ({
    id,
    kind,
    label: id === 'db' ? 'Orders DB' : id,
    x,
    y: 0,
    config: { ...defaultConfig(kind), ...(id === 'db' ? db : {}) },
  });
  return {
    nodes: [
      node('client', 'client', 0),
      node('api', 'service', 240),
      node('db', 'db', 480),
    ],
    edges: [
      { id: 'client->api', from: 'client', to: 'api', weight: 1 },
      { id: 'api->db', from: 'api', to: 'db', weight: 1 },
    ],
  };
}

/** The shell's wiring: an edit updates the engine and the design on screen. */
function Harness({ engine, start }: { engine: Engine; start: Topology }) {
  const [topology, setTopology] = useState(start);
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
        onChange={(id, patch) => {
          engine.updateNodeConfig(id, patch);
          setTopology((t) => ({
            ...t,
            nodes: t.nodes.map((n) =>
              n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
            ),
          }));
        }}
        onDelete={() => {}}
        onRename={() => {}}
        selectedNodes={nodes}
        selectedEdgeCount={sel.size - nodes.length}
        faults={faults}
      />
      <button
        type="button"
        data-testid="tick"
        onClick={() => setSnapshot(engine.snapshot())}
      />
    </>
  );
}

function mount(db: Partial<NodeConfig>): Engine {
  const engine = new Engine(design(db), 1);
  for (let i = 0; i < 20; i++) engine.advance(100);
  act(() => root.render(<Harness engine={engine} start={design(db)} />));
  const hit = container.querySelector('[data-hit="node"][data-id="db"]');
  if (!hit) throw new Error('no db on the canvas');
  press(hit);
  return engine;
}

function control(label: string): HTMLSelectElement {
  const el = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === label,
  );
  const id = el?.getAttribute('for');
  const select = id ? document.getElementById(id) : null;
  if (!(select instanceof HTMLSelectElement)) throw new Error(`no select "${label}"`);
  return select;
}

function pick(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('.ins button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

function stat(label: string): string | null {
  const row = [...container.querySelectorAll('.ins-stat')].find(
    (r) => r.querySelector('.row-k')?.textContent === label,
  );
  return row?.querySelector('.row-v')?.textContent ?? null;
}

describe('Writes reach disk', () => {
  it('sets flushEveryMs, and Before it answers removes it', () => {
    const engine = mount({});
    const flush = control('Writes reach disk');
    expect(flush.selectedOptions[0]?.textContent).toBe('Before it answers');
    pick(flush, '1000');
    expect(
      engine.exportTopology().nodes.find((n) => n.id === 'db')?.config.flushEveryMs,
    ).toBe(1000);
    expect(control('Writes reach disk').selectedOptions[0]?.textContent).toBe(
      'Within 1s',
    );
    const hint = document.getElementById(flush.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(
      'It answers before the write is on disk, and writes it there within 1s. A crash or restart loses every write still waiting.',
    );
    pick(control('Writes reach disk'), '0');
    expect(
      engine.exportTopology().nodes.find((n) => n.id === 'db')?.config.flushEveryMs,
    ).toBeUndefined();
  });
});

describe('Restart', () => {
  it('records a restart with the chosen time down, then shows what it lost', () => {
    const engine = mount({ flushEveryMs: 1000 });
    const hint = document.getElementById(
      button('Restart').getAttribute('aria-describedby') ?? '',
    );
    expect(hint?.textContent).toBe(
      'Stops it, then it starts again by itself. Work in progress is lost. So are the writes it said were saved but had not written to disk yet.',
    );
    pick(control('Down for'), '5000');
    press(button('Restart'));
    expect(engine.faultSchedule()).toEqual([
      {
        atMs: 2000,
        action: 'inject',
        nodeId: 'db',
        kind: 'restart',
        opts: { downMs: 5000 },
      },
    ]);
    expect(container.querySelector('.ins-fault-status')?.textContent).toBe(
      'Restarting since 2.0s. Every request sent to it fails until it is back at 7.0s.',
    );
    expect(button('Restart').getAttribute('aria-disabled')).toBe('true');
    const lost = engine.snapshot().nodes.db.lostInLastCrash ?? 0;
    expect(lost).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) engine.advance(100);
    press(container.querySelector('[data-testid="tick"]') as Element);
    expect(engine.activeFailures()).toEqual([]);
    expect(stat('Lost when it last went down')).toBe(String(lost));
    expect(stat('Not on disk yet')).not.toBeNull();
  });

  it('says nothing more is lost where a store saves before it answers', () => {
    mount({});
    const hint = document.getElementById(
      button('Restart').getAttribute('aria-describedby') ?? '',
    );
    expect(hint?.textContent).toBe(
      'Stops it, then it starts again by itself. Work in progress is lost.',
    );
    expect(stat('Not on disk yet')).toBeNull();
  });
});
