// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CHECK_SETTLE_MS,
  useChallengeCheck,
  type ChallengeCheck,
} from './useChallengeCheck';
import { freshStart } from './challengeWorkspace';
import { challengeById } from './sim/challenges';
import type { Challenge } from './sim/challenge';
import type { Verdict } from './sim/judge';
import type { Topology } from './sim/types';

/**
 * The check runs on its own once the design settles, in slices, and is
 * dropped when the design changes under it. These drive the real judge on a
 * real brief, with the clock faked so "a second later" is exact.
 */

const brief = challengeById('hold-the-line')!;

let container: HTMLDivElement;
let root: Root;
let latest: ChallengeCheck | null = null;
const verdicts: Verdict[] = [];

function Harness({ challenge, design }: { challenge: Challenge; design: Topology }) {
  const check = useChallengeCheck(challenge, design, (v) => verdicts.push(v));
  // Read out after commit, the way a test is allowed to look at a hook.
  useLayoutEffect(() => {
    latest = check;
  });
  return null;
}

function show(design: Topology, challenge: Challenge = brief): void {
  act(() => root.render(<Harness challenge={challenge} design={design} />));
}

/** Let `ms` pass, running whatever the check scheduled in it. */
function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The start design with the database given `capacity` slots. */
function dbCapacity(capacity: number): Topology {
  const t = freshStart(brief);
  return {
    ...t,
    nodes: t.nodes.map((n) =>
      n.kind === 'db' ? { ...n, config: { ...n.config, capacity } } : n,
    ),
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  verdicts.length = 0;
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the automatic check', () => {
  it('waits a second after the design settles, then gives a verdict', () => {
    show(freshStart(brief));
    expect(latest?.view).toEqual({ status: 'stale', hadVerdict: false });
    wait(CHECK_SETTLE_MS - 10);
    expect(latest?.view.status).toBe('stale');
    expect(verdicts).toHaveLength(0);
    wait(20);
    // Every slice of every run, until the verdict lands.
    for (let i = 0; i < 2000 && latest?.view.status !== 'verdict'; i++) wait(1);
    expect(latest?.view.status).toBe('verdict');
    expect(verdicts).toHaveLength(1);
    // The untouched brief fails; that is what makes it a brief.
    expect(verdicts[0]!.status).not.toBe('passed');
  });

  it('starts the wait again on every change, and drops a check in progress', () => {
    // Each slice spends its whole budget on one step, so the check takes
    // many slices and can be caught halfway.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    show(dbCapacity(5));
    wait(CHECK_SETTLE_MS);
    wait(5);
    expect(latest?.view.status).toBe('checking');
    show(dbCapacity(6));
    expect(latest?.view.status).toBe('stale');
    for (let i = 0; i < 2000; i++) wait(1);
    // One verdict, for the design on the canvas: the first check never
    // finished.
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.designKey).toBe(latest?.key);
  });

  it('does not throw a verdict away for a node dragged', () => {
    const t = freshStart(brief);
    show(t);
    for (let i = 0; i < 2000 && latest?.view.status !== 'verdict'; i++) wait(1);
    const before = latest?.view.status === 'verdict' ? latest.view.verdict : null;
    expect(before).not.toBeNull();
    show({ ...t, nodes: t.nodes.map((n) => ({ ...n, x: n.x + 40 })) });
    expect(latest?.view.status === 'verdict' && latest.view.verdict).toBe(before);
    wait(CHECK_SETTLE_MS * 3);
    expect(verdicts).toHaveLength(1);
  });

  it('answers at once for a design undone back to one already checked', () => {
    const a = dbCapacity(5);
    show(a);
    for (let i = 0; i < 2000 && latest?.view.status !== 'verdict'; i++) wait(1);
    show(dbCapacity(7));
    for (let i = 0; i < 2000 && verdicts.length < 2; i++) wait(1);
    show(a);
    expect(latest?.view.status).toBe('verdict');
    expect(verdicts).toHaveLength(2);
  });

  it('checks again at once when asked', () => {
    show(freshStart(brief));
    for (let i = 0; i < 2000 && latest?.view.status !== 'verdict'; i++) wait(1);
    act(() => latest?.checkAgain());
    expect(latest?.view.status).not.toBe('verdict');
    wait(0);
    for (let i = 0; i < 2000 && latest?.view.status !== 'verdict'; i++) wait(1);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[1]).toEqual(verdicts[0]);
  });

  it('counts slots against the budget live, before any check', () => {
    const budgeted = { ...brief, budget: 2 };
    show(
      dbCapacity(
        freshStart(brief).nodes.find((n) => n.kind === 'db')!.config.capacity + 3,
      ),
      budgeted,
    );
    expect(latest?.budget).toEqual({ used: 3, allowed: 2 });
    for (let i = 0; i < 50 && latest?.view.status !== 'verdict'; i++)
      wait(CHECK_SETTLE_MS);
    expect(latest?.view.status === 'verdict' && latest.view.verdict.status).toBe(
      'over-budget',
    );
  });
});
