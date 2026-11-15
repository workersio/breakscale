// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { CHALLENGES_KEY } from '../challengeWorkspace';
import { PRESETS, makeNode } from '../sim/presets';
import { challengeById } from '../sim/challenges';
import type { Topology } from '../sim/types';
import { PATH_KEY } from './pathProgress';

/**
 * The path mounted in the whole app, opened from the menu and from the
 * examples dialog with real presses, because what it promises is about the
 * app around it: a step loads through the same handlers as the gallery and
 * the picker, and what is done is read from the same stores.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = true;
  }
}

const SESSION_KEY = 'breakscale.session.v1';

function ownDesign(): Topology {
  const client = { ...makeNode('client', 0, 0), id: 'mine-client', label: 'My client' };
  const svc = { ...makeNode('service', 240, 0), id: 'mine-svc', label: 'My service' };
  return {
    nodes: [client, svc],
    edges: [{ id: 'mine-client->mine-svc', from: client.id, to: svc.id, weight: 1 }],
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function press(el: Element, pointerType = 'mouse'): void {
  const at = { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 };
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerdown', { ...at, buttons: 1, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent('pointerup', { ...at, buttons: 0, pointerType }),
    );
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, buttons: 0, detail: 1 }));
  });
}

function must(name: string, scope: ParentNode = document): HTMLElement {
  const el = [...scope.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const dialog = () =>
  document.querySelector<HTMLElement>('[aria-labelledby="lp-title"]');

function openPath(): HTMLElement {
  press(must('Menu'));
  press(must('Learning path'));
  const d = dialog();
  if (!d) throw new Error('no learning path dialog');
  return d;
}

const canvasIds = () =>
  [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
    n.getAttribute('data-id'),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ topology: ownDesign(), rps: 50, presetId: null }),
  );
});

afterEach(() => {
  if (container?.isConnected) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const undo = () => must('Undo') as HTMLButtonElement;

/** The row for a step, by its name. */
function row(name: string, scope: ParentNode): HTMLElement {
  const li = [...scope.querySelectorAll<HTMLElement>('li.lp-step')].find(
    (r) => r.querySelector('.lp-step-title')?.textContent === name,
  );
  if (!li) throw new Error(`no row for ${name}`);
  return li;
}

describe('the learning path', () => {
  it('opens from the menu with focus on the step to do next', () => {
    mount();
    const d = openPath();
    expect(document.activeElement?.textContent).toBe('Start Single server');
    expect(d.querySelector('.ex-sub')?.textContent).toBe(
      'Every example, challenge and real outage, in an order that builds up.',
    );
    expect(d.querySelector('.lp-progress')?.textContent).toBe('0 of 39 done');
    // How it counts sits with the step, in words.
    expect(d.querySelector('.lp-next-rule')?.textContent).toBe(
      'A short task opens with it. It counts as done once you finish the task.',
    );
    expect(d.querySelector('.lp-rule')).toBeNull();
    expect(d.querySelectorAll('.btn-primary')).toHaveLength(1);
  });

  it('gives every step one button, named for what it does to which step', () => {
    mount();
    const d = openPath();
    const rows = [...d.querySelectorAll('li.lp-step')];
    expect(rows).toHaveLength(39);
    rows.forEach((r, i) => {
      const buttons = r.querySelectorAll('button');
      expect(buttons).toHaveLength(1);
      const name = r.querySelector('.lp-step-title')!.textContent;
      expect(buttons[0]!.getAttribute('aria-label')).toBe(
        `Start step ${i + 1}, ${name}`,
      );
      expect(buttons[0]!.textContent).toBe('Start');
    });
    // The second step, by the name a screen reader hears.
    expect(must('Start step 2, Load balanced', d)).toBeTruthy();
  });

  it('loads an example step in place of the design, with undo', () => {
    mount();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    const d = openPath();
    press(must('Start step 2, Load balanced', d));
    advance(400);
    const lb = PRESETS.find((p) => p.id === 'load-balanced')!;
    expect(canvasIds()).toEqual(lb.topology.nodes.map((n) => n.id));
    expect(dialog()).toBeNull();
    expect(undo().disabled).toBe(false);
  });

  it('starts a challenge step as the picker does', () => {
    mount();
    const d = openPath();
    press(must('Start step 3, Hold the line', d));
    advance(400);
    expect(dialog()).toBeNull();
    expect(document.querySelector('section.chal')?.textContent).toContain(
      'Hold the line',
    );
  });

  it('starts the next step from the Up next box', () => {
    mount();
    const d = openPath();
    press(must('Start Single server', d));
    advance(400);
    expect(dialog()).toBeNull();
    const single = PRESETS.find((p) => p.id === 'single-server')!;
    expect(canvasIds()).toEqual(single.topology.nodes.map((n) => n.id));
  });

  it('shows what is done from both stores, as words that are not buttons', () => {
    localStorage.setItem(PATH_KEY, JSON.stringify({ explored: ['single-server'] }));
    localStorage.setItem(
      CHALLENGES_KEY,
      JSON.stringify({
        active: null,
        attempts: {},
        progress: {
          'hold-the-line': {
            version: challengeById('hold-the-line')!.version,
            passedAt: '2026-11-01T00:00:00Z',
            hintsUsed: 0,
          },
        },
      }),
    );
    mount();
    const d = openPath();
    expect(d.querySelector('.lp-progress')?.textContent).toBe('2 of 39 done');
    const first = d.querySelector('section.lp-track')!;
    expect(first.querySelector('.lp-track-count')?.textContent).toBe('2 of 4 done');
    const badges = [...first.querySelectorAll('.lp-badge')].map((s) => s.textContent);
    expect(badges).toEqual(['Done', 'Done']);
    for (const b of d.querySelectorAll('.lp-badge')) {
      expect(b.tagName).toBe('SPAN');
      expect(b.closest('button')).toBeNull();
    }
    const verbs = [...first.querySelectorAll('li.lp-step button')].map(
      (b) => b.textContent,
    );
    expect(verbs).toEqual(['Again', 'Start', 'Open', 'Start']);
    expect(document.activeElement?.textContent).toBe('Start Load balanced');
  });

  it('reloads a done example fresh from Again', () => {
    localStorage.setItem(PATH_KEY, JSON.stringify({ explored: ['single-server'] }));
    mount();
    expect(undo().disabled).toBe(true);
    const d = openPath();
    press(must('Do step 1 again, Single server', d));
    advance(400);
    expect(dialog()).toBeNull();
    const single = PRESETS.find((p) => p.id === 'single-server')!;
    expect(canvasIds()).toEqual(single.topology.nodes.map((n) => n.id));
    expect(undo().disabled).toBe(false);
  });

  it('continues the step already open without loading it again', () => {
    localStorage.clear();
    mount();
    const before = canvasIds();
    expect(undo().disabled).toBe(true);
    const d = openPath();
    // The first visit opens the first example: the path says so, once.
    const current = row('Single server', d);
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.querySelector('.lp-badge')?.textContent).toBe('Current');
    expect(d.querySelectorAll('.lp-badge[data-badge="current"]')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe('Continue Single server');
    expect(d.querySelector('.lp-next-where')?.textContent).toBe(
      'It is open behind this dialog.',
    );
    press(must('Continue step 1, Single server', d));
    advance(400);
    expect(dialog()).toBeNull();
    expect(canvasIds()).toEqual(before);
    expect(undo().disabled).toBe(true);
    expect(document.querySelector('.app-toast')).toBeNull();
  });

  it('continues from the Up next box without loading it again', () => {
    localStorage.clear();
    mount();
    const d = openPath();
    press(must('Continue Single server', d));
    advance(400);
    expect(dialog()).toBeNull();
    expect(undo().disabled).toBe(true);
    expect(document.querySelector('.app-toast')).toBeNull();
  });

  it('continues a brief on the canvas, keeping its attempt', () => {
    mount();
    press(must('Start step 3, Hold the line', openPath()));
    advance(400);
    const ids = canvasIds();
    const d = openPath();
    expect(row('Hold the line', d).querySelector('.lp-badge')?.textContent).toBe(
      'Current',
    );
    press(must('Continue step 3, Hold the line', d));
    advance(400);
    expect(dialog()).toBeNull();
    expect(canvasIds()).toEqual(ids);
    expect(document.querySelector('section.chal')?.textContent).toContain(
      'Hold the line',
    );
  });

  it('closes on Escape and gives focus back to the menu button', () => {
    mount();
    const menu = must('Menu');
    // A synthetic press does not move focus the way a real one does.
    act(() => menu.focus());
    openPath();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    advance(400);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it('opens from the examples dialog too', () => {
    mount();
    press(must('Menu'));
    press(must('Examples'));
    press(
      must('Learning path', document.querySelector('[aria-labelledby="ex-title"]')!),
    );
    advance(400);
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('[aria-labelledby="ex-title"]')).toBeNull();
  });

  it('works with a finger', () => {
    mount();
    const d = openPath();
    press(must('Start step 2, Load balanced', d), 'touch');
    advance(400);
    const lb = PRESETS.find((p) => p.id === 'load-balanced')!;
    expect(canvasIds()).toEqual(lb.topology.nodes.map((n) => n.id));
  });
});
