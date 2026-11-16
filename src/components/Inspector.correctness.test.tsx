// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { takesCorrectness } from '../sim/behaviour';
import { makeNode } from '../sim/presets';
import { WIRE_KINDS, WIRE_SCHEMA } from '../share/wire';
import type { NodeConfig, NodeKind, SimNode } from '../sim/types';

/**
 * The correctness settings: shown where a call finishes its work, written
 * as 1 when on and removed when off, so a design that never used them
 * saves and shares exactly as before.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function show(kind: NodeKind, patch: Partial<NodeConfig> = {}) {
  const n: SimNode = { ...makeNode(kind, 0, 0), id: 'x' };
  const node = { ...n, config: { ...n.config, ...patch } };
  const onChange = vi.fn();
  act(() =>
    root.render(
      <Inspector
        node={node}
        stats={null}
        onChange={onChange}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
  return onChange;
}

function box(text: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label.ins-toggle')].find((l) =>
    l.textContent?.includes(text),
  );
  return label?.querySelector('input') ?? null;
}

describe('Inspector: correctness', () => {
  it('turns idempotency keys and charging on as 1 and off by removing them', () => {
    const onChange = show('service');
    const keys = box('Ignore repeats with an idempotency key');
    const charges = box('Each finished call charges money');
    if (!keys || !charges) throw new Error('no correctness settings');
    expect(keys.checked).toBe(false);
    act(() => keys.click());
    expect(onChange).toHaveBeenLastCalledWith('x', { idempotencyKeys: 1 });
    act(() => charges.click());
    expect(onChange).toHaveBeenLastCalledWith('x', { chargeable: 1 });

    const off = show('service', { idempotencyKeys: 1 });
    const on = box('Ignore repeats with an idempotency key');
    expect(on?.checked).toBe(true);
    act(() => on?.click());
    expect(off).toHaveBeenLastCalledWith('x', { idempotencyKeys: undefined });
    expect(on?.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('is offered only where a call finishes its work', () => {
    show('client');
    expect(box('Each finished call charges money')).toBeNull();
    show('writebehind');
    expect(box('Each finished call charges money')).toBeNull();
    show('db');
    expect(box('Each finished call charges money')).not.toBeNull();
  });

  it('only offers settings a share link can carry', () => {
    for (const kind of WIRE_KINDS) {
      if (!takesCorrectness(kind)) continue;
      expect(WIRE_SCHEMA[kind]).toContain('chargeable');
      expect(WIRE_SCHEMA[kind]).toContain('idempotencyKeys');
    }
  });
});
