import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { FailureKind, NodeConfig, SimSnapshot, Topology } from '../sim/types';
import { DEFAULT_GLITCH_RATE, DEFAULT_SLOW_FACTOR } from '../components/faultWiring';
import { MIN_RATE } from '../learn/bottleneck';
import { EXAMPLE_TASKS } from './exampleTasks';
import {
  TASK_START,
  advanceTask,
  figViews,
  probeValue,
  type Cond,
  type ExampleTask,
  type TaskStep,
} from '../learn/exampleTask';

/* Every task card, played by a student who does what the card says and
   nothing else. The moves come from the steps themselves: the load a
   step's button sets, the setting its text names ("from 85% to 30%"), the
   fault it says to press. Nothing here knows a task by name, so a step
   whose text, check or numbers drift apart fails the suite.

   Each run checks three things:
   - every step ticks within STEP_BUDGET seconds of becoming current, on
     seeds 1 to 3;
   - a student who sets the load the card asks for and then lets it settle
     a little under (the slider is a drag, not a number box) still finishes;
   - the figures the card shows when a step ticks back up its text: a step
     that says a part turns requests away shows that part's turned-away
     figure, above zero; one that says requests fail shows failing above
     zero, and so on. */

const SEEDS = [1, 2, 3] as const;
/** Seconds of sim time a step may take once it is current. */
const STEP_BUDGET = 45;
/** Seconds a student takes to act on a step once it is current. */
const REACTION = 1;
/** Where a dragged slider settles, as a share of the load asked for. */
const SETTLE = 0.95;

type Move =
  | { kind: 'load'; rps: number }
  | { kind: 'set'; node: string; patch: Partial<NodeConfig> }
  | { kind: 'fault'; node: string; fault: FailureKind }
  | { kind: 'clear'; node: string };

/** The number a step's text says to set a field to, as the engine stores it. */
function textTarget(text: string): number | null {
  if (/\ba second instance\b/i.test(text)) return 2;
  const all = [...text.matchAll(/\bto (even|[\d,]+%?)/gi)];
  const last = all.at(-1)?.[1];
  if (last === undefined) return null;
  if (last.toLowerCase() === 'even') return 0;
  const pct = last.endsWith('%');
  const n = Number(last.replace(/[,%]/g, ''));
  return pct ? n / 100 : n;
}

function holds(c: Cond, v: number): boolean {
  if (c.atLeast !== undefined && v < c.atLeast) return false;
  if (c.below !== undefined && v >= c.below) return false;
  return true;
}

/**
 * The moves a student makes for one step, read from the step: its button,
 * and every setting or fault its check needs that does not hold yet.
 */
function movesFor(step: TaskStep, topology: Topology, snap: SimSnapshot): Move[] {
  const out: Move[] = [];
  if (step.action?.kind === 'load') out.push({ kind: 'load', rps: step.action.rps });
  for (const c of step.when) {
    const p = c.probe;
    if (p.of === 'setting' || p.of === 'slots') {
      const now = probeValue(p, topology, snap);
      if (now !== null && holds(c, now)) continue;
      const target = textTarget(step.text);
      expect(target, `"${step.text}" names no value to set`).not.toBeNull();
      if (target === null) continue;
      expect(
        holds(c, target),
        `"${step.text}": ${target} does not pass its own check`,
      ).toBe(true);
      if (p.of === 'setting') {
        out.push({ kind: 'set', node: p.node, patch: { [p.field]: target } });
      } else {
        const n = topology.nodes.find((x) => x.id === p.node);
        const instances = Math.max(1, n?.config.instances ?? 1);
        out.push({
          kind: 'set',
          node: p.node,
          patch: { capacity: target / instances },
        });
      }
    } else if (p.of === 'fault') {
      const on = snap.activeFailures.some(
        (f) => f.nodeId === p.node && f.kind === p.kind,
      );
      const want = c.atLeast !== undefined && c.atLeast >= 1;
      if (want && !on) out.push({ kind: 'fault', node: p.node, fault: p.kind });
      if (!want && on) out.push({ kind: 'clear', node: p.node });
    }
  }
  return out;
}

/** The slider's rule, as App's handleRpsChange: clients keep their share. */
function setLoad(engine: Engine, topology: Topology, total: number) {
  const clients = topology.nodes.filter((n) => n.kind === 'client');
  const sum = clients.reduce((s, c) => s + c.config.rps, 0);
  const shares = clients.map((c) =>
    Math.max(
      0,
      Math.round(total * (sum > 0 ? c.config.rps / sum : 1 / clients.length)),
    ),
  );
  const spread = shares.reduce((s, v) => s + v, 0);
  if (shares.length > 0) shares[0] = Math.max(0, (shares[0] ?? 0) + (total - spread));
  clients.forEach((c, i) => {
    const rps = shares[i] ?? 0;
    c.config = { ...c.config, rps };
    engine.updateNodeConfig(c.id, { rps });
  });
}

function apply(engine: Engine, topology: Topology, move: Move) {
  switch (move.kind) {
    case 'load':
      setLoad(engine, topology, move.rps);
      return;
    case 'set': {
      const live = topology.nodes.find((n) => n.id === move.node);
      if (live) live.config = { ...live.config, ...move.patch };
      engine.updateNodeConfig(move.node, move.patch);
      return;
    }
    case 'fault':
      engine.injectFailure(
        move.node,
        move.fault,
        move.fault === 'slow'
          ? { factor: DEFAULT_SLOW_FACTOR }
          : move.fault === 'errors'
            ? { rate: DEFAULT_GLITCH_RATE }
            : {},
      );
      return;
    case 'clear':
      engine.clearFailure(move.node);
  }
}

interface Tick {
  readonly step: number;
  /** Seconds after the step became current. */
  readonly took: number;
  readonly snapshot: SimSnapshot;
  readonly topology: Topology;
}

/**
 * Play a task. `settle` drops the load to SETTLE of what was asked a second
 * after each load step ticks, as a student who dragged past and back would.
 */
function play(task: ExampleTask, seed: number, settle: boolean): Tick[] {
  const preset = PRESETS.find((p) => p.id === task.presetId);
  if (!preset) throw new Error(task.presetId);
  const topology = structuredClone(preset.topology);
  const engine = new Engine(topology, seed);
  engine.advance(100);
  let progress = advanceTask(task, TASK_START, topology, engine.snapshot());
  let currentSince = 0;
  let acted = -1;
  let settleAt: { tenth: number; rps: number } | null = null;
  const ticks: Tick[] = [];
  const budget = (task.steps.length * STEP_BUDGET + 5) * 10;
  for (let tenth = 2; tenth <= budget; tenth++) {
    const step = task.steps[progress.step];
    if (!step) break;
    if (acted !== progress.step && tenth - currentSince >= REACTION * 10) {
      acted = progress.step;
      for (const m of movesFor(step, topology, engine.snapshot()))
        apply(engine, topology, m);
      // A detour the student takes: its next step's moves wait for it.
    }
    if (settleAt && tenth === settleAt.tenth) {
      apply(engine, topology, { kind: 'load', rps: settleAt.rps });
      settleAt = null;
    }
    engine.advance(100);
    const snap = engine.snapshot();
    const before = progress.step;
    progress = advanceTask(task, progress, topology, snap);
    if (progress.step > before && tenth - currentSince > STEP_BUDGET * 10) break;
    for (let s = before; s < progress.step; s++) {
      ticks.push({
        step: s,
        took: (tenth - currentSince) / 10,
        // The engine reuses its snapshot object; keep this one as it was.
        snapshot: structuredClone(snap),
        topology: structuredClone(topology),
      });
      const done = task.steps[s];
      if (settle && done?.action?.kind === 'load' && done.when.length === 1) {
        settleAt = { tenth: tenth + 10, rps: Math.round(done.action.rps * SETTLE) };
      }
    }
    if (progress.step > before) currentSince = tenth;
    if (tenth - currentSince > STEP_BUDGET * 10) break;
  }
  return ticks;
}

function stepsTicked(task: ExampleTask, ticks: readonly Tick[]): string {
  return task.steps
    .map((s, i) => {
      const t = ticks.find((k) => k.step === i);
      return `${i + 1}. ${t ? `${t.took}s` : 'never'}: ${s.text}`;
    })
    .join('\n');
}

/* ---------------- what the text claims ---------------- */

function labelOf(topology: Topology, id: string): string {
  return topology.nodes.find((n) => n.id === id)?.label ?? id;
}

/** Is the part a figure reads the one the step is about? */
function about(step: TaskStep, topology: Topology, node: string): boolean {
  return step.ring === node || step.text.includes(labelOf(topology, node));
}

/** Sentences that say requests are not failing, and the share they allow. */
const NOT_FAILING: readonly (readonly [RegExp, number])[] = [
  [/nothing fails/i, 0.01],
  [/under (\d+)% fails/i, NaN],
  [/failing stays at 0%/i, 0.001],
  [/failing drop back to zero/i, 0.01],
  [/users barely notice/i, 0.02],
];

/** Every claim the step's text makes that its figures can back or refute. */
function claimProblems(
  step: TaskStep,
  topology: Topology,
  snap: SimSnapshot,
): string[] {
  const text = step.text;
  const figs = step.figs ?? [];
  const problems: string[] = [];
  const shown = figViews(figs, topology, snap);
  if (shown.length !== figs.length) {
    problems.push(`shows ${shown.length} of its ${figs.length} figures`);
  }
  const value = (i: number) => probeValue(figs[i]!.probe, topology, snap);
  const find = (of: string, pred: (v: number) => boolean, mustBeAbout = true) =>
    figs.some((f, i) => {
      const p = f.probe;
      if (p.of !== of) return false;
      if (mustBeAbout && 'node' in p && !about(step, topology, p.node)) return false;
      const v = value(i);
      return v !== null && pred(v);
    });

  // The card's figures must agree with the check that ticked the step.
  figs.forEach((f, i) => {
    const v = value(i);
    for (const c of step.when) {
      if (JSON.stringify(c.probe) !== JSON.stringify(f.probe)) continue;
      if (v === null || !holds(c, v)) problems.push(`"${f.label}" reads ${v}`);
    }
  });

  if (
    /\bturns?\b[^.]*\baway\b/i.test(text) &&
    !find('turnedAway', (v) => v >= MIN_RATE)
  ) {
    problems.push(
      'says a part turns work away, but shows no turned-away figure for it',
    );
  }
  if (/\brefuse/i.test(text) && !find('refused', (v) => v >= MIN_RATE)) {
    problems.push('says a part refuses work, but shows no refused figure for it');
  }
  if (/\bfill(s)? up\b|\bfull\b|every slot busy/i.test(text)) {
    const full =
      find('busy', (v) => v >= 0.9) ||
      find('connections', (v) => v >= 1) ||
      find('waiting', (v) => v >= 1) ||
      find('behind', (v) => v >= 1);
    if (!full) problems.push('says a part is full, but no figure shows it');
  }
  if (/\bbehind\b/i.test(text) && !find('behind', (v) => v >= 1)) {
    problems.push('says a stream is behind, but no figure shows it');
  }
  if (/\bexpire/i.test(text) && !find('expired', (v) => v >= MIN_RATE)) {
    problems.push('says events expire, but no figure shows it');
  }
  for (const m of text.matchAll(/\b(?:pass|over|reach|all) ([\d,]+)/gi)) {
    const n = Number((m[1] ?? '').replace(/,/g, ''));
    const big = figs.some((f, i) => {
      if (!['waiting', 'behind', 'connections'].includes(f.probe.of)) return false;
      const v = value(i);
      return v !== null && v >= n;
    });
    if (!big) problems.push(`says ${m[0]}, but no figure reaches ${n}`);
  }
  if (/\bfail/i.test(text)) {
    const not = NOT_FAILING.find(([re]) => re.test(text));
    const failing = figs.findIndex((f) => f.probe.of === 'failing');
    const v = failing >= 0 ? value(failing) : null;
    if (v === null) {
      problems.push('talks about failing, but shows no failing figure');
    } else if (not) {
      const [re, cap] = not;
      const limit = Number.isNaN(cap) ? Number(re.exec(text)?.[1] ?? 0) / 100 : cap;
      if (v >= limit)
        problems.push(`says requests are not failing, but failing reads ${v}`);
    } else if (v < 0.01) {
      problems.push(`says requests fail, but failing reads ${v}`);
    }
  }
  return problems;
}

/** A long task at a high load runs a minute of sim time on a busy machine. */
const SLOW = { timeout: 60_000 };

describe.each(EXAMPLE_TASKS.map((t) => [t.presetId, t] as const))(
  'task card for %s, as a student plays it',
  (_id, task) => {
    it.each(SEEDS)(
      'ticks every step in time, with figures that back the text, seed %i',
      SLOW,
      (seed) => {
        const ticks = play(task, seed, false);
        expect(ticks.length, stepsTicked(task, ticks)).toBe(task.steps.length);
        const problems: string[] = [];
        for (const t of ticks) {
          const step = task.steps[t.step];
          if (!step) continue;
          for (const p of claimProblems(step, t.topology, t.snapshot)) {
            problems.push(`${t.step + 1}. "${step.text}": ${p}`);
          }
        }
        expect(problems).toEqual([]);
      },
    );

    // One seed: the seeds above already vary the run, and this one is about
    // where the slider landed.
    it('still finishes with the load settled a little under the ask', SLOW, () => {
      const ticks = play(task, 1, true);
      expect(ticks.length, stepsTicked(task, ticks)).toBe(task.steps.length);
    });
  },
);
