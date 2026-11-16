// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { NodeConfig, NodeStats, SimNode } from '../sim/types';

/**
 * "Read from the primary while the copies are behind", pressed the way a
 * student presses it, and the share of reads it moves read back from the
 * engine.
 */

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

function replicaSet(config: Partial<NodeConfig> = {}): SimNode {
  const p = PRESETS.find((x) => x.id === 'read-replicas');
  const n = p?.topology.nodes.find((x) => x.kind === 'replica');
  if (!p || !n) throw new Error('no replica set');
  return { ...n, config: { ...n.config, ...config } };
}

function statsWith(node: SimNode): NodeStats {
  const p = PRESETS.find((x) => x.id === 'read-replicas');
  if (!p) throw new Error('no preset');
  const t = {
    ...p.topology,
    nodes: p.topology.nodes.map((n) => (n.id === node.id ? node : n)),
  };
  const e = new Engine(t, 1);
  for (let i = 0; i < 600; i++) e.advance(1000 / 60);
  const s = e.snapshot().nodes[node.id];
  if (!s) throw new Error('no stats');
  return s;
}

function render(node: SimNode, onChange: (id: string, c: Partial<NodeConfig>) => void) {
  act(() =>
    root.render(
      <Inspector
        node={node}
        stats={statsWith(node)}
        onChange={onChange}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
}

const toggle = () =>
  [...container.querySelectorAll('.ins-toggle')].find((l) =>
    l.textContent?.includes('Read from the primary'),
  );

describe('read from the primary while the copies are behind', () => {
  it('turns on with a press, and off again', () => {
    const onChange = vi.fn();
    render(replicaSet(), onChange);
    const box = toggle()?.querySelector('input');
    if (!box) throw new Error('no toggle');
    expect(box.checked).toBe(false);
    press(box);
    expect(onChange).toHaveBeenLastCalledWith('replicas', { freshReads: 1 });

    render(replicaSet({ freshReads: 1 }), onChange);
    const on = toggle()?.querySelector('input');
    expect(on?.checked).toBe(true);
    if (on) press(on);
    expect(onChange).toHaveBeenLastCalledWith('replicas', { freshReads: undefined });
  });

  it('shows the share of reads the primary took only while it is on', () => {
    render(replicaSet(), () => {});
    expect(container.textContent).not.toContain('Reads sent to the primary');
    render(replicaSet({ freshReads: 1 }), () => {});
    const row = [...container.querySelectorAll('.ins-stats > *')].find((r) =>
      r.textContent?.includes('Reads sent to the primary'),
    );
    expect(row?.textContent).toMatch(/Reads sent to the primary\s*\d+(\.\d+)?%/);
    expect(container.textContent).toMatch(/Reads served stale\s*0%/);
  });

  it('warns that the primary is the bottleneck only once a spike has held', () => {
    vi.useFakeTimers();
    try {
      const node = replicaSet({ freshReads: 1 });
      const base = statsWith(node);
      const warn = () =>
        container.querySelector('.ins-hint.is-warn')?.getAttribute('data-active');
      const show = (primary: number) =>
        act(() =>
          root.render(
            <Inspector
              node={node}
              stats={{ ...base, perInstance: [primary, 0.2, 0.2, 0.2] }}
              onChange={() => {}}
              onDelete={() => {}}
              onRename={() => {}}
            />,
          ),
        );
      // A primary at full load on one snapshot, idle on the next.
      show(1);
      expect(warn()).toBe('false');
      show(0);
      act(() => vi.advanceTimersByTime(2000));
      expect(warn()).toBe('false');
      // Full load that holds is a real bottleneck, and the words cover the reads.
      show(1);
      act(() => vi.advanceTimersByTime(1600));
      expect(warn()).toBe('true');
      expect(container.querySelector('.ins-hint.is-warn')?.textContent).toContain(
        'and so do the reads sent to it while the copies are behind.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('is offered on a replica set only', () => {
    const p = PRESETS.find((x) => x.id === 'single-server');
    const db = p?.topology.nodes.find((n) => n.kind === 'db');
    if (!db) throw new Error('no db');
    act(() =>
      root.render(
        <Inspector
          node={db}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
        />,
      ),
    );
    expect(toggle()).toBeUndefined();
  });
});
