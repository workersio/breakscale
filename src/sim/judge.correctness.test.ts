import { describe, expect, it } from 'vitest';
import { challengeById } from './challenges';
import type { Challenge } from './challenge';
import {
  CORRECTNESS_SETTLE_MS,
  judge,
  judgedTopology,
  playRun,
  startDesign,
} from './judge';
import type { RunResult } from './judge';
import type { Topology } from './types';

/*
 * A brief with a correctness goal is checked from the operation log: the
 * check starts it with the run, plays CORRECTNESS_SETTLE_MS past the window
 * so a retry still running has finished, and counts with the same checks
 * "Can you break it?" uses.
 */

function brief(id: string): Challenge {
  const c = challengeById(id);
  if (!c) throw new Error(`no brief ${id}`);
  return c;
}

function seedRun(c: Challenge, design: Topology, seed: number): RunResult {
  const play = playRun(c, judgedTopology(c, design).topology, seed);
  for (;;) {
    const step = play.next();
    if (step.done) return step.value;
  }
}

function opened(c: Challenge): Topology {
  return structuredClone(startDesign(c));
}

describe('a brief checked for correctness', () => {
  it.each([
    ['charged-twice', 'doubleCharges', 23],
    ['lost-on-the-way-back', 'doubleCharges', 64],
    ['sent-twice', 'doubleCharges', 204],
    ['saved-then-gone', 'lostAckedWrites', 94],
    ['read-your-own-write', 'staleReads', 439],
  ] as const)('%s counts its %s exactly as it starts', (id, metric, count) => {
    const c = brief(id);
    const run = seedRun(c, opened(c), 1);
    expect(run.outcome).toBe('goal-missed');
    const goal = run.goals.find((g) => g.goal.metric === metric);
    expect(goal?.actual).toBe(count);
    expect(goal?.met).toBe(false);
  });

  it('names the first request it went wrong for', () => {
    const c = brief('charged-twice');
    const v = judge(c, opened(c));
    expect(v.status).toBe('goal-missed');
    if (v.status !== 'goal-missed') return;
    const e = v.deciding.evidence;
    if (e?.check !== 'atMostOnce') throw new Error('expected a double charge');
    expect(e.nodeId).toBe('pay');
    expect(e.chargedMs.length).toBeGreaterThanOrEqual(2);
    // Sent inside the window, and charged around the stall at 30s.
    expect(e.invokedMs).toBeGreaterThanOrEqual(15_000);
    expect(e.chargedMs[1]).toBeGreaterThan(30_000);
  });

  it('gives no evidence once the data is right', () => {
    const c = brief('sent-twice');
    const t = opened(c);
    const pay = t.nodes.find((n) => n.id === 'pay');
    if (!pay) throw new Error('no Payments');
    pay.config.idempotencyKeys = 1;
    const run = seedRun(c, t, 1);
    expect(run.outcome).toBe('passed');
    expect(run.goals[0].actual).toBe(0);
    expect(run.evidence).toBeUndefined();
  });

  it('waits for retries to finish, and reads nothing it does not need', () => {
    expect(CORRECTNESS_SETTLE_MS).toBe(5000);
    // A brief with no correctness goal keeps no log and carries no evidence.
    const c = brief('saved-then-lost');
    const run = seedRun(c, opened(c), 1);
    expect(run.evidence).toBeUndefined();
    expect(Object.keys(run)).not.toContain('evidence');
  });
});
