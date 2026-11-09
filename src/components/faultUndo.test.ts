import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../sim/engine';
import { makeNode } from '../sim/presets';
import type { FaultEvent, Topology } from '../sim/types';
import { SessionHistory } from '../history';
import type { FaultApplier, HistorySnapshot } from '../history';
import { faultActionsFor } from './faultWiring';
import type { FaultActions } from './faultWiring';
import { applyFaultChange, undoableFaultActions } from './faultUndo';

/*
 * Fault controls as undo entries, against a real engine. What is pinned is
 * the promise that matters for sharing: after any undo or redo, the engine's
 * schedule replays to exactly the run that was on screen.
 */

const STEP_MS = 100;

function topology(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'client' };
  const svc = { ...makeNode('service', 240, 0), id: 'svc' };
  return {
    nodes: [client, svc],
    edges: [{ id: 'client->svc', from: 'client', to: 'svc', weight: 1 }],
  };
}

function snap(t: Topology): HistorySnapshot {
  return {
    topology: t,
    selectedIds: new Set<string>(),
    rps: 100,
    presetId: null,
    challengeId: null,
  };
}

interface Rig {
  engine: Engine;
  history: SessionHistory;
  actions: FaultActions;
  run: (ms: number) => void;
  undo: () => string | null;
  redo: () => string | null;
  schedule: () => string[];
}

function rig(onChange?: (edited: boolean) => void): Rig {
  const t = topology();
  const engine = new Engine(t);
  const history = new SessionHistory(onChange ? { onChange } : undefined);
  const actions = undoableFaultActions(
    engine,
    faultActionsFor(engine, () => {}),
    { history, before: snap(t) },
  );
  const apply: FaultApplier = (entry, dir) =>
    applyFaultChange(engine, entry.fault, dir, engine.snapshot().system.timeMs, (f) =>
      engine.setTopology({ ...t, faults: f }),
    );
  return {
    engine,
    history,
    actions,
    // Fixed frames, so a replay advanced the same way lands every recording
    // between the same two frames.
    run: (ms) => {
      for (let i = 0; i < ms / STEP_MS; i++) engine.advance(STEP_MS);
    },
    undo: () => history.undo(snap(t), apply)?.label ?? null,
    redo: () => history.redo(snap(t), apply)?.label ?? null,
    schedule: () => engine.faultSchedule().map(line),
  };
}

/** A schedule entry as one short line. */
function line(f: FaultEvent): string {
  const target = 'nodeId' in f ? f.nodeId : f.edgeId;
  const kind = f.action === 'inject' ? ` ${f.kind}` : '';
  return `${f.action}${kind} ${target}@${f.atMs}`;
}

/** The run a share link made now would replay, to the same time. */
function replayOf(engine: Engine, untilMs: number): Engine {
  const replay = new Engine(engine.exportTopology());
  for (let i = 0; i < untilMs / STEP_MS; i++) replay.advance(STEP_MS);
  return replay;
}

function nodeFault(engine: Engine, id: string) {
  const f = engine.activeFailures().find((x) => x.nodeId === id);
  return f ? { kind: f.kind, factor: f.factor } : null;
}

describe('undoing a fault control', () => {
  it('heals a crash now, and a replay of the schedule is the run on screen', () => {
    const r = rig();
    r.run(1500);
    r.actions.onInject('svc', 'crash');
    r.run(1500);
    expect(r.undo()).toBe('crash');
    expect(nodeFault(r.engine, 'svc')).toBeNull();
    expect(r.schedule()).toEqual(['inject crash svc@1500', 'clear svc@3000']);
    r.run(2000);

    const replay = replayOf(r.engine, 5000);
    expect(JSON.stringify(replay.snapshot())).toBe(JSON.stringify(r.engine.snapshot()));
  });

  it('takes a crash out of the schedule when Reset left it still to come', () => {
    const r = rig();
    r.run(1500);
    r.actions.onInject('svc', 'crash');
    r.engine.reset();
    r.run(800);
    expect(r.undo()).toBe('crash');
    expect(r.schedule()).toEqual([]);
    r.run(2000);
    expect(nodeFault(r.engine, 'svc')).toBeNull();
  });

  it('takes out a crash pressed before play once Reset puts it back at zero', () => {
    const r = rig();
    r.actions.onInject('svc', 'crash');
    r.run(500);
    r.engine.reset();
    expect(r.undo()).toBe('crash');
    expect(r.schedule()).toEqual([]);
    r.run(500);
    expect(nodeFault(r.engine, 'svc')).toBeNull();
  });

  it('brings back the slow down a crash replaced', () => {
    const r = rig();
    r.run(1000);
    r.actions.onInject('svc', 'slow', { factor: 5 });
    r.run(1000);
    r.actions.onInject('svc', 'crash');
    r.run(1000);
    expect(r.undo()).toBe('crash');
    expect(nodeFault(r.engine, 'svc')).toEqual({ kind: 'slow', factor: 5 });
    expect(r.undo()).toBe('slow down');
    expect(nodeFault(r.engine, 'svc')).toBeNull();
  });

  it('restores a cut cable, and redo cuts it again', () => {
    const r = rig();
    r.run(1000);
    r.actions.onCut('client->svc');
    r.run(1000);
    expect(r.undo()).toBe('cable cut');
    expect(r.engine.activeCuts()).toEqual([]);
    r.run(1000);
    expect(r.redo()).toBe('cable cut');
    expect(r.engine.activeCuts()).toEqual(['client->svc']);
    expect(r.schedule()).toEqual([
      'cut client->svc@1000',
      'restore client->svc@2000',
      'cut client->svc@3000',
    ]);
    r.run(1000);
    const replay = replayOf(r.engine, 4000);
    expect(JSON.stringify(replay.snapshot())).toBe(JSON.stringify(r.engine.snapshot()));
  });

  it('crashes the node again when a Fix is undone', () => {
    const r = rig();
    r.run(1000);
    r.actions.onInject('svc', 'crash');
    r.run(1000);
    r.actions.onFix('svc');
    r.run(1000);
    expect(r.undo()).toBe('fix');
    expect(nodeFault(r.engine, 'svc')).toEqual({ kind: 'crash', factor: undefined });
  });

  it('undoes a glitch and a crash of one instance', () => {
    const r = rig();
    r.engine.updateNodeConfig('svc', { instances: 3 });
    r.run(1000);
    r.actions.onInject('svc', 'errors', { rate: 0.5 });
    r.run(500);
    r.actions.onInject('svc', 'crash-instance');
    r.run(500);
    expect(r.undo()).toBe('crash one instance');
    expect(r.engine.activeFailures()[0]).toMatchObject({ kind: 'errors', rate: 0.5 });
    expect(r.undo()).toBe('glitch');
    expect(r.engine.activeFailures()).toEqual([]);
  });

  it('skips a fault that already healed, instead of burning the press', () => {
    const r = rig();
    r.run(1000);
    r.actions.onInject('svc', 'crash');
    r.run(500);
    // Healed some other way, as a brief's scheduled fix would.
    r.engine.recordClearFailure('svc');
    expect(r.undo()).toBeNull();
    expect(r.history.canUndo).toBe(false);
  });

  it('redoes an undo that took a pending entry out by recording it now', () => {
    const r = rig();
    r.run(1500);
    r.actions.onInject('svc', 'crash');
    r.engine.reset();
    r.run(500);
    r.undo();
    expect(r.redo()).toBe('crash');
    expect(nodeFault(r.engine, 'svc')?.kind).toBe('crash');
    expect(r.schedule()).toEqual(['inject crash svc@500']);
  });

  it('records nothing for a press the engine refused', () => {
    const r = rig();
    r.actions.onRestore('client->svc');
    r.actions.onFix('svc');
    expect(r.history.canUndo).toBe(false);
  });

  it('is not an edit to the design, so a share link stays unsaved', () => {
    const onChange = vi.fn();
    const r = rig(onChange);
    r.run(1000);
    r.actions.onInject('svc', 'crash');
    r.undo();
    r.redo();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls.every(([edited]) => edited === false)).toBe(true);
  });
});

describe('fault entries in the history', () => {
  it('sit between design entries in the order they were made', () => {
    const r = rig();
    const t = topology();
    r.run(1000);
    r.history.commit('move', snap(t));
    r.actions.onInject('svc', 'crash');
    expect(r.undo()).toBe('crash');
    expect(nodeFault(r.engine, 'svc')).toBeNull();
    expect(r.history.undoDepth).toBe(1);
    expect(r.redo()).toBe('crash');
    expect(nodeFault(r.engine, 'svc')?.kind).toBe('crash');
  });

  it('are skipped without an applier', () => {
    const r = rig();
    r.run(1000);
    r.actions.onInject('svc', 'crash');
    expect(r.history.undo(snap(topology()))).toBeNull();
    expect(nodeFault(r.engine, 'svc')?.kind).toBe('crash');
  });
});
