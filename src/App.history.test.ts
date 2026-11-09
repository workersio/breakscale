import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Topology } from './sim/types';
import { Engine } from './sim/engine';
import { makeNode } from './sim/presets';
import { makeNote } from './sim/annotations';
import { HISTORY_LIMIT, SessionHistory, syncEngine } from './history';
import type { HistorySnapshot } from './history';

/*
 * Undo/redo semantics, tested against the same SessionHistory instance the
 * shell drives. Each test simulates the exact call sequence App makes for a
 * gesture, so what is pinned here is the ENTRY GRANULARITY the feature
 * promises: one drag is one entry, one settled knob value is one entry, a
 * selection click is no entry at all.
 */

function makeTopology(): Topology {
  const client = makeNode('client', 0, 0);
  const svc = makeNode('service', 200, 0);
  return {
    nodes: [client, svc],
    edges: [{ id: `${client.id}->${svc.id}`, from: client.id, to: svc.id, weight: 1 }],
  };
}

function snap(
  topology: Topology,
  selected: readonly string[] = [],
  rps = 100,
): HistorySnapshot {
  return {
    topology: structuredClone(topology),
    selectedIds: new Set(selected),
    rps,
    presetId: null,
    challengeId: null,
  };
}

/** The topology with one node shifted, as a drag or nudge would leave it. */
function moved(t: Topology, id: string, dx: number, dy: number): Topology {
  return {
    ...t,
    nodes: t.nodes.map((n) => (n.id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
  };
}

describe('SessionHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an entry that differs only in which brief the canvas belonged to', () => {
    // Starting a brief on the example it is built from changes nothing on
    // the canvas but the workspace. Skipping that entry as a no-op would
    // make undo walk straight past the start instead of leaving the brief.
    const h = new SessionHistory();
    const t = makeTopology();
    h.commit('challenge start', snap(t));
    const entry = h.undo({ ...snap(t), challengeId: 'hold-the-line' });
    expect(entry?.challengeId).toBeNull();
    const back = h.redo(snap(t));
    expect(back?.challengeId).toBe('hold-the-line');
  });

  it('keeps a replaced design whose only difference is its faults and seed', () => {
    // Watching a judged run puts the reader's own boxes and configs back
    // with the run's faults and seed. Skipping that entry as a no-op would
    // make undo walk past the watch and take back an older edit instead.
    const h = new SessionHistory();
    const t = makeTopology();
    const svc = t.nodes[1]!.id;
    const watch: Topology = {
      ...t,
      faults: [
        {
          atMs: 5000,
          action: 'inject',
          nodeId: svc,
          kind: 'slow',
          opts: { factor: 4 },
        },
      ],
      seed: 7,
    };
    h.commit('add', snap(t));
    h.commit('watch run', snap(t), true);
    const entry = h.undo(snap(watch));
    expect(entry?.label).toBe('watch run');
    expect(entry?.topology.faults).toBeUndefined();
    const back = h.redo(snap(t));
    expect(back?.label).toBe('watch run');
    expect(back?.topology.seed).toBe(7);
    expect(back?.replaces).toBe(true);
    // The same schedule and seed is the same run: nothing to undo there.
    const again = new SessionHistory();
    again.commit('watch run', snap(watch), true);
    expect(again.undo(snap(structuredClone(watch)))).toBeNull();
  });

  it('leaves faults recorded during the run out of an ordinary edit', () => {
    // Recording a fault appends to the schedule without an entry, and undo
    // carries the live schedule forward, so an entry that differs from now
    // only by that recording would change nothing and is skipped.
    const h = new SessionHistory();
    const t = makeTopology();
    h.commit('add', snap(t));
    const recorded: Topology = {
      ...t,
      faults: [{ atMs: 3000, action: 'inject', nodeId: t.nodes[1]!.id, kind: 'crash' }],
    };
    expect(h.undo(snap(recorded))).toBeNull();
  });

  it('records one entry for a whole drag, not one per frame', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    // App's sequence: baseline at promotion, then per-frame moves that
    // bypass history (inGesture), then one endGesture at pointerup.
    h.beginGesture('move', snap(t0));
    let t = t0;
    for (let frame = 1; frame <= 60; frame++) {
      t = moved(t0, id, frame, 0);
      // handleMoveNode's guard: inside a gesture, no touch().
      expect(h.inGesture).toBe(true);
    }
    h.endGesture(snap(t, [id]));

    expect(h.undoDepth).toBe(1);
    const entry = h.undo(snap(t, [id]));
    expect(entry).not.toBeNull();
    // Undo lands on the pre-drag position and the pre-drag selection.
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
    expect(entry!.selectedIds.size).toBe(0);
  });

  it('records no entry for a drag that returns to its origin', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    h.beginGesture('move', snap(t0));
    // Out and back; only the endpoints matter to history. The promotion
    // selected the node, but a selection-only difference is not an entry.
    h.endGesture(snap(t0, [id]));

    expect(h.undoDepth).toBe(0);
    expect(h.canUndo).toBe(false);
  });

  it('coalesces a streamed config edit into one entry per settled value', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const id = t0.nodes[1]!.id;

    // Sixty slider frames, then the stream goes quiet.
    let t = t0;
    for (let v = 1; v <= 60; v++) {
      t = {
        ...t,
        nodes: t.nodes.map((n) =>
          n.id === id ? { ...n, config: { ...n.config, capacity: v } } : n,
        ),
      };
      h.touch('setting change', snap(t));
    }
    expect(h.undoDepth).toBe(0); // still pending, not yet an entry
    expect(h.canUndo).toBe(true); // but already undoable
    vi.runAllTimers();
    expect(h.undoDepth).toBe(1);

    // A second, separate adjustment after settling is a second entry.
    h.touch('setting change', snap(t));
    vi.runAllTimers();
    expect(h.undoDepth).toBe(2);
  });

  it('keeps the redo stack across a selection-only change', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.beginGesture('move', snap(t0));
    h.endGesture(snap(t1));
    const back = h.undo(snap(t1));
    expect(back).not.toBeNull();
    expect(h.canRedo).toBe(true);

    // The student clicks a node: App updates selection state and calls
    // NOTHING on history. Redo must still work, and from the changed
    // selection.
    const selectedElsewhere = snap(t0, [t0.nodes[0]!.id]);
    const fwd = h.redo(selectedElsewhere);
    expect(fwd).not.toBeNull();
    expect(fwd!.topology.nodes[1]!.x).toBe(t1.nodes[1]!.x);
  });

  it('clears the redo stack on a real edit', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0));
    h.undo(snap(t1));
    expect(h.canRedo).toBe(true);

    h.commit('delete', snap(t0));
    expect(h.canRedo).toBe(false);
  });

  it('clears the redo stack as soon as a streamed edit begins', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0));
    h.undo(snap(t1));
    expect(h.canRedo).toBe(true);

    // First slider frame: state has already diverged, so redo dies NOW,
    // not 500ms later when the value settles.
    h.touch('setting change', snap(t0));
    expect(h.canRedo).toBe(false);
  });

  it('holds the stack bound and drops the oldest entry first', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();

    h.commit('example load', snap(t0)); // the entry that must fall off
    for (let i = 0; i < HISTORY_LIMIT; i++) {
      h.commit('add', snap(moved(t0, t0.nodes[1]!.id, i, 0)));
    }

    expect(h.undoDepth).toBe(HISTORY_LIMIT);
    expect(h.oldestLabel).toBe('add');
  });

  it('skips no-op entries instead of burning an undo press', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.commit('add', snap(t0)); // the real difference
    h.commit('add', snap(t1)); // identical to the current state below

    const entry = h.undo(snap(t1));
    // One press: the no-op entry was popped and discarded, and the press
    // landed on the state that actually differs.
    expect(entry).not.toBeNull();
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
    expect(h.undoDepth).toBe(0);
  });

  it('flushes a pending streamed edit when undo arrives mid-settle', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const t1 = moved(t0, t0.nodes[1]!.id, 100, 0);

    h.touch('move', snap(t0));
    // Undo before the 500ms settle: the pending entry must land first so
    // this press reverts the nudge, not whatever came before it.
    const entry = h.undo(snap(t1));
    expect(entry).not.toBeNull();
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
  });

  it('is immune to later mutation of what it captured', () => {
    const h = new SessionHistory();
    const t0 = makeTopology();
    const live = snap(t0);

    h.commit('add', live);
    // The caller mutates its own copy afterwards; the entry must not follow.
    (live.topology.nodes[1]! as { x: number }).x = 9999;

    const entry = h.undo(snap(moved(t0, t0.nodes[1]!.id, 50, 0)));
    expect(entry!.topology.nodes[1]!.x).toBe(t0.nodes[1]!.x);
  });

  it('reports an empty undo or redo as no edit', () => {
    // App resumes autosaving a design opened from a share link on the
    // first edit. An Undo pressed with nothing to undo is not one, or it
    // would write the shared design over the reader's own saved session.
    const calls: boolean[] = [];
    const h = new SessionHistory({ onChange: (edited) => calls.push(edited) });
    const t0 = makeTopology();

    expect(h.undo(snap(t0))).toBeNull();
    expect(h.redo(snap(t0))).toBeNull();
    expect(calls).toEqual([false, false]);

    h.commit('add', snap(t0));
    h.undo(snap(moved(t0, t0.nodes[1]!.id, 50, 0)));
    expect(calls).toEqual([false, false, true, true]);
  });
});

describe('note text edits', () => {
  /*
   * The exact sequence App.handleEditNote drives: the editor holds the
   * draft until it submits, then ONE commit lands the finished text (or
   * removes an emptied note). Undo restores the text as it was before the
   * edit began, however many keystrokes it took; redo brings the edit back.
   */
  function withNote(text: string): Topology {
    return { ...makeTopology(), annotations: [makeNote(0, 0, text)] };
  }
  const noteText = (t: Topology) => {
    const a = t.annotations?.[0];
    return a && a.kind === 'note' ? a.text : null;
  };

  it('one edit is one entry, whatever was typed on the way', () => {
    const h = new SessionHistory();
    const t0 = withNote('before');
    const id = t0.annotations![0]!.id;
    // Keystrokes never reach history: the draft lives in the editor.
    h.commit('note edit', snap(t0, [id]));
    const t1 = {
      ...t0,
      annotations: [{ ...t0.annotations![0]!, text: 'after\nmore' }],
    };

    expect(h.undoDepth).toBe(1);
    const back = h.undo(snap(t1, [id]));
    expect(noteText(back!.topology)).toBe('before');
    expect(back!.label).toBe('note edit');
    const fwd = h.redo(back!);
    expect(noteText(fwd!.topology)).toBe('after\nmore');
  });

  it('an emptied note is a delete entry, and undo brings the note back', () => {
    const h = new SessionHistory();
    const t0 = withNote('before');
    const id = t0.annotations![0]!.id;
    h.commit('delete', snap(t0, [id]));
    const t1 = { ...t0, annotations: [] };

    const back = h.undo(snap(t1));
    expect(noteText(back!.topology)).toBe('before');
    expect(back!.selectedIds.has(id)).toBe(true);
  });

  it('a commit with identical text would be a no-op entry', () => {
    // The canvas never calls it (Canvas.noteEdit.test.tsx pins that); if
    // it ever did, snapshotEqual would still refuse to store the entry.
    const h = new SessionHistory();
    const t0 = withNote('same');
    h.commit('note edit', snap(t0));
    expect(h.undo(snap(t0))).toBeNull();
  });
});

describe('syncEngine', () => {
  it('pushes an edge lossRate undo into the engine', () => {
    const t0 = makeTopology();
    const lossy = structuredClone(t0);
    lossy.edges[0]!.lossRate = 0.25;
    const engine = new Engine(lossy);
    const setTopo = vi.spyOn(engine, 'setTopology');
    syncEngine(engine, lossy, t0);
    expect(setTopo).toHaveBeenCalledWith(t0);
  });

  it('applies a config-only undo through updateNodeConfig, without reset', () => {
    const t0 = makeTopology();
    const svcId = t0.nodes[1]!.id;
    const engine = new Engine(t0);
    engine.advance(2000);
    const timeBefore = engine.snapshot().system.timeMs;
    expect(timeBefore).toBeGreaterThan(0);

    const edited = structuredClone(t0);
    edited.nodes[1]!.config.capacity = 99;

    const setTopo = vi.spyOn(engine, 'setTopology');
    const reset = vi.spyOn(engine, 'reset');
    const update = vi.spyOn(engine, 'updateNodeConfig');

    syncEngine(engine, t0, edited);

    // The live in-place path, exactly as a forward knob edit uses.
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      svcId,
      expect.objectContaining({ capacity: 99 }),
    );
    expect(setTopo).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    // The simulation clock, and with it every metric a student was
    // watching, is untouched.
    expect(engine.snapshot().system.timeMs).toBe(timeBefore);
  });

  it('applies a structural undo through setTopology, still without reset', () => {
    const t0 = makeTopology();
    const engine = new Engine(t0);
    engine.advance(1000);
    const timeBefore = engine.snapshot().system.timeMs;

    const grown = structuredClone(t0);
    const extra = makeNode('cache', 400, 0);
    grown.nodes.push(extra);

    const setTopo = vi.spyOn(engine, 'setTopology');
    const reset = vi.spyOn(engine, 'reset');

    syncEngine(engine, t0, grown);

    expect(setTopo).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(engine.snapshot().system.timeMs).toBe(timeBefore);
  });

  it('treats a position-only difference as non-structural', () => {
    // Node positions are presentation; undoing a pure move must not push a
    // whole topology into the engine (which would stomp autoscaler-written
    // capacity, among other live state).
    const t0 = makeTopology();
    const engine = new Engine(t0);
    const setTopo = vi.spyOn(engine, 'setTopology');
    const update = vi.spyOn(engine, 'updateNodeConfig');

    syncEngine(engine, t0, moved(t0, t0.nodes[1]!.id, 120, 40));

    expect(setTopo).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
