import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { FailureKind, FailureOpts, NodeConfig, Topology } from '../sim/types';
import { LEARNING_PATH } from './learningPath';
import { EXAMPLE_TASKS, taskFor } from './exampleTasks';
import {
  TASK_START,
  advanceTask,
  stepHolds,
  type ExampleTask,
  type Probe,
  type TaskStep,
} from '../learn/exampleTask';

/* Every task, run against the engine with the moves it asks for. Each step
   has to tick, and the task has to finish within the time below; an
   untouched run at the example's own load must never complete a step that
   watches for trouble. Snapshots every 100ms of sim time, as the app takes
   them. */

type Move =
  | { kind: 'load'; rps: number }
  | { kind: 'set'; node: string; patch: Partial<NodeConfig> }
  | { kind: 'fault'; node: string; fault: FailureKind; opts?: FailureOpts }
  | { kind: 'clear'; node: string };

interface Script {
  /** Second of sim time to move at, and what to do. */
  readonly moves: readonly (readonly [number, Move])[];
  /** Every step done by this second. */
  readonly within: number;
}

const load = (rps: number): Move => ({ kind: 'load', rps });
const set = (node: string, patch: Partial<NodeConfig>): Move => ({
  kind: 'set',
  node,
  patch,
});
const fault = (node: string, f: FailureKind, opts?: FailureOpts): Move => ({
  kind: 'fault',
  node,
  fault: f,
  opts,
});
const clear = (node: string): Move => ({ kind: 'clear', node });

/** The moves a student makes, as the task's own steps and buttons ask. */
const SCRIPTS: Record<string, Script> = {
  'single-server': {
    moves: [
      [1, load(200)],
      [12, set('db', { capacity: 12 })],
    ],
    within: 30,
  },
  'load-balanced': {
    moves: [
      [1, load(560)],
      [8, set('api1', { instances: 2 })],
      [16, set('db', { capacity: 24 })],
    ],
    within: 35,
  },
  'cache-aside': {
    moves: [
      [1, set('cache', { hitRate: 0.3 })],
      [10, set('cache', { hitRate: 0.85 })],
    ],
    within: 30,
  },
  'cdn-origin': {
    moves: [
      [1, set('cdn', { hitRate: 0.5 })],
      [10, set('cdn', { hitRate: 0.9 })],
    ],
    within: 30,
  },
  'async-workers': {
    moves: [
      [1, load(240)],
      [10, set('worker', { capacity: 20 })],
    ],
    within: 30,
  },
  'event-driven': {
    moves: [
      [1, load(135)],
      [12, set('audit', { capacity: 4 })],
    ],
    within: 30,
  },
  whatsapp: { moves: [[1, load(2200)]], within: 25 },
  'retry-storm': {
    moves: [
      [1, load(135)],
      [8, load(45)],
      [20, set('api', { retries: 0 })],
    ],
    within: 30,
  },
  'rate-limited-api': { moves: [[1, load(600)]], within: 15 },
  'circuit-breaker': {
    moves: [
      [1, fault('payments', 'crash')],
      [8, clear('payments')],
    ],
    within: 20,
  },
  'multi-region': { moves: [[1, fault('us-api', 'crash')]], within: 20 },
  'resilient-delivery': {
    moves: [[1, fault('recs', 'slow', { factor: 5 })]],
    within: 15,
  },
  'read-replicas': {
    moves: [
      [1, load(900)],
      [10, set('replicas', { replicaCount: 5 })],
      [20, set('replicas', { readFraction: 0.3 })],
    ],
    within: 35,
  },
  'sharded-database': {
    moves: [
      [1, set('shards', { hotKeyFraction: 0.8 })],
      [10, set('shards', { hotKeyFraction: 0 })],
    ],
    within: 30,
  },
  'specialised-stores': { moves: [[1, load(990)]], within: 20 },
  'autoscaling-service': { moves: [[1, load(500)]], within: 30 },
  'full-stack': { moves: [[1, load(2400)]], within: 25 },
  discord: { moves: [[1, load(1000)]], within: 30 },
  uber: {
    moves: [
      [1, load(1720)],
      [10, fault('payments', 'crash')],
    ],
    within: 25,
  },
  netflix: {
    moves: [
      [1, load(5000)],
      [10, set('license', { capacity: 10 })],
    ],
    within: 25,
  },
  spotify: { moves: [[1, load(5000)]], within: 40 },
  twitter: { moves: [[1, load(660)]], within: 70 },
  stripe: {
    moves: [
      [1, fault('cardnet', 'errors', { rate: 0.5 })],
      [12, fault('ledger', 'crash')],
    ],
    within: 25,
  },
};

/** The slider's rule: clients keep their share of the total. */
function setLoad(engine: Engine, topology: Topology, presetId: string, total: number) {
  const base = PRESETS.find((p) => p.id === presetId)?.topology.nodes ?? [];
  const clients = base.filter((n) => n.kind === 'client');
  const sum = clients.reduce((s, c) => s + c.config.rps, 0);
  for (const c of clients) {
    const rps = Math.round((c.config.rps * total) / sum);
    const live = topology.nodes.find((n) => n.id === c.id);
    if (live) live.config = { ...live.config, rps };
    engine.updateNodeConfig(c.id, { rps });
  }
}

function apply(engine: Engine, topology: Topology, presetId: string, move: Move) {
  switch (move.kind) {
    case 'load':
      setLoad(engine, topology, presetId, move.rps);
      return;
    case 'set': {
      const live = topology.nodes.find((n) => n.id === move.node);
      if (live) live.config = { ...live.config, ...move.patch };
      engine.updateNodeConfig(move.node, move.patch);
      return;
    }
    case 'fault':
      engine.injectFailure(move.node, move.fault, move.opts);
      return;
    case 'clear':
      engine.clearFailure(move.node);
  }
}

/** Run a task, returning the second each step ticked at. */
function runTask(
  task: ExampleTask,
  script: Script | null,
  secs: number,
  /** Tenths of a second to make every move later by. */
  late = 0,
): number[] {
  const preset = PRESETS.find((p) => p.id === task.presetId);
  if (!preset) throw new Error(task.presetId);
  const topology = structuredClone(preset.topology);
  const engine = new Engine(topology);
  let progress = TASK_START;
  const ticks: number[] = [];
  for (let tenth = 1; tenth <= secs * 10; tenth++) {
    for (const [at, move] of script?.moves ?? []) {
      if (at * 10 + late === tenth) apply(engine, topology, task.presetId, move);
    }
    engine.advance(100);
    const before = progress.step;
    progress = advanceTask(task, progress, topology, engine.snapshot());
    for (let s = before; s < progress.step; s++) ticks.push(tenth / 10);
    if (progress.step >= task.steps.length) break;
  }
  return ticks;
}

/** Probes about the state a system is in, as opposed to a move made on it. */
const STATE: ReadonlySet<Probe['of']> = new Set([
  'busy',
  'waiting',
  'turnedAway',
  'refused',
  'behind',
  'expired',
  'connections',
  'breakerOpen',
  'failing',
]);

/** A step that watches for trouble, with only those conditions kept. */
function troubleOnly(step: TaskStep): TaskStep | null {
  const when = step.when.filter(
    (c) => STATE.has(c.probe.of) && c.atLeast !== undefined,
  );
  return when.length > 0 ? { ...step, when } : null;
}

const PATH_EXAMPLES = LEARNING_PATH.flatMap((t) => t.steps)
  .filter((s) => s.kind === 'example')
  .map((s) => s.id);

describe('example tasks', () => {
  it('gives every example on the path a task, and no other', () => {
    expect(EXAMPLE_TASKS.map((t) => t.presetId).sort()).toEqual(
      [...PATH_EXAMPLES].sort(),
    );
    for (const id of PATH_EXAMPLES) expect(taskFor(id)).toBeDefined();
  });

  it('names only nodes the example has, and asks for no load past the slider', () => {
    for (const task of EXAMPLE_TASKS) {
      const ids = new Set(
        PRESETS.find((p) => p.id === task.presetId)?.topology.nodes.map((n) => n.id),
      );
      expect(task.steps.length).toBeGreaterThanOrEqual(1);
      expect(task.steps.length).toBeLessThanOrEqual(4);
      for (const step of task.steps) {
        if (step.ring)
          expect(ids.has(step.ring), `${task.presetId} ring ${step.ring}`).toBe(true);
        if (step.action?.kind === 'select')
          expect(ids.has(step.action.node)).toBe(true);
        if (step.action?.kind === 'load')
          expect(step.action.rps).toBeLessThanOrEqual(5000);
        for (const c of [...step.when, ...(step.figs ?? [])]) {
          const p = c.probe;
          if ('node' in p)
            expect(ids.has(p.node), `${task.presetId} ${p.node}`).toBe(true);
          if (p.of === 'load' && 'atLeast' in c && c.atLeast !== undefined) {
            expect(c.atLeast).toBeLessThanOrEqual(5000);
          }
        }
      }
    }
  });

  it('writes the copy plainly: no em dash, no letter x for times', () => {
    for (const task of EXAMPLE_TASKS) {
      const text = [task.goal, task.learned, ...task.steps.map((s) => s.text)].join(
        '\n',
      );
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\d\s?x\b/);
    }
  });

  /* The inspector shows a hit rate or a share as a percentage on a slider.
     A step that said "0.85 to 0.3" asked for a number the student could not
     find on screen (seen in the first-time walkthrough). */
  it('writes a share the way the inspector shows it, as a percentage', () => {
    for (const task of EXAMPLE_TASKS) {
      for (const text of [task.learned, ...task.steps.map((s) => s.text)]) {
        expect(text, `${task.presetId}: ${text}`).not.toMatch(/\b0\.\d/);
      }
    }
  });

  describe.each(EXAMPLE_TASKS.map((t) => [t.presetId, t] as const))(
    '%s',
    (id, task) => {
      it('ticks every step from the moves it asks for', () => {
        const script = SCRIPTS[id];
        expect(script).toBeDefined();
        if (!script) return;
        // Moved a little later too: a student is never on the exact tick,
        // and a lesson that only shows from one start time is not one.
        for (const late of [0, 7, 23]) {
          const ticks = runTask(task, script, script.within + late / 10, late);
          expect(ticks.length, `late ${late}: ticked at ${ticks.join(', ')}`).toBe(
            task.steps.length,
          );
        }
      });

      it('ticks nothing that watches for trouble on an untouched run', () => {
        const preset = PRESETS.find((p) => p.id === id);
        if (!preset) throw new Error(id);
        const topology = structuredClone(preset.topology);
        for (const step of task.steps) {
          const trouble = troubleOnly(step);
          if (!trouble) continue;
          const probe = { presetId: id, goal: '', learned: '', steps: [trouble] };
          let progress = TASK_START;
          const fresh = new Engine(structuredClone(topology));
          for (let tenth = 1; tenth <= 600 && progress.step === 0; tenth++) {
            fresh.advance(100);
            progress = advanceTask(probe, progress, topology, fresh.snapshot());
          }
          expect(progress.step, `${id}: "${step.text}" held at its own load`).toBe(0);
        }
      });
    },
  );

  it('does not hold a step at its own load for the ones that check state directly', () => {
    // A guard on stepHolds itself: the first step of each task is a move, so
    // it never holds before the move is made.
    for (const task of EXAMPLE_TASKS) {
      const preset = PRESETS.find((p) => p.id === task.presetId)!;
      const engine = new Engine(structuredClone(preset.topology));
      engine.advance(1000);
      const first = task.steps[0];
      if (first)
        expect(stepHolds(first, preset.topology, engine.snapshot())).toBe(false);
    }
  });
});

/* "busy" on the card has to agree with "busy" on the node. A part that
   holds slots while it waits on its own calls reads fuller in the card's
   probe than on the canvas, so only parts that call nothing may show it. */
describe('busy figures', () => {
  it('are only on parts that call nothing, so they match the canvas', () => {
    for (const task of EXAMPLE_TASKS) {
      const preset = PRESETS.find((p) => p.id === task.presetId);
      const callers = new Set(preset?.topology.edges.map((e) => e.from));
      for (const step of task.steps) {
        for (const f of step.figs ?? []) {
          const probe = f.probe;
          if (probe.of !== 'busy') continue;
          const node = preset?.topology.nodes.find((n) => n.id === probe.node);
          const leafish =
            !callers.has(probe.node) ||
            node?.kind === 'shard' ||
            node?.kind === 'replica' ||
            node?.kind === 'websocket';
          expect(leafish, `${task.presetId}: ${f.label}`).toBe(true);
        }
      }
    }
  });
});
