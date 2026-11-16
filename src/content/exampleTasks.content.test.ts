import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import { LEARNING_PATH } from './learningPath';
import { EXAMPLE_TASKS, taskFor } from './exampleTasks';
import {
  TASK_START,
  advanceTask,
  stepHolds,
  type Probe,
  type TaskStep,
} from '../learn/exampleTask';

/* The shape of every task, and an untouched run at the example's own load,
   which must never complete a step that watches for trouble. Snapshots
   every 100ms of sim time, as the app takes them. Playing each task with
   the moves it asks for is exampleTasks.walkthrough.test.ts. */

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
