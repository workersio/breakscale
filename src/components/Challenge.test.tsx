// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChallengePanel, type ChallengePanelProps } from './Challenge';
import { CHALLENGES } from '../sim/challenges';
import type { ChallengeResult } from '../sim/challenge';
import type { RunResult, Unjudgeable, Verdict } from '../sim/judge';
import type { CheckView } from '../useChallengeCheck';

/**
 * The panel's promises: the live reading never declares a pass, the lesson
 * only appears beside a pass of the design on the canvas, every state of the
 * check says what it is in words, and the numbers it quotes round toward
 * failing.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A press the way a finger or a mouse makes one, ending in the click. */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0 }));
  });
}

function button(name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
    ) ?? null
  );
}

const brief = CHALLENGES.find((c) => c.goals.length === 2)!;
const p99Goal = brief.goals.find((g) => g.metric === 'p99')!;
const lossGoal = brief.goals.find((g) => g.metric === 'errorRate')!;

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    seed: 2,
    arrived: 54_000,
    completed: 53_900,
    failed: 100,
    failuresByReason: { shed: 80, timeout: 20 },
    loss: 100 / 54_000,
    keptUp: 1,
    p95: 120,
    p99: 180,
    lostWrites: null,
    lostJobs: null,
    queueDepth: null,
    goals: [
      { goal: p99Goal, actual: 180, met: true },
      { goal: lossGoal, actual: (100 / 54_000) * 100, met: false },
    ],
    outcome: 'goal-missed',
    replay: { nodes: [], edges: [] },
    ...over,
  };
}

const KEY = `${brief.id}@${brief.version}:x`;

function verdict(v: Partial<Verdict> & Pick<Verdict, 'status'>): Verdict {
  return { designKey: KEY, budget: null, ...v } as Verdict;
}

const passed = verdict({
  status: 'passed',
  runs: [run({ outcome: 'passed' })],
  deciding: run({
    outcome: 'passed',
    goals: [
      { goal: p99Goal, actual: 180, met: true },
      { goal: lossGoal, actual: 0.5, met: true },
    ],
  }),
});

const missed = verdict({
  status: 'goal-missed',
  runs: [run({ seed: 1 })],
  deciding: run({
    seed: 1,
    goals: [
      { goal: p99Goal, actual: p99Goal.max + 0.4, met: false },
      { goal: lossGoal, actual: 0.2, met: true },
    ],
  }),
});

const liveAllMet: ChallengeResult = {
  passed: true,
  goals: brief.goals.map((goal) => ({ goal, actual: 0, met: true })),
};

function render(over: Partial<ChallengePanelProps> = {}): ChallengePanelProps {
  const props: ChallengePanelProps = {
    challenge: brief,
    live: liveAllMet,
    liveFlowing: true,
    check: { status: 'stale', hadVerdict: false },
    budget: null,
    hintsShown: 0,
    onHint: vi.fn(),
    onCheckAgain: vi.fn(),
    onWatch: vi.fn(),
    onStartOver: null,
    onNext: vi.fn(),
    onLeave: vi.fn(),
    focusSignal: 0,
    nameOf: (id) => `the ${id}`,
    ...over,
  };
  act(() => root.render(<ChallengePanel {...props} />));
  return props;
}

const text = () => container.textContent ?? '';

describe('the live reading', () => {
  it('never declares a pass, even with every goal under its line', () => {
    render();
    expect(container.querySelector('.chal-goal.is-met')).toBeNull();
    expect(container.querySelector('.chal.is-passed')).toBeNull();
    expect(text()).toContain('Right now on screen');
    expect(text()).not.toContain('Passed');
    expect(container.querySelector('.chal-live .chal-goal-state')).toBeNull();
  });

  it('says nothing is getting through rather than quoting a percentile', () => {
    render({ liveFlowing: false });
    expect(text()).toContain('Nothing is getting through right now.');
    expect(container.querySelectorAll('.chal-live .chal-goal').length).toBe(0);
  });
});

describe('the lesson', () => {
  const notPassed: CheckView[] = [
    { status: 'stale', hadVerdict: true },
    { status: 'checking', run: 1, done: 0.5 },
    { status: 'verdict', verdict: missed },
    {
      status: 'verdict',
      verdict: verdict({ status: 'over-budget', budget: { used: 7, allowed: 6 } }),
    },
    {
      status: 'verdict',
      verdict: verdict({ status: 'unjudgeable', why: { reason: 'no-traffic' } }),
    },
    {
      status: 'verdict',
      verdict: verdict({
        status: 'falling-behind',
        runs: [run({ keptUp: 0.931, outcome: 'falling-behind' })],
        deciding: run({ keptUp: 0.931, outcome: 'falling-behind' }),
      }),
    },
  ];

  it.each(
    notPassed.map((c) => [c.status === 'verdict' ? c.verdict.status : c.status, c]),
  )('stays hidden while the check is %s', (_name, check) => {
    render({ check });
    expect(text()).not.toContain(brief.lesson);
    expect(button('Next challenge')).toBeNull();
  });

  it('appears with a pass of the design on the canvas', () => {
    render({ check: { status: 'verdict', verdict: passed } });
    expect(text()).toContain(brief.lesson);
    expect(container.querySelector('.chal.is-passed')).not.toBeNull();
    expect(button('Next challenge')).not.toBeNull();
    // The hints have done their job; the lesson takes their place.
    expect(button('Give me a hint')).toBeNull();
  });
});

describe('the check', () => {
  it('says the design changed while a check is due', () => {
    render({ check: { status: 'stale', hadVerdict: true } });
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Changed');
    expect(text()).toContain('You changed the design.');
  });

  it('does not say changed before anything has been checked', () => {
    render({ check: { status: 'stale', hadVerdict: false } });
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Not checked yet');
  });

  it('shows how far it has got', () => {
    render({ check: { status: 'checking', run: 1, done: 0.5 } });
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('50');
    expect(text()).toContain('Checking run 2 of 3');
    // Nothing to check again while it is checking, but the button stays,
    // so pressing it never drops focus to the page.
    const again = button('Check again');
    expect(again?.getAttribute('aria-disabled')).toBe('true');
  });

  it('names the goal missed, rounded toward failing it', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    // 200.4ms printed as 200ms would read as on the line.
    expect(text()).toContain(
      `Not yet. The slowest 1 in 100 requests took ${p99Goal.max + 1}ms, and the goal is ${p99Goal.max}ms or less.`,
    );
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Not yet');
  });

  it('gives one reason line from the run counts', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    expect(text()).toContain(
      'Most lost requests (80%) were turned away because every slot was taken and the line was full.',
    );
  });

  it('says a design falling behind is falling behind, rounded down', () => {
    const behind = verdict({
      status: 'falling-behind',
      runs: [run({ keptUp: 0.9799, outcome: 'falling-behind' })],
      deciding: run({ keptUp: 0.9799, outcome: 'falling-behind' }),
    });
    render({ check: { status: 'verdict', verdict: behind } });
    expect(text()).toContain('Only 97.9% of the requests sent');
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Falling behind');
  });

  it('shows the slot budget, and says when it is spent', () => {
    render({ budget: { used: 4, allowed: 6 } });
    expect(container.querySelector('.chal-budget')?.textContent).toBe(
      'You can add up to 6 more slots. Used: 4.',
    );
    render({ budget: { used: 0, allowed: 0 } });
    expect(container.querySelector('.chal-budget')?.textContent).toBe(
      "You can't add any slots here. Used: 0.",
    );
    const over = verdict({ status: 'over-budget', budget: { used: 7, allowed: 6 } });
    render({
      budget: { used: 7, allowed: 6 },
      check: { status: 'verdict', verdict: over },
    });
    expect(container.querySelector('.chal-budget.is-over')).not.toBeNull();
    expect(text()).toContain('This design adds 7 slots and the brief allows 6.');
    expect(button('Watch run 2')).toBeNull();
  });

  it('says why a design cannot be checked', () => {
    const lost = verdict({
      status: 'unjudgeable',
      why: { reason: 'fault-target-missing', target: 'db', why: 'gone' },
    });
    render({ check: { status: 'verdict', verdict: lost } });
    expect(text()).toContain('The brief breaks the db on purpose');
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Cannot check');
  });

  it('says what a design changed that the brief does not allow', () => {
    const cases: [Unjudgeable, string][] = [
      [{ reason: 'traffic-added' }, 'This design has a client the brief does not.'],
      [
        { reason: 'component-missing', kind: 'db' },
        'Requests no longer reach every database the brief started with.',
      ],
      [
        { reason: 'connection-cut', from: 'api', to: 'db' },
        'Requests no longer get from the api to the db.',
      ],
      [
        { reason: 'connection-added', from: 'client', to: 'db' },
        'the client now sends requests straight to the db',
      ],
      [
        { reason: 'shortcut-added', kind: 'queue', allowed: 0 },
        'A new queue would answer requests',
      ],
      [
        { reason: 'shortcut-added', kind: 'cache', allowed: 1 },
        'This brief allows one new cache, and this design adds more.',
      ],
      [
        { reason: 'dead-end-added', nodeId: 'sink', kind: 'service' },
        'the sink answers requests without passing them on',
      ],
    ];
    for (const [why, line] of cases) {
      render({
        check: { status: 'verdict', verdict: verdict({ status: 'unjudgeable', why }) },
      });
      expect(text().toLowerCase()).toContain(line.toLowerCase());
    }
  });

  it('says how many saves were lost, and that it has to be none', () => {
    const lostGoal = { metric: 'lostWrites' as const, max: 0 };
    const lost = verdict({
      status: 'goal-missed',
      runs: [run({ seed: 1 })],
      deciding: run({
        seed: 1,
        lostWrites: 312,
        goals: [{ goal: lostGoal, actual: 312, met: false }],
      }),
    });
    render({ check: { status: 'verdict', verdict: lost } });
    expect(text()).toContain(
      '312 saves never reached the database, and the goal is none.',
    );
  });

  it('announces the verdict, politely, and nothing before it', () => {
    render({ check: { status: 'checking', run: 0, done: 0.1 } });
    const live = container.querySelector('[role="status"]');
    expect(live?.textContent).toBe('');
    render({ check: { status: 'verdict', verdict: passed } });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Passed. Your design met every goal in all 3 test runs.',
    );
  });

  it('plays the run the verdict rests on', () => {
    const props = render({ check: { status: 'verdict', verdict: missed } });
    const watch = button('Watch run 1');
    expect(watch).not.toBeNull();
    press(watch!);
    expect(props.onWatch).toHaveBeenCalledWith(1);
    press(button('Check again')!);
    expect(props.onCheckAgain).toHaveBeenCalledTimes(1);
  });
});

describe('what a student sees first', () => {
  const goalStates = () =>
    [...container.querySelectorAll('.chal-body > .chal-goals .chal-goal')].map((li) => [
      li.querySelector('.chal-goal-actual')?.textContent,
      li.querySelector('.chal-goal-state')?.textContent,
    ]);

  it('lists each goal once, with the checked number and met or not met', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    expect(container.querySelectorAll('.chal-body > .chal-goals').length).toBe(1);
    expect(goalStates()).toEqual([
      [`${p99Goal.max + 1}ms`, 'Not met'],
      ['0.2%', 'Met'],
    ]);
    expect(text()).toContain(`Goal: ${p99Goal.max}ms or less`);
  });

  it('shows checking, never a number or a verdict, while a check runs', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    render({ check: { status: 'checking', run: 0, done: 0.2 } });
    expect(goalStates()).toEqual([
      ['', 'Checking'],
      ['', 'Checking'],
    ]);
    expect(container.querySelector('.chal-verdict')?.textContent).toBe('Checking…');
    expect(text()).not.toContain('Not yet');
    expect(
      container.querySelector('.chal-goal.is-met, .chal-goal.is-unmet'),
    ).toBeNull();
  });

  it('keeps the live reading, the runs and the buttons behind Details', () => {
    render({ check: { status: 'verdict', verdict: passed } });
    const toggle = button('Details')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(true);
    for (const inside of [
      'Right now on screen',
      'Closest call: run 2',
      'from 15s to 60s',
    ])
      expect(body.textContent).toContain(inside);
    expect(body.contains(button('Watch run 2'))).toBe(true);
    expect(body.contains(button('Check again'))).toBe(true);
    press(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    press(toggle);
    expect(body.hidden).toBe(true);
  });

  it('closes Details again on a new start', () => {
    render({ focusSignal: 1 });
    press(button('Details')!);
    render({ focusSignal: 2 });
    expect(button('Details')?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('panel chrome', () => {
  it('collapses to its name and state, and opens again', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    const toggle = button('Hide the brief')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    press(toggle);
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(true);
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Not yet');
    const show = button('Show the brief')!;
    expect(show.getAttribute('aria-expanded')).toBe('false');
    press(show);
    expect(body.hidden).toBe(false);
  });

  it('takes focus when a brief is started by hand, not on a reload', () => {
    render({ focusSignal: 0 });
    expect(document.activeElement).not.toBe(container.querySelector('h2'));
    render({ focusSignal: 1 });
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('opens again on a new start', () => {
    render({ focusSignal: 1 });
    press(button('Hide the brief')!);
    render({ focusSignal: 2 });
    expect(button('Hide the brief')).not.toBeNull();
  });

  it('gives hints only when asked, one at a time', () => {
    const props = render({ hintsShown: 0 });
    expect(text()).not.toContain(brief.hints[0]!);
    press(button('Give me a hint')!);
    expect(props.onHint).toHaveBeenCalledTimes(1);
    render({ hintsShown: 1 });
    expect(text()).toContain(brief.hints[0]!);
    expect(text()).not.toContain(brief.hints[1]!);
    expect(button('Another hint')).not.toBeNull();
  });

  it('always offers the way back, and Start over only when it does something', () => {
    const props = render();
    expect(button('Start over')).toBeNull();
    press(button('Back to my design')!);
    expect(props.onLeave).toHaveBeenCalledTimes(1);
    const again = render({ onStartOver: vi.fn() });
    press(button('Start over')!);
    expect(again.onStartOver).toHaveBeenCalledTimes(1);
    // Start over goes once the design is the start again, so focus is put
    // at the top of the brief rather than left to fall to the page.
    expect(document.activeElement).toBe(container.querySelector('h2'));
  });

  it('keeps focus in the panel when the last hint takes its button away', () => {
    const last = brief.hints.length - 1;
    render({ hintsShown: last });
    const more = button('Another hint')!;
    more.focus();
    press(more);
    render({ hintsShown: last + 1 });
    expect(button('Another hint')).toBeNull();
    expect(document.activeElement?.textContent).toBe(brief.hints[last]);
  });

  it('folds to its heading while the inspector is open beside it', () => {
    render({ check: { status: 'verdict', verdict: missed } });
    const body = () => container.querySelector<HTMLElement>('.chal-body')!;
    expect(body().hidden).toBe(false);
    render({ check: { status: 'verdict', verdict: missed }, besideInspector: true });
    expect(body().hidden).toBe(true);
    expect(container.querySelector('.chal-chip')?.textContent).toBe('Not yet');
    press(button('Show the brief')!);
    expect(body().hidden).toBe(false);
    // Closing the inspector gives back what the reader had.
    render({ check: { status: 'verdict', verdict: missed }, besideInspector: false });
    expect(body().hidden).toBe(false);
  });

  it('opens folded on a new start when asked to, for a phone', () => {
    render({ focusSignal: 0, foldOnStart: true });
    expect(button('Show the brief')).not.toBeNull();
  });
});
