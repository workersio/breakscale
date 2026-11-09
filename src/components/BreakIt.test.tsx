// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BreakPanel } from './BreakIt';
import {
  closestLine,
  effectSentence,
  goalLine,
  scheduleSentence,
  singlePointLines,
  triedLine,
} from './breakCopy';
import type { Names } from './breakCopy';
import {
  DEFAULT_OPTIONS,
  breakGoals,
  runSearch,
  searchDesign,
  singlePoints,
} from '../sim/breakit';
import type { Attack, SearchProgress } from '../sim/breakit';
import type { Goal } from '../sim/challenge';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';
import type { BreakSearch, BreakView } from '../useBreakSearch';

/**
 * The panel's promises: each state says what it is in words, a verdict
 * takes focus, progress is a real progressbar, Escape stops a search, and
 * the replay buttons do what they say.
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

function press(el: Element): void {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const t: Topology = (() => {
  const p = PRESETS.find((x) => x.id === 'single-server');
  if (!p) throw new Error('single-server');
  return p.topology;
})();
const names: Names = {
  node: (id) => t.nodes.find((n) => n.id === id)?.label ?? id,
  edge: (id) => {
    const e = t.edges.find((x) => x.id === id);
    return e ? `the cable from ${names.node(e.from)} to ${names.node(e.to)}` : id;
  },
};
const goal: Goal = { metric: 'errorRate', max: 1 };
const broke = runSearch(t, goal, DEFAULT_OPTIONS);
const held = runSearch(
  t,
  { metric: 'errorRate', max: 100 },
  {
    ...DEFAULT_OPTIONS,
    kinds: ['slow'],
    maxFaults: 1,
    budget: 3,
  },
);

function fake(view: BreakView, over: Partial<BreakSearch> = {}): BreakSearch {
  return {
    templates: breakGoals(t),
    baselines: null,
    goalId: 'up',
    setGoalId: vi.fn(),
    goal,
    maxOf: () => 1,
    setMax: vi.fn(),
    opts: DEFAULT_OPTIONS,
    setOpts: vi.fn(),
    singlePoints: singlePoints(t),
    view,
    stale: false,
    goalGone: false,
    remembered: [],
    start: vi.fn(),
    stop: vi.fn(),
    keepGoing: vi.fn(),
    backToGoals: vi.fn(),
    remember: vi.fn(),
    ...over,
  };
}

function show(
  search: BreakSearch,
  extra: Partial<Parameters<typeof BreakPanel>[0]> = {},
) {
  const props = {
    search,
    names,
    nodes: t.nodes,
    onClose: vi.fn(),
    onWatch: vi.fn(),
    onReplayLink: vi.fn(),
    watchLine: null,
    ...extra,
  };
  act(() => root.render(<BreakPanel {...props} />));
  return props;
}

const done = (result: typeof broke): BreakView => ({
  status: 'done',
  result,
  design: searchDesign(t),
  goal,
  designSig: 'x',
});

describe('BreakPanel', () => {
  it('offers the goals, the single points and the button', () => {
    show(fake({ status: 'picking' }));
    const text = container.textContent ?? '';
    expect(text).toContain('Can you break it?');
    expect(text).toContain('Keep everyone up');
    expect(text).toContain('Stay fast');
    expect(text).toContain(
      'Every request from Client has to pass through API Server, Database and the cable from API Server to Database.',
    );
    expect(container.querySelector('fieldset legend')?.textContent).toBe(
      'What has to hold',
    );
    const input = container.querySelector('input[type="number"]');
    expect(input?.getAttribute('aria-describedby')).toBeTruthy();
    expect(text).toContain('Try to break it');
  });

  it('lets the goal number be cleared and retyped', () => {
    const search = fake({ status: 'picking' });
    show(search);
    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    if (!input) throw new Error('no number field');
    const type = (text: string) =>
      act(() => {
        const set = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        );
        set?.set?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    type('');
    expect(input.value).toBe('');
    expect(search.setMax).not.toHaveBeenCalled();
    type('3');
    expect(input.value).toBe('3');
    expect(search.setMax).toHaveBeenLastCalledWith('up', 3);
    type('0.5');
    expect(search.setMax).toHaveBeenLastCalledWith('up', 0.5);
    // Left empty, it shows the last number that counted.
    type('');
    act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(input.value).toBe('1');
  });

  it('starts a search from the button', () => {
    const search = fake({ status: 'picking' });
    show(search);
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try to break it',
    );
    if (!button) throw new Error('no button');
    press(button);
    expect(search.start).toHaveBeenCalledTimes(1);
  });

  it('shows progress as a progressbar, and Escape stops it', () => {
    const progress: SearchProgress = {
      phase: 'pair',
      tried: 214,
      budget: 500,
      shrinkTried: 0,
      current: [{ kind: 'slow', target: 'db', factor: 20, atMs: 10_000, forMs: null }],
      closest: null,
      simMs: 0,
      notes: [],
    };
    const search = fake({ status: 'searching', progress });
    show(search);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('214');
    expect(bar?.getAttribute('aria-valuemax')).toBe('500');
    expect(bar?.getAttribute('aria-valuetext')).toBe('214 of 500 tried');
    expect(container.textContent).toContain('Trying two at once');
    expect(container.querySelector('.brk-now')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.textContent).toContain('Now: slow Database 20x');
    const section = container.querySelector('section');
    act(() => {
      section?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(search.stop).toHaveBeenCalledTimes(1);
  });

  it('says where a stopped search got to', () => {
    show(
      fake({
        status: 'stopped',
        progress: {
          phase: 'single',
          tried: 212,
          budget: 500,
          shrinkTried: 0,
          current: [],
          closest: null,
          simMs: 0,
          notes: [],
        },
      }),
    );
    expect(container.textContent).toContain(
      'Stopped after 212 of 500. Nothing broke it yet.',
    );
    expect(container.textContent).toContain('Keep going');
  });

  it('lands a break with focus on its heading, and wires the replay buttons', () => {
    if (broke.status !== 'broke') throw new Error('should break');
    const props = show(fake(done(broke)));
    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Broke it.');
    expect(document.activeElement).toBe(heading);
    const text = container.textContent ?? '';
    expect(text).toContain('Slow Database 5x at 10s for 5s.');
    expect(text).toContain('of requests failed');
    expect(text).toContain('The goal was 1% or less.');
    const byText = (s: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === s);
    press(byText('Watch the replay') as Element);
    expect(props.onWatch).toHaveBeenCalledTimes(1);
    press(byText('Replay link') as Element);
    expect(props.onReplayLink).toHaveBeenCalledTimes(1);
  });

  it('folds to the break and remembers it when asked to fix it', () => {
    if (broke.status !== 'broke') throw new Error('should break');
    const search = fake(done(broke));
    show(search);
    const fix = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try to fix it',
    );
    press(fix as Element);
    expect(search.remember).toHaveBeenCalledWith(broke.attacks);
    expect(container.textContent).toContain('Broke at: Slow Database 5x');
    expect(container.textContent).toContain('Run again');
  });

  it('reports held, with what was tried', () => {
    expect(held.status).toBe('held');
    if (held.status !== 'held') throw new Error('not held');
    show(fake(done({ ...held, budget: 500, tried: 500 })));
    expect(container.querySelector('h2')?.textContent).toBe('Held.');
    expect(container.textContent).toContain('Held across 500 fault schedules.');
    expect(container.textContent).toContain('Try harder');
    show(fake(done({ ...held, budget: 500, tried: 1 })));
    expect(container.textContent).toContain('Held across 1 fault schedule.');
  });

  it('offers Try harder only while more tries are on offer', () => {
    if (held.status !== 'held') throw new Error('not held');
    show(fake(done({ ...held, budget: 1000, tried: 1000 })));
    expect(container.textContent).not.toContain('Try harder');
    // Ran out of new schedules before the budget: more tries find none.
    show(fake(done({ ...held, budget: 500, tried: 120 })));
    expect(container.textContent).not.toContain('Try harder');
  });

  it('says when the answer is out of date', () => {
    show(fake(done(held), { stale: true }));
    expect(container.textContent).toContain('You changed the design after this ran.');
  });
});

describe('break copy', () => {
  it('explains why a backlog counts as broken whatever the goal', () => {
    if (broke.status !== 'broke') throw new Error('not broke');
    const behind = { ...broke.run, outcome: 'falling-behind' as const, keptUp: 0.969 };
    const loose: Goal = { metric: 'errorRate', max: 50 };
    expect(effectSentence(behind, loose, names)).toBe(
      'Between 5s and 35s, requests piled up faster than they finished: 96.9% got an answer and the rest were still waiting.',
    );
    expect(goalLine(loose, behind)).toBe(
      'A backlog that keeps growing fails everything in the end, so this counts as broken whatever the goal.',
    );
    expect(goalLine(loose, broke.run)).toBe('The goal was 50% or less.');
  });

  it('never uses an em dash', () => {
    if (broke.status !== 'broke') throw new Error('should break');
    const attacks: Attack[] = [
      { kind: 'crash', target: 'db', atMs: 10_000, forMs: 500 },
      { kind: 'cut', target: 'api->db', atMs: 10_000, forMs: null },
      { kind: 'errors', target: 'api', rate: 0.5, atMs: 12_000, forMs: 2000 },
      { kind: 'crash-instance', target: 'api', atMs: 15_000, forMs: null },
    ];
    const lines = [
      scheduleSentence(attacks, names),
      effectSentence(broke.run, goal, names),
      closestLine(
        { attacks, actual: 0.8, score: 0.7, outcome: 'passed', pilingUp: false },
        goal,
        names,
      ),
      triedLine([92, 210, 198]),
      ...singlePointLines(singlePoints(t), names),
    ];
    for (const l of lines) expect(l).not.toContain('—');
    // A backlog that came close is named as one, not as its failure figure.
    expect(
      closestLine(
        { attacks, actual: 0.2, score: 0.8, outcome: 'passed', pilingUp: true },
        goal,
        names,
      ),
    ).toMatch(/Requests started to pile up\.$/);
    expect(lines[0]).toBe(
      'Crash Database at 10s for 0.5s and cut the cable from API Server to Database at 10s, then make API Server fail 50% of requests at 12s for 2s, then take down one machine of API Server at 15s.',
    );
  });
});
