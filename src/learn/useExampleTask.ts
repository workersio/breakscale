import { useCallback, useEffect, useState } from 'react';
import type { SimSnapshot, Topology } from '../sim/types';
import { taskFor } from '../content/exampleTasks';
import {
  TASK_START,
  advanceTask,
  type ExampleTask,
  type TaskProgress,
} from './exampleTask';

/** Examples whose task card the student folded away, kept across visits. */
export const TASK_HIDDEN_KEY = 'breakscale.task.v1';

function loadHidden(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(TASK_HIDDEN_KEY);
    const list = raw ? (JSON.parse(raw) as { hidden?: unknown } | null)?.hidden : null;
    return new Set(
      Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function saveHidden(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(TASK_HIDDEN_KEY, JSON.stringify({ hidden: [...hidden] }));
  } catch {
    // Blocked storage: the card folds for this visit only.
  }
}

export type TaskView =
  /** No example with a task is on the canvas. */
  | { kind: 'none' }
  /** The task is being checked against the run. */
  | {
      kind: 'live';
      task: ExampleTask;
      progress: TaskProgress;
      done: boolean;
      hidden: boolean;
    }
  /**
   * The diagram was edited off the example, so its steps no longer describe
   * it. Shown, not checked, so the student knows why nothing ticks.
   */
  | { kind: 'stale'; task: ExampleTask; hidden: boolean };

export interface ExampleTaskState {
  view: TaskView;
  /** Fold the card to its chip, or open it again. Remembered per example. */
  setHidden: (presetId: string, hidden: boolean) => void;
}

interface Tracked {
  presetId: string;
  run: number;
  progress: TaskProgress;
}

/**
 * The task for the example on the canvas, moved on from each snapshot.
 *
 * `presetId` is the example, or null inside a challenge or once the design
 * has been edited off it. `run` changes each time an example is loaded, so
 * opening the same one again starts its task again.
 */
export function useExampleTask(
  presetId: string | null,
  run: number,
  topology: Topology,
  snapshot: SimSnapshot | null,
): ExampleTaskState {
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [hidden, setHiddenSet] = useState(loadHidden);

  const task = taskFor(presetId);
  /* Made while rendering, from the props this render has, as useTour does:
     a new example or a fresh load starts over; a snapshot moves it on.
     Each returns to rest after one pass, since advanceTask hands back the
     same progress when nothing changed. */
  if (
    task &&
    presetId !== null &&
    (tracked?.presetId !== presetId || tracked.run !== run)
  ) {
    setTracked({ presetId, run, progress: TASK_START });
    // Opened again on purpose, so its card shows again. The first example
    // of a visit keeps how the student left it.
    if (tracked !== null && hidden.has(presetId)) {
      const next = new Set(hidden);
      next.delete(presetId);
      setHiddenSet(next);
    }
  } else if (task && tracked && snapshot) {
    const next = advanceTask(task, tracked.progress, topology, snapshot);
    if (next !== tracked.progress) setTracked({ ...tracked, progress: next });
  }

  const setHidden = useCallback((id: string, fold: boolean) => {
    setHiddenSet((cur) => {
      if (cur.has(id) === fold) return cur;
      const next = new Set(cur);
      if (fold) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  // Storage is the external system.
  useEffect(() => saveHidden(hidden), [hidden]);

  let view: TaskView = { kind: 'none' };
  if (task && tracked?.presetId === presetId) {
    view = {
      kind: 'live',
      task,
      progress: tracked.progress,
      done: tracked.progress.step >= task.steps.length,
      hidden: hidden.has(task.presetId),
    };
  } else if (presetId === null && tracked) {
    /* Off the example. Still its diagram while every part the task names is
       there; a different design (an empty canvas, a saved one) ends it. */
    const last = taskFor(tracked.presetId);
    const ids = new Set(topology.nodes.map((n) => n.id));
    const named = last?.steps.flatMap((s) => (s.ring ? [s.ring] : [])) ?? [];
    // A finished task has nothing left to check, so an edit after it is play.
    const finished = last !== undefined && tracked.progress.step >= last.steps.length;
    if (last && !finished && named.length > 0 && named.every((id) => ids.has(id))) {
      view = { kind: 'stale', task: last, hidden: hidden.has(last.presetId) };
    }
  }
  return { view, setHidden };
}
