import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { SimSnapshot, Topology } from '../sim/types';
import { Timeline, wantsAttention, type TimelineEvent } from './timeline';

/**
 * The timeline against real engine runs, stepped at the app's 10Hz snapshot
 * rate. Each line's numbers are checked against the snapshot taken at the
 * time the line names, so a line can never say something the run did not.
 */

const STEP_MS = 100;

function preset(id: string, factor = 1): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return {
    ...p.topology,
    nodes: p.topology.nodes.map((n) =>
      n.kind === 'client'
        ? { ...n, config: { ...n.config, rps: (n.config.rps ?? 0) * factor } }
        : n,
    ),
  };
}

interface Run {
  lines: readonly TimelineEvent[];
  /** Each snapshot, cloned, by its simulated time. */
  at: Map<number, SimSnapshot>;
  topology: Topology;
}

/**
 * Step the engine and feed the tracker every snapshot. `act` runs before each
 * step and may return a replacement design, as an edit in the app would.
 */
function run(
  topology: Topology,
  seconds: number,
  act?: (engine: Engine, t: Topology, ms: number) => Topology | void,
): Run {
  let t = topology;
  const engine = new Engine(t, 1);
  const tl = new Timeline();
  const at = new Map<number, SimSnapshot>();
  for (let ms = 0; ms <= seconds * 1000; ms += STEP_MS) {
    const next = act?.(engine, t, ms);
    if (next) {
      t = next;
      engine.setTopology(t);
    }
    if (ms > 0) engine.advance(STEP_MS);
    const snap = engine.snapshot();
    // The engine reuses its per-node objects; keep a copy for the checks.
    at.set(snap.system.timeMs, structuredClone(snap));
    tl.observe(t, snap);
  }
  return { lines: [...tl.events()], at, topology: t };
}

function idOf(t: Topology, kind: string): string {
  const n = t.nodes.find((x) => x.kind === kind);
  if (!n) throw new Error(`no ${kind}`);
  return n.id;
}

function line(lines: readonly TimelineEvent[], start: string): TimelineEvent {
  const l = lines.find((e) => e.text.startsWith(start));
  if (!l)
    throw new Error(
      `no line starting "${start}" in\n${lines.map((e) => e.text).join('\n')}`,
    );
  return l;
}

function snapAt(r: Run, ms: number): SimSnapshot {
  const s = r.at.get(ms);
  if (!s) throw new Error(`no snapshot at ${ms}`);
  return s;
}

describe('timeline: Single server, Database slowed 5x', () => {
  const top = preset('single-server');
  const db = idOf(top, 'db');
  const r = run(top, 20, (e, _t, ms) => {
    if (ms === 3000) e.injectFailure(db, 'slow', { factor: 5 });
    if (ms === 14000) e.clearFailure(db);
  });

  it('tells the story in order, cause first', () => {
    const order = [
      'Database slowed down 5x.',
      'Database: all 6 slots busy',
      'Database started turning away',
      'The fault on Database was cleared.',
      'Database is keeping up again.',
    ].map((s) => r.lines.indexOf(line(r.lines, s)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(r.lines[0]?.text).toBe('Database slowed down 5x.');
    expect(r.lines[0]?.tone).toBe('cause');
  });

  it("stamps the fault with the engine's own injection time", () => {
    const fault = line(r.lines, 'Database slowed down 5x.');
    const snap = snapAt(r, 3000);
    expect(snap.activeFailures[0]?.sinceMs).toBe(fault.atMs);
  });

  it('carries the numbers of the snapshot at the time it names', () => {
    const full = line(r.lines, 'Database: all 6 slots busy');
    const snap = snapAt(r, full.atMs);
    const queued = snap.nodes[db]?.queued ?? -1;
    expect(full.text).toBe(`Database: all 6 slots busy, ${queued} waiting in line.`);

    const errs = r.lines.find((e) => e.text.endsWith('of requests started failing.'));
    expect(errs).toBeDefined();
    if (errs) {
      const pct = Math.round((snapAt(r, errs.atMs).system.errorRate ?? 0) * 100);
      expect(errs.text).toBe(`${pct}% of requests started failing.`);
    }
  });

  it('holds a condition for a second before it is a line', () => {
    const full = line(r.lines, 'Database: all 6 slots busy');
    const fault = line(r.lines, 'Database slowed down 5x.');
    expect(full.atMs - fault.atMs).toBeGreaterThanOrEqual(1000);
  });

  it('asks for attention', () => {
    expect(wantsAttention(r.lines, 0)).toBe(true);
  });
});

describe('timeline: what the student changed', () => {
  const top = preset('single-server');
  const client = idOf(top, 'client');
  const db = idOf(top, 'db');
  const withLoad = (t: Topology, rps: number): Topology => ({
    ...t,
    nodes: t.nodes.map((n) =>
      n.id === client ? { ...n, config: { ...n.config, rps } } : n,
    ),
  });

  it('makes a slider drag one line, and a fix its own line', () => {
    const r = run(top, 25, (_e, t, ms) => {
      // A drag: five values in half a second.
      if (ms >= 2000 && ms <= 2400) return withLoad(t, 50 + ((ms - 1900) / 500) * 220);
      if (ms === 12000) {
        return {
          ...t,
          nodes: t.nodes.map((n) =>
            n.id === db ? { ...n, config: { ...n.config, capacity: 12 } } : n,
          ),
        };
      }
    });
    const loads = r.lines.filter((e) => e.text.startsWith('You raised the load'));
    expect(loads.map((e) => e.text)).toEqual([
      'You raised the load from 50 to 270 a second.',
    ]);
    expect(loads[0]?.atMs).toBe(2000);
    line(r.lines, "You changed Database's slots per instance from 6 to 12.");
    const fixed = line(r.lines, 'Database is keeping up again.');
    expect(fixed.atMs).toBeGreaterThan(12000);
    expect(r.lines.at(-1)?.tone).toBe('better');
  });

  it('drops a change that was put back', () => {
    const r = run(top, 4, (_e, t, ms) => {
      if (ms === 1000) return withLoad(t, 60);
      if (ms === 1500) return withLoad(t, 50);
    });
    expect(r.lines).toEqual([]);
  });

  it('starts again when the clock goes back', () => {
    const engine = new Engine(top, 1);
    const tl = new Timeline();
    engine.injectFailure(db, 'crash');
    for (let i = 0; i < 20; i++) {
      engine.advance(STEP_MS);
      tl.observe(top, engine.snapshot());
    }
    expect(tl.events().length).toBeGreaterThan(0);
    engine.clearFailure(db);
    engine.reset();
    expect(tl.observe(top, engine.snapshot())).toBe(true);
    expect(tl.events()).toEqual([]);
  });
});

describe('timeline: every example at its starting load', () => {
  // 60s, the window the charts show. A few examples run one part hot by
  // design and may log it, but nothing may bring the panel up by itself.
  it.each(PRESETS.map((p) => p.id))('%s stays quiet', (id) => {
    const r = run(preset(id), 60);
    const loud = r.lines.filter((e) => e.tone !== 'trouble' || e.loud);
    expect(wantsAttention(r.lines, 0), r.lines.map((e) => e.text).join('\n')).toBe(
      false,
    );
    expect(loud.filter((e) => e.tone !== 'better')).toEqual([]);
  });
});

describe('wantsAttention', () => {
  const ev = (
    id: number,
    tone: TimelineEvent['tone'],
    loud = false,
  ): TimelineEvent => ({
    id,
    atMs: id * 100,
    text: '',
    tone,
    loud,
  });

  it('needs a change before a quiet trouble line counts', () => {
    expect(wantsAttention([ev(1, 'trouble')], 0)).toBe(false);
    expect(wantsAttention([ev(1, 'change'), ev(2, 'trouble')], 0)).toBe(true);
    expect(wantsAttention([ev(1, 'trouble', true)], 0)).toBe(true);
  });

  it('ignores what was already seen', () => {
    expect(wantsAttention([ev(1, 'cause'), ev(2, 'trouble', true)], 2)).toBe(false);
    expect(wantsAttention([ev(1, 'cause'), ev(2, 'better')], 1)).toBe(false);
  });
});
