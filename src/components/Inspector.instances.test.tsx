// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { makeNode } from '../sim/presets';
import type { NodeKind } from '../sim/types';

/**
 * The inspector only renders fields that belong to one of its groups, so a
 * field listed for a kind but left out of every group is silently dropped.
 * `instances` was, which left scaling out unreachable from the panel even
 * though the engine, the canvas badge and the autoscaler all honour it.
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

function fieldLabels(kind: NodeKind): string[] {
  act(() =>
    root.render(
      <Inspector
        node={makeNode(kind, 0, 0)}
        stats={null}
        onChange={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
      />,
    ),
  );
  return [...container.querySelectorAll('label')].map(
    (l) => l.textContent?.trim() ?? '',
  );
}

describe('the instances field in the inspector', () => {
  it.each<NodeKind>(['service', 'db', 'cache', 'lb', 'worker'])(
    'is editable on a %s',
    (kind) => {
      expect(fieldLabels(kind)).toContain('Instances');
    },
  );
});
