// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { Inspector } from './Inspector';
import { DEFAULT_PAUSE_MS, faultActionsFor, faultViewFor } from './faultWiring';
import { applyFaultChange, undoableFaultActions } from './faultUndo';
import type { FaultChange } from './faultUndo';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';

/**
 * Stall and Cut answers only, driven the way a student drives them: select
 * a part or a cable on the canvas with a real pointer sequence, press the
 * button, and read the result back from the engine and the inspector.
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
let refresh: () => void = () => {};

function Harness({ engine, topology }: { engine: Engine; topology: Topology }) {
  const [snapshot, setSnapshot] = useState<SimSnapshot>(() => engine.snapshot());
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set());
  // Lets a test show a moment it advanced the engine to by hand.
  useEffect(() => {
    refresh = () => setSnapshot(engine.snapshot());
  }, [engine]);
  const nodes = topology.nodes.filter((n) => sel.has(n.id));
  const node = nodes.length === 1 ? (nodes[0] ?? null) : null;
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
      node,
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

function mount(): { engine: Engine; topology: Topology } {
  const preset = PRESETS.find((p) => p.id === 'circuit-breaker');
  if (!preset) throw new Error('circuit-breaker preset missing');
  const engine = new Engine(preset.topology);
  // Two seconds in, so recorded entries carry a time that is not zero.
  for (let i = 0; i < 20; i++) engine.advance(100);
  act(() => root.render(<Harness engine={engine} topology={preset.topology} />));
  return { engine, topology: preset.topology };
}

function hit(kind: 'node' | 'edge', id: string): Element {
  const el = container.querySelector(`[data-hit="${kind}"][data-id="${id}"]`);
  if (!el) throw new Error(`no ${kind} hit for ${id}`);
  return el;
}

function button(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.ins button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
  );
}

function statuses(): string[] {
  return [...container.querySelectorAll('.ins-fault-status')].map(
    (p) => p.textContent ?? '',
  );
}

describe('Stall, on a selected part', () => {
  it('records a pause of the chosen length, says so, and it ends by itself', () => {
    entries.length = 0;
    const { engine } = mount();
    press(hit('node', 'payments'));
    const select = container.querySelector<HTMLSelectElement>('select[id$="-pause"]');
    if (!select) throw new Error('no Stall for select');
    expect(Number(select.value)).toBe(DEFAULT_PAUSE_MS);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      '0.2s',
      '0.5s',
      '1s',
      '2s',
      '5s',
    ]);
    act(() => {
      select.value = '1000';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const pause = button('Stall');
    if (!pause) throw new Error('no Stall button');
    const now = engine.snapshot().system.timeMs;
    press(pause);
    expect(engine.faultSchedule()).toEqual([
      {
        atMs: now,
        action: 'inject',
        nodeId: 'payments',
        kind: 'pause',
        opts: { pauseMs: 1000 },
      },
    ]);
    expect(statuses()[0]).toBe(
      "Stalled since 2.0s, until 3.0s. It keeps its work but does none of it, and new requests wait at the door. Callers' timeouts keep running, so they may give up and send the same request again.",
    );
    // A second press while paused changes nothing.
    expect(pause.getAttribute('aria-disabled')).toBe('true');
    press(pause);
    expect(engine.faultSchedule()).toHaveLength(1);
    expect(entries.map((e) => e.target)).toEqual(['node']);

    for (let i = 0; i < 11; i++) engine.advance(100);
    act(() => refresh());
    expect(engine.activeFailures()).toEqual([]);
    expect(statuses()[0]).toBe('Working normally.');
  });

  it('undoes a pause by letting it carry on now', () => {
    entries.length = 0;
    const { engine } = mount();
    press(hit('node', 'payments'));
    const pause = button('Stall');
    if (!pause) throw new Error('no Stall button');
    press(pause);
    engine.advance(100);
    const entry = entries[0];
    if (!entry) throw new Error('no entry');
    applyFaultChange(engine, entry, 'undo', engine.now, () => {});
    expect(engine.activeFailures()).toEqual([]);
    expect(engine.faultSchedule().map((f) => f.action)).toEqual(['inject', 'clear']);
  });

  it('is not offered on the client, which serves nothing', () => {
    mount();
    press(hit('node', 'client'));
    expect(button('Crash')).toBeDefined();
    expect(button('Stall')).toBeUndefined();
  });
});

describe('Cut answers only, on a selected cable', () => {
  it('loses the answers, says so, and Let answers back stops it', () => {
    entries.length = 0;
    const { engine } = mount();
    press(hit('edge', 'breaker->payments'));
    const cut = button('Cut answers only');
    if (!cut) throw new Error('no Cut answers only button');
    const now = engine.snapshot().system.timeMs;
    press(cut);
    expect(engine.faultSchedule()).toEqual([
      { atMs: now, action: 'cut-replies', edgeId: 'breaker->payments' },
    ]);
    expect(statuses()[1]).toMatch(
      /^Losing every answer back across it since 2\.0s, 0 answers so far\. Requests still get through and do their work\. The caller /,
    );
    // The cable itself still carries requests.
    expect(statuses()[0]).toBe('Requests get through.');
    expect(button('Cut answers only')).toBeUndefined();

    const back = button('Let answers back');
    if (!back) throw new Error('no Let answers back button');
    press(back);
    expect(engine.faultSchedule().at(-1)).toEqual({
      atMs: now,
      action: 'restore-replies',
      edgeId: 'breaker->payments',
    });
    expect(engine.activeReplyCuts()).toEqual([]);
    // The breaker has no timeout, so what it was waiting on is still lost.
    // Advance so it has answers to lose, cut and restore again, and read.
    press(button('Cut answers only') as HTMLButtonElement);
    for (let i = 0; i < 10; i++) engine.advance(100);
    act(() => refresh());
    press(button('Let answers back') as HTMLButtonElement);
    const waiting = engine.strandedReplies()[0]?.waiting ?? 0;
    expect(waiting).toBeGreaterThan(0);
    expect(statuses()).toEqual([
      'Requests get through.',
      `Answers get through again, but ${waiting} calls are still waiting for answers it lost. The caller has no timeout, so they wait for good and each keeps a slot. Crash and fix the caller, or Reset, to free them.`,
    ]);
    // Undo below works on the first restore.
    entries.splice(2);

    expect(entries.map((e) => e.target)).toEqual(['replies', 'replies']);
    const last = entries[1];
    if (!last) throw new Error('no entry');
    applyFaultChange(engine, last, 'undo', now, () => {});
    expect(engine.activeReplyCuts().map((r) => r.edgeId)).toEqual([
      'breaker->payments',
    ]);
  });

  it('keeps its status lines mounted, so a screen reader hears them change', () => {
    mount();
    press(hit('edge', 'breaker->payments'));
    const live = () =>
      [...container.querySelectorAll('.ins [role="status"]')].map((p) => p.textContent);
    const before = container.querySelectorAll('.ins [role="status"]');
    expect(live()).toEqual(['Connected.', '', '']);
    press(button('Cut answers only') as HTMLButtonElement);
    const after = container.querySelectorAll('.ins [role="status"]');
    // The same three elements, with only their words changed.
    expect([...after]).toEqual([...before]);
    expect(live()[2]).toMatch(/^Losing every answer back/);
  });

  it('is not offered on a controller cable, which carries no requests', () => {
    const preset = PRESETS.find((p) => p.id === 'autoscaling-service');
    if (!preset) throw new Error('autoscaling-service preset missing');
    const engine = new Engine(preset.topology);
    act(() => root.render(<Harness engine={engine} topology={preset.topology} />));
    press(hit('edge', 'scaler->api'));
    expect(button('Cut cable')).toBeDefined();
    expect(button('Cut answers only')).toBeUndefined();
  });
});

describe('cable faults from a part, without selecting the cable', () => {
  it('duplicates and cuts answers from the cable list, and stops them again', () => {
    entries.length = 0;
    const { engine } = mount();
    press(hit('node', 'payments'));
    const dup = button('Duplicate 5% of requests from Circuit Breaker');
    if (!dup) throw new Error('no Duplicate in the cable list');
    // A real button, so Tab reaches it.
    expect(dup.tagName).toBe('BUTTON');
    const now = engine.snapshot().system.timeMs;
    press(dup);
    expect(engine.faultSchedule()).toEqual([
      { atMs: now, action: 'duplicate', edgeId: 'breaker->payments', rate: 0.05 },
    ]);
    const once = button('Deliver once from Circuit Breaker');
    if (!once) throw new Error('no Deliver once in the cable list');
    press(once);
    expect(engine.activeDuplicates()).toEqual([]);

    const cut = button('Cut answers only from Circuit Breaker');
    if (!cut) throw new Error('no Cut answers in the cable list');
    press(cut);
    expect(engine.activeReplyCuts().map((r) => r.edgeId)).toEqual([
      'breaker->payments',
    ]);
    press(button('Let answers back from Circuit Breaker') as HTMLButtonElement);
    expect(engine.activeReplyCuts()).toEqual([]);
    expect(engine.faultSchedule().map((f) => f.action)).toEqual([
      'duplicate',
      'undup',
      'cut-replies',
      'restore-replies',
    ]);
    expect(entries.map((e) => e.target)).toEqual(['dup', 'dup', 'replies', 'replies']);
  });

  it('offers only Cut cable on a controller cable', () => {
    const preset = PRESETS.find((p) => p.id === 'autoscaling-service');
    if (!preset) throw new Error('autoscaling-service preset missing');
    const engine = new Engine(preset.topology);
    act(() => root.render(<Harness engine={engine} topology={preset.topology} />));
    press(hit('node', 'api'));
    const row = [...container.querySelectorAll('.ins-fault-cable')].find((li) =>
      li.textContent?.startsWith('From Autoscaler'),
    );
    if (!row) throw new Error('no autoscaler cable row');
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Cut cable',
    ]);
  });
});
