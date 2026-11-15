// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { lockedFieldsFor } from '../sim/challenge';
import { CHALLENGES } from '../sim/challenges';
import { makeNode } from '../sim/presets';
import type { NodeConfig, NodeStats, SimNode } from '../sim/types';

/**
 * The client's key spread slider and the store's hottest-key reading. jsdom
 * does not move a range thumb from pointer events, so the drag is the real
 * pointer sequence around the value change a browser would make between them.
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
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function field(label: string): HTMLElement {
  const el = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === label,
  );
  const row = el?.closest('.ins-field');
  if (!(row instanceof HTMLElement)) throw new Error(`no field ${label}`);
  return row;
}

function drag(input: HTMLInputElement, to: number): void {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    setValue?.call(input, String(to));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
}

function client(config: Partial<NodeConfig> = {}): SimNode {
  const n = { ...makeNode('client', 0, 0), id: 'c' };
  return { ...n, config: { ...n.config, ...config } };
}

function render(node: SimNode, onChange = () => {}, stats: NodeStats | null = null) {
  act(() =>
    root.render(
      <Inspector
        node={node}
        stats={stats}
        onChange={onChange}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
}

function shardStats(share?: number): NodeStats {
  return {
    inFlight: 0,
    queued: 0,
    throughput: 700,
    arrivalRate: 768,
    utilization: 0.58,
    errorRate: 0.11,
    shedRate: 0,
    timeoutRate: 0,
    hitRate: 0,
    totalCompleted: 0,
    totalFailed: 0,
    p50: 10,
    p95: 20,
    p99: 30,
    queueLimit: 256,
    staleReadRate: 0,
    maxShardUtilization: 1,
    minShardUtilization: 0.37,
    shardUtilization: [1, 0.79, 0.66, 0.48, 0.42, 0.46, 0.43, 0.37],
    perInstance: [1, 0.79, 0.66, 0.48, 0.42, 0.46, 0.43, 0.37],
    ...(share === undefined ? {} : { hottestKeyShare: share, hottestKeyShard: 0 }),
  };
}

describe('key spread', () => {
  it('starts even and says what even means', () => {
    render(client());
    const row = field('Key spread');
    expect(row.querySelector('.row-v')?.textContent).toBe('even');
    expect(row.textContent).toContain('Every one of the 64 keys is equally likely');
  });

  it('writes the skew a drag lands on', () => {
    const onChange = vi.fn();
    render(client(), onChange);
    const input = field('Key spread').querySelector('input') as HTMLInputElement;
    drag(input, 1);
    expect(onChange).toHaveBeenLastCalledWith('c', { keySkew: 1 });
  });

  it('states the hottest key share for the skew it is at', () => {
    render(client({ keySkew: 1 }));
    const row = field('Key spread');
    expect(row.querySelector('.row-v')?.textContent).toBe('skew 1.0');
    expect(row.textContent).toContain(
      'The hottest of the 64 keys gets 21% of requests',
    );
  });

  it('is held still during a challenge', () => {
    act(() =>
      root.render(
        <Inspector
          node={client()}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          lockedFields={(kind) => lockedFieldsFor(CHALLENGES[0]!, kind)}
        />,
      ),
    );
    const input = field('Key spread').querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});

describe('hottest key on a sharded store', () => {
  const shard = { ...makeNode('shard', 0, 0), id: 's' };

  it('shows nothing when keys are not skewed', () => {
    render(shard, () => {}, shardStats());
    expect(container.textContent).not.toContain('Hottest key');
  });

  it('shows the measured share and where it lands', () => {
    render(shard, () => {}, shardStats(0.22));
    expect(container.textContent).toContain('Hottest key');
    expect(container.textContent).toContain(
      'One key is 22% of the requests here, and all of them go to partition 1.',
    );
  });
});
