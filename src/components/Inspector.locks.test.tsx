// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector, TrafficControl } from './Inspector';
import { makeNode } from '../sim/presets';
import { lockedFieldsFor } from '../sim/challenge';
import { CHALLENGES } from '../sim/challenges';
import type { NodeKind, NodeStats, SimNode } from '../sim/types';

/**
 * What a brief holds still, in the panel. Each field a brief fixes is shown
 * and shown to be fixed, on one node and on a selection of many, and the
 * suggested fix stays out of the way while a brief is open.
 */

const brief = CHALLENGES[0]!;
const locks = (kind: NodeKind) => lockedFieldsFor(brief, kind);

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

/** The control a visible label names. */
function control(label: string): HTMLInputElement | null {
  const el = [...container.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === label,
  );
  const id = el?.getAttribute('for');
  return id
    ? (container.querySelector(`#${CSS.escape(id)}`) as HTMLInputElement)
    : null;
}

function node(kind: NodeKind, id: string): SimNode {
  return { ...makeNode(kind, 0, 0), id };
}

/** Past every default ceiling, so a node with one is the bottleneck. */
function overloaded(): NodeStats {
  return {
    inFlight: 1,
    queued: 0,
    throughput: 2_000_000,
    arrivalRate: 2_000_000,
    utilization: 0.99,
    errorRate: 0,
    shedRate: 0,
    timeoutRate: 0,
    hitRate: 0.8,
    totalCompleted: 0,
    totalFailed: 0,
    p50: 10,
    p95: 20,
    p99: 30,
    queueLimit: 256,
    staleReadRate: 0,
    maxShardUtilization: 0,
    minShardUtilization: 0,
    shardUtilization: [],
  };
}

describe('during a challenge', () => {
  it('holds the work still on a database and leaves its slots to the reader', () => {
    act(() =>
      root.render(
        <Inspector
          node={node('db', 'db')}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          lockedFields={locks}
        />,
      ),
    );
    expect(control('Slots per instance')?.disabled).toBe(false);
    const fixed = container.querySelector('.is-locked');
    expect(fixed).not.toBeNull();
    expect(fixed?.querySelector('input')?.disabled).toBe(true);
    expect(fixed?.textContent).toContain('it describes the work, not your design');
  });

  it('holds a client still, and says it is the people sending requests', () => {
    act(() =>
      root.render(
        <Inspector
          node={node('client', 'c')}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          lockedFields={locks}
        />,
      ),
    );
    const rows = [...container.querySelectorAll('.is-locked')];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.querySelector('input')?.disabled).toBe(true);
      expect(row.textContent).toContain('how the people sending requests behave');
    }
  });

  it('leaves a server retries and timeout to the reader', () => {
    act(() =>
      root.render(
        <Inspector
          node={node('service', 's')}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          lockedFields={locks}
        />,
      ),
    );
    expect(control('Retries')?.disabled).toBe(false);
    expect(control('Timeout')?.disabled).toBe(false);
    expect(container.querySelector('.is-locked')).not.toBeNull();
  });

  it('holds the same fields on a selection of many', () => {
    const lockedLabels = () =>
      [...container.querySelectorAll('.is-locked label')].map((l) => l.textContent);
    act(() =>
      root.render(
        <Inspector
          node={node('db', 'a')}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          lockedFields={locks}
        />,
      ),
    );
    const single = lockedLabels();
    act(() =>
      root.render(
        <Inspector
          node={null}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          selectedNodes={[node('db', 'a'), node('db', 'b')]}
          onChangeMany={() => {}}
          lockedFields={locks}
        />,
      ),
    );
    expect(single.length).toBeGreaterThan(0);
    expect(lockedLabels()).toEqual(single);
    for (const row of container.querySelectorAll('.is-locked')) {
      expect(row.querySelector('input')?.disabled).toBe(true);
    }
    expect(control('Slots per instance')?.disabled).toBe(false);
  });

  it('offers no suggested fix, which would be the answer', () => {
    const render = (suggestions: boolean) =>
      act(() =>
        root.render(
          <Inspector
            node={node('db', 'db')}
            stats={overloaded()}
            onChange={() => {}}
            onDelete={() => {}}
            onRename={() => {}}
            lockedFields={locks}
            suggestions={suggestions}
          />,
        ),
      );
    // The same overloaded database outside a brief does get one, so its
    // absence below is the flag and not the numbers.
    render(true);
    expect(container.querySelector('.ins-suggestion')).not.toBeNull();
    render(false);
    expect(container.querySelector('.ins-suggestion')).toBeNull();
  });

  it('holds the load slider still and says why', () => {
    act(() =>
      root.render(
        <TrafficControl
          rps={200}
          onRpsChange={() => {}}
          running
          onToggleRun={() => {}}
          onStep={() => {}}
          onReset={() => {}}
          system={{
            timeMs: 0,
            offeredRps: 200,
            goodputRps: 200,
            errorRate: 0,
            p50: 1,
            p95: 1,
            p99: 1,
            totalRequests: 0,
            totalFailed: 0,
          }}
          lost={0}
          empty={false}
          noTrafficSource={false}
          locked
        />,
      ),
    );
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(slider.disabled).toBe(true);
    const note = document.getElementById(slider.getAttribute('aria-describedby')!);
    expect(note?.textContent).toBe('Set by the challenge you are in.');
  });
});
