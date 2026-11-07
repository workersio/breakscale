// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { faultActionsFor, faultViewFor } from './faultWiring';
import { Engine } from '../sim/engine';
import { makeNode } from '../sim/presets';
import type { SimNode, SimSnapshot, Topology } from '../sim/types';

/**
 * The fleet knobs and the fault that only a fleet has. `instances` and
 * `lockMs` were listed for their kinds but in no field group, so the panel
 * never drew them, and Crash one instance only means something on a node
 * with more than one machine.
 */

/** jsdom has no PointerEvent, so provide the parts the handlers read. */
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
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

function labelled(text: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === text,
  );
  const id = label?.getAttribute('for');
  return id
    ? (container.querySelector(`#${CSS.escape(id)}`) as HTMLInputElement)
    : null;
}

function button(name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name,
    ) ?? null
  );
}

function db(instances: number): SimNode {
  const node = { ...makeNode('db', 200, 0), id: 'db' };
  node.config = { ...node.config, instances, capacity: 12 };
  return node;
}

function Harness({ engine, topology }: { engine: Engine; topology: Topology }) {
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => engine.snapshot());
  const node = topology.nodes[1];
  const faults = {
    ...faultViewFor(engine, topology, snapshot, {
      node,
      nodeCount: 1,
      edgeCount: 0,
      ids: new Set([node.id]),
    }),
    ...faultActionsFor(engine, () => setSnapshot(engine.snapshot())),
  };
  return (
    <Inspector
      node={node}
      stats={snapshot.nodes[node.id] ?? null}
      onChange={() => {}}
      onDelete={() => {}}
      onRename={() => {}}
      faults={faults}
    />
  );
}

function mount(instances: number): Engine {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  client.config = { ...client.config, rps: 300 };
  const topology: Topology = {
    nodes: [client, db(instances)],
    edges: [{ id: 'client->db', from: 'client', to: 'db', weight: 1 }],
  };
  const engine = new Engine(topology, 1);
  for (let i = 0; i < 20; i++) engine.advance(100);
  act(() => root.render(<Harness engine={engine} topology={topology} />));
  return engine;
}

describe('the fleet in the inspector', () => {
  it('lets you set how many machines a database runs, and its lock wait', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Inspector
          node={db(3)}
          stats={null}
          onChange={onChange}
          onDelete={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    const instances = labelled('Instances');
    expect(instances?.value).toBe('3');
    expect(labelled('Lock wait per concurrent write')).not.toBeNull();
  });

  it('offers Crash one instance on a node with more than one machine', () => {
    const engine = mount(3);
    const crashOne = button('Crash one instance');
    if (!crashOne) throw new Error('no Crash one instance button');
    expect(crashOne.getAttribute('aria-disabled')).toBe('false');
    press(crashOne);
    expect(engine.faultSchedule()).toEqual([
      { atMs: 2000, action: 'inject', nodeId: 'db', kind: 'crash-instance' },
    ]);
    expect(container.textContent).toContain('One instance crashed at');
    expect(button('Crash one instance')?.getAttribute('aria-disabled')).toBe('true');
    // The ceiling counts the machines still up.
    expect(container.textContent).toContain('2 running instances x 12 slots');
  });

  it('does not offer it on a node with one machine, where it would be Crash', () => {
    mount(1);
    expect(button('Crash')).not.toBeNull();
    expect(button('Crash one instance')).toBeNull();
  });
});
