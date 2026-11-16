import { describe, expect, it } from 'vitest';
import type { SimSnapshot, Topology } from '../sim/types';
import { makeNode } from '../sim/presets';
import {
  TASK_START,
  advanceTask,
  figViews,
  type ExampleTask,
  type TaskProgress,
} from './exampleTask';

/* The evaluator on hand-built snapshots: only the fields a probe reads are
   filled in, so each case says exactly what it is about. */

function topo(rps: number, retries = 2): Topology {
  const client = makeNode('client', 0, 0);
  const api = makeNode('service', 200, 0);
  return {
    nodes: [
      { ...client, id: 'c', config: { ...client.config, rps } },
      { ...api, id: 'api', label: 'API Server', config: { ...api.config, retries } },
    ],
    edges: [],
  };
}

function snap(timeMs: number, errorRate: number, crashed = false): SimSnapshot {
  return {
    system: { timeMs, errorRate, p99: 120, goodputRps: 10 },
    nodes: {},
    activeFailures: crashed ? [{ nodeId: 'api', kind: 'crash', sinceMs: 0 }] : [],
  } as unknown as SimSnapshot;
}

const TASK: ExampleTask = {
  presetId: 'test',
  goal: 'Goal',
  learned: 'Learned',
  steps: [
    { text: 'Raise it', when: [{ probe: { of: 'load' }, atLeast: 100 }] },
    {
      text: 'Watch it fail',
      when: [{ probe: { of: 'failing' }, atLeast: 0.5 }],
      holdMs: 3000,
    },
    {
      text: 'Turn retries off',
      when: [
        { probe: { of: 'setting', node: 'api', field: 'retries' }, below: 1 },
        { probe: { of: 'failing' }, below: 0.01 },
      ],
    },
  ],
};

/** Feed snapshots every `stepMs` from `fromMs` for `ms`. */
function feed(
  task: ExampleTask,
  p: TaskProgress,
  t: Topology,
  fromMs: number,
  ms: number,
  err: number,
  stepMs = 100,
): TaskProgress {
  let out = p;
  for (let at = fromMs; at <= fromMs + ms; at += stepMs) {
    out = advanceTask(task, out, t, snap(at, err));
  }
  return out;
}

describe('advancing a task', () => {
  it('ticks a step that needs no hold on the snapshot it first holds in', () => {
    const p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    expect(p.step).toBe(1);
  });

  it('returns the same progress when nothing changed', () => {
    const p = advanceTask(TASK, TASK_START, topo(50), snap(500, 0));
    expect(advanceTask(TASK, p, topo(50), snap(500, 0))).toBe(p);
  });

  it('waits for a hold in simulated time, not in snapshots', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    p = feed(TASK, p, topo(100), 100, 2800, 0.9);
    expect(p.step).toBe(1);
    expect(p.heldMs).toBe(2800);
    p = feed(TASK, p, topo(100), 3000, 200, 0.9);
    expect(p.step).toBe(2);
  });

  it('starts a hold again when the condition lapses', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    p = feed(TASK, p, topo(100), 100, 2000, 0.9);
    p = advanceTask(TASK, p, topo(100), snap(2200, 0.1));
    expect(p.heldMs).toBe(0);
    p = feed(TASK, p, topo(100), 2300, 2000, 0.9);
    expect(p.step).toBe(1);
  });

  it('counts at most a second for one gap between snapshots', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    p = advanceTask(TASK, p, topo(100), snap(100, 0.9));
    p = advanceTask(TASK, p, topo(100), snap(60_000, 0.9));
    expect(p.step).toBe(1);
    expect(p.heldMs).toBe(1000);
  });

  it('reads a clock that went back as a new run, adding nothing', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(5000, 0));
    p = advanceTask(TASK, p, topo(100), snap(5100, 0.9));
    p = advanceTask(TASK, p, topo(100), snap(0, 0.9));
    expect(p.heldMs).toBe(0);
  });

  it('keeps a ticked step ticked when its reading goes away', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    p = advanceTask(TASK, p, topo(10), snap(100, 0));
    expect(p.step).toBe(1);
  });

  it('finishes, then stays finished', () => {
    let p = advanceTask(TASK, TASK_START, topo(100), snap(0, 0));
    p = feed(TASK, p, topo(100), 100, 3100, 0.9);
    p = advanceTask(TASK, p, topo(100, 0), snap(3300, 0));
    expect(p.step).toBe(3);
    expect(advanceTask(TASK, p, topo(100, 2), snap(3400, 1))).toBe(p);
  });

  it('skips an optional detour when the step after it ticks first', () => {
    const task: ExampleTask = {
      ...TASK,
      steps: [{ ...TASK.steps[1]!, holdMs: 0, optional: true }, TASK.steps[2]!],
    };
    const p = advanceTask(task, TASK_START, topo(100, 0), snap(0, 0));
    expect(p.step).toBe(2);
    expect(p.skipped).toEqual([0]);
  });

  it('reads a fault from the snapshot', () => {
    const task: ExampleTask = {
      ...TASK,
      steps: [
        {
          text: 'Crash it',
          when: [{ probe: { of: 'fault', node: 'api', kind: 'crash' }, atLeast: 1 }],
        },
      ],
    };
    expect(advanceTask(task, TASK_START, topo(100), snap(0, 0)).step).toBe(0);
    expect(advanceTask(task, TASK_START, topo(100), snap(0, 0, true)).step).toBe(1);
  });
});

describe('figures', () => {
  it('formats each with its unit and health, and leaves out what is missing', () => {
    const out = figViews(
      [
        { probe: { of: 'failing' }, label: 'failing' },
        { probe: { of: 'p99' }, label: 'p99' },
        { probe: { of: 'load' }, label: 'offered load' },
        { probe: { of: 'busy', node: 'gone' }, label: 'gone busy' },
      ],
      topo(560),
      snap(0, 0.22),
    );
    expect(out).toEqual([
      { label: 'failing', value: '22', unit: '%', health: 'danger' },
      { label: 'p99', value: '120', unit: 'ms', health: expect.any(String) },
      { label: 'offered load', value: '560', unit: '/s', health: 'ok' },
    ]);
  });
});

describe('a setting shown as a share', () => {
  it('reads as the inspector slider does, a percentage, not a fraction', () => {
    const t = topo(100);
    const cache = makeNode('cache', 400, 0);
    const withCache: Topology = {
      ...t,
      nodes: [
        ...t.nodes,
        { ...cache, id: 'cache', config: { ...cache.config, hitRate: 0.3 } },
      ],
    };
    const out = figViews(
      [
        {
          probe: { of: 'setting', node: 'cache', field: 'hitRate' },
          label: 'hit rate',
        },
        { probe: { of: 'setting', node: 'api', field: 'retries' }, label: 'retries' },
      ],
      withCache,
      snap(0, 0),
    );
    expect(out[0]).toMatchObject({ value: '30', unit: '%' });
    expect(out[1]).toMatchObject({ value: '2', unit: '' });
  });
});

describe('the offered load figure', () => {
  it('reads as the slider readout does, in k past a thousand', () => {
    const out = figViews(
      [{ probe: { of: 'load' }, label: 'offered load' }],
      topo(1742),
      snap(0, 0),
    );
    expect(out[0]).toMatchObject({ value: '1.7k', unit: '/s' });
  });
});
