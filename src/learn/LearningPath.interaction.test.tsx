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
    (b) =>
      b.getAttribute('aria-label') === name ||
      b.textContent?.trim() === name ||
      b.querySelector('.lp-step-name')?.firstChild?.textContent === name,
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

describe('the learning path', () => {
  it('opens from the menu with focus on the step to do next', () => {
    mount();
    const d = openPath();
    expect(document.activeElement?.textContent).toBe('Open Single server');
    expect(d.querySelector('.ex-sub')?.textContent).toBe(
      'Every example and challenge in an order that builds up. You have done 0 of 36.',
    );
    expect(d.querySelector('.lp-step[data-next] .lp-status')?.textContent).toBe(
      'Up next',
    );
  });

  it('loads an example step in place of the design, with undo', () => {
    mount();
    expect(canvasIds()).toEqual(['mine-client', 'mine-svc']);
    const d = openPath();
    press(must('Load balanced', d));
    advance(400);
    const lb = PRESETS.find((p) => p.id === 'load-balanced')!;
    expect(canvasIds()).toEqual(lb.topology.nodes.map((n) => n.id));
    expect(dialog()).toBeNull();
  });

  it('starts a challenge step as the picker does', () => {
    mount();
    const d = openPath();
    press(must('Hold the line', d));
    advance(400);
    expect(document.querySelector('section.chal')?.textContent).toContain(
      'Hold the line',
    );
  });

  it('shows what is done from both stores, in words as well as marks', () => {
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
    const first = d.querySelector('section.lp-track')!;
    expect(first.querySelector('.lp-track-count')?.textContent).toBe('2 of 4 done');
    const statuses = [...first.querySelectorAll('.lp-status')].map(
      (s) => s.textContent,
    );
    expect(statuses).toEqual(['Done', 'Up next', 'Done', '']);
    expect(document.activeElement?.textContent).toBe('Open Load balanced');
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

  it('goes back to the next step without reloading it when it is already open', () => {
    localStorage.clear();
    mount();
    const d = openPath();
    press(must('Back to Single server', d));
    advance(400);
    expect(dialog()).toBeNull();
    expect(document.querySelector('.app-toast')).toBeNull();
  });

  it('works with a finger', () => {
    mount();
    const d = openPath();
    press(must('Open Single server', d), 'touch');
    advance(400);
    const single = PRESETS.find((p) => p.id === 'single-server')!;
    expect(canvasIds()).toEqual(single.topology.nodes.map((n) => n.id));
  });
});
