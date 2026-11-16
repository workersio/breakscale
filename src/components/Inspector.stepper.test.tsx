// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { splitHint } from './splitHint';
import { makeNode } from '../sim/presets';
import type { SimNode } from '../sim/types';

/**
 * Number fields are steppers: minus and plus, ArrowUp and ArrowDown with
 * Shift for ten steps, and a label that scrubs when dragged sideways.
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

function db(instances: number): SimNode {
  const node = { ...makeNode('db', 200, 0), id: 'db' };
  node.config = { ...node.config, instances, capacity: 12 };
  return node;
}

function render(node: SimNode) {
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

function label(text: string): HTMLLabelElement {
  const el = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === text,
  );
  if (!el) throw new Error(`no label ${text}`);
  return el;
}

function input(text: string): HTMLInputElement {
  const id = label(text).getAttribute('for') ?? '';
  return container.querySelector(`#${CSS.escape(id)}`) as HTMLInputElement;
}

function key(el: Element, k: string, shiftKey = false): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  });
}

describe('number steppers', () => {
  it('steps with the minus and plus buttons', () => {
    const onChange = render(db(3));
    const plus = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Increase Instances"]',
    );
    const minus = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Decrease Instances"]',
    );
    act(() => plus?.click());
    act(() => minus?.click());
    expect(onChange.mock.calls).toEqual([
      ['db', { instances: 4 }],
      ['db', { instances: 2 }],
    ]);
  });

  it('will not step below the minimum', () => {
    render(db(1));
    const minus = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Decrease Instances"]',
    );
    expect(minus?.disabled).toBe(true);
  });

  it('steps on ArrowUp and ArrowDown, and by ten with Shift', () => {
    const onChange = render(db(3));
    const box = input('Instances');
    key(box, 'ArrowUp');
    key(box, 'ArrowDown');
    key(box, 'ArrowUp', true);
    key(box, 'ArrowDown', true);
    expect(onChange.mock.calls.map((c) => c[1])).toEqual([
      { instances: 4 },
      { instances: 2 },
      { instances: 13 },
      { instances: 1 },
    ]);
  });

  it('scrubs when the label is dragged sideways, and does not focus the box', () => {
    const onChange = render(db(3));
    const l = label('Instances');
    const at = (x: number) => ({ bubbles: true, button: 0, clientX: x, clientY: 10 });
    act(() => {
      l.dispatchEvent(new FakePointerEvent('pointerdown', at(100)));
      l.dispatchEvent(new FakePointerEvent('pointermove', at(108)));
      l.dispatchEvent(new FakePointerEvent('pointermove', at(112)));
      l.dispatchEvent(new FakePointerEvent('pointerup', at(112)));
      l.dispatchEvent(new MouseEvent('click', at(112)));
    });
    expect(onChange.mock.calls.map((c) => c[1])).toEqual([
      { instances: 5 },
      { instances: 6 },
    ]);
    expect(document.activeElement).not.toBe(input('Instances'));
  });

  it('still takes a typed number', () => {
    const onChange = render(db(3));
    const box = input('Instances');
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      set?.call(box, '7');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith('db', { instances: 7 });
  });
});

describe('hint lines', () => {
  it('shows the first sentence and keeps the rest for hover', () => {
    expect(splitHint('One. Two and three.')).toEqual(['One.', 'Two and three.']);
    expect(splitHint('About 1.6% each.')).toEqual(['About 1.6% each.', '']);
  });
});
