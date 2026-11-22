// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Inspector } from './Inspector';
import { listParts, loopsOf } from './loops';
import { formatCount } from './format';
import { Engine } from '../sim/engine';
import { PRESETS, defaultConfig } from '../sim/presets';
import { Timeline } from '../learn/timeline';
import type { NodeConfig, NodeKind, SimNode, Topology } from '../sim/types';

/**
 * Saying so when a design has a loop (#128, #129). The engine stops each
 * request that goes round; these check the student is told where, in the
 * Inspector and in What just happened, from real engine runs.
 */

function node(id: string, kind: NodeKind, patch: Partial<NodeConfig> = {}): SimNode {
  return {
    id,
    kind,
    label: id,
    x: 0,
    y: 0,
    config: { ...defaultConfig(kind), ...patch },
  };
}

function wire(
  nodes: SimNode[],
  pairs: readonly (readonly [string, string])[],
): Topology {
  return {
    nodes,
    edges: pairs.map(([from, to], i) => ({ id: `e${i}`, from, to, weight: 1 })),
  };
}

const TOPIC_LOOP = wire(
  [
    { ...node('n0', 'client', { rps: 1159 }), label: 'Client' },
    { ...node('n1', 'pubsub'), label: 'Pub/Sub Topic' },
  ],
  [
    ['n0', 'n1'],
    ['n1', 'n0'],
  ],
);

const DIAMOND = wire(
  [
    { ...node('a', 'client', { rps: 5 }), label: 'Web' },
    { ...node('b', 'client', { rps: 0 }), label: 'Mobile' },
    { ...node('c', 'client', { rps: 0 }), label: 'Partner' },
  ],
  [
    ['a', 'b'],
    ['b', 'a'],
    ['a', 'c'],
    ['c', 'a'],
  ],
);

describe('loopsOf', () => {
  it('finds no loop in any example', () => {
    for (const p of PRESETS) expect(loopsOf(p.topology), p.id).toEqual([]);
  });

  it('finds a loop through a topic, and one part wired to itself', () => {
    expect(loopsOf(TOPIC_LOOP)).toEqual([['n0', 'n1']]);
    const self = wire(
      [node('x', 'service'), node('y', 'db')],
      [
        ['x', 'x'],
        ['x', 'y'],
      ],
    );
    expect(loopsOf(self)).toEqual([['x']]);
  });

  it('follows a long chain without running out of stack', () => {
    const n = 20_000;
    const nodes = Array.from({ length: n }, (_, i) => node(`s${i}`, 'service'));
    const pairs = Array.from(
      { length: n },
      (_, i) => [`s${i}`, `s${(i + 1) % n}`] as const,
    );
    expect(loopsOf(wire(nodes, pairs))[0]?.length).toBe(n);
  });

  it('names the parts on a loop in plain words', () => {
    expect(listParts(['A'])).toBe('A');
    expect(listParts(['A', 'B'])).toBe('A and B');
    expect(listParts(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listParts(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 more parts');
  });
});

function timelineLines(t: Topology, seconds: number): string[] {
  const engine = new Engine(t, 1);
  const tl = new Timeline();
  for (let ms = 0; ms <= seconds * 1000; ms += 100) {
    if (ms > 0) engine.advance(100);
    tl.observe(t, engine.snapshot());
  }
  return tl.events().map((e) => e.text);
}

describe('What just happened', () => {
  it('says once that requests go round a topic loop', () => {
    const lines = timelineLines(TOPIC_LOOP, 3).filter((l) => l.includes('loop'));
    console.log(lines);
    expect(lines).toEqual([
      'Requests are going round in a loop between Client and Pub/Sub Topic. Each one is stopped after at most 32 hops and counted as failed.',
    ]);
  });

  it('names every part of a loop of clients', () => {
    const lines = timelineLines(DIAMOND, 3).filter((l) => l.includes('loop'));
    expect(lines).toEqual([
      'Requests are going round in a loop between Web, Mobile and Partner. Each one is stopped after at most 32 hops and counted as failed.',
    ]);
  });

  it('says nothing about loops for an example', () => {
    for (const p of PRESETS.slice(0, 6)) {
      expect(
        timelineLines(p.topology, 2).some((l) => l.includes('loop')),
        p.id,
      ).toBe(false);
    }
  });
});

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

describe('the Inspector', () => {
  function show(loop?: { others: string[]; stopped: number }): void {
    act(() =>
      root.render(
        <Inspector
          node={{ ...node('n1', 'pubsub'), label: 'Pub/Sub Topic' }}
          stats={null}
          onChange={() => {}}
          onDelete={() => {}}
          onRename={() => {}}
          loop={loop}
        />,
      ),
    );
  }

  it('tells the student a part is on a loop, and how many calls it stopped', () => {
    show({ others: ['Client'], stopped: 2401 });
    expect(document.querySelector('.ins-loop')?.textContent).toBe(
      'Requests can come back to this part through Client. Each one is stopped after at most 32 hops and counted as failed.',
    );
    expect(document.body.textContent).toContain('Calls stopped here for looping');
    expect(document.body.textContent).toContain(formatCount(2401));
  });

  it('says a part wired to itself sends requests back to itself', () => {
    show({ others: [], stopped: 0 });
    expect(document.querySelector('.ins-loop')?.textContent).toContain(
      'This part sends requests back to itself',
    );
    expect(document.body.textContent).not.toContain('Calls stopped');
  });

  it('shows nothing for a part on no loop', () => {
    show();
    expect(document.querySelector('.ins-loop')).toBeNull();
    expect(document.body.textContent).not.toContain('In a loop');
  });
});
