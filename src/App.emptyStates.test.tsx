// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { Designs } from './components/Designs';
import { PRESETS } from './sim/presets';

/**
 * The empty states through the whole app: what a cleared canvas offers and
 * that each offer is a normal, undoable action; what the phone's Inspect tab
 * says before anything is selected; and that Your designs will not save a
 * blank canvas.
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

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactNode = <App />): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

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

function must(name: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  if (!el) throw new Error(`no control named ${name}`);
  return el;
}

const card = () => document.querySelector('.cv-empty');
const nodeIds = () =>
  [...document.querySelectorAll('[data-hit="node"]')].map((n) =>
    n.getAttribute('data-id'),
  );
const toast = () => document.querySelector('.app-toast')?.textContent ?? '';
const dialogTitle = () =>
  [...document.querySelectorAll('[role="dialog"]')]
    .map((d) => d.querySelector('h2')?.textContent)
    .join('|');

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
    JSON.stringify({ topology: { nodes: [], edges: [] }, rps: 0, presetId: null }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('an empty canvas', () => {
  it('offers three starting points, outside the pointer surface', () => {
    mount();
    const c = card();
    expect(c?.querySelector('.cv-empty-lead')?.textContent).toBe('Nothing here yet');
    // [data-chrome] and a sibling of the surface, so it never takes a gesture.
    expect(c?.hasAttribute('data-chrome')).toBe(true);
    expect(c?.closest('.cv-surface')).toBeNull();
    const labels = [...(c?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual([
      'Start with one server',
      'Browse examples',
      'Try a challenge',
    ]);
  });

  it('starts with one server as one undoable step', () => {
    mount();
    press(must('Start with one server'));
    const simple = PRESETS.find((p) => p.id === 'single-server')!;
    expect(nodeIds()).toEqual(simple.topology.nodes.map((n) => n.id));
    expect(card()).toBeNull();

    press(must('Undo'));
    expect(nodeIds()).toEqual([]);
    expect(card()).not.toBeNull();
  });

  it('opens the examples', () => {
    mount();
    expect(dialogTitle()).toBe('');
    press(must('Browse examples'));
    expect(dialogTitle()).toMatch(/example/i);
  });

  it('opens the challenges', () => {
    mount();
    press(must('Try a challenge'));
    expect(dialogTitle()).toMatch(/challenge/i);
  });
});

describe('the phone Inspect tab with nothing selected', () => {
  it('stays pressable and says how to use it', () => {
    mount();
    const tab = must('Inspect');
    expect(tab.disabled).toBe(false);
    expect(tab.getAttribute('aria-disabled')).toBe('true');
    press(tab);
    expect(toast()).toBe('Tap a part on the canvas to see its settings and break it.');
  });
});

describe('Your designs on an empty canvas', () => {
  it('will not save, and says why', () => {
    const onSave = vi.fn();
    const onOpenFile = vi.fn();
    const onClose = vi.fn();
    mount(
      <Designs
        open
        onClose={onClose}
        onOpen={() => {}}
        onSave={onSave}
        suggestedName="Mine"
        canSave={false}
        onOpenFile={onOpenFile}
      />,
    );
    const save = must('Save');
    // Still focusable, so the hint is heard; the press does nothing.
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    press(save);
    expect(onSave).not.toHaveBeenCalled();
    const hint = document.getElementById(save.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Add something to the canvas first.');

    press(must('Open a file'));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves once there is something to save', () => {
    const onSave = vi.fn();
    mount(
      <Designs
        open
        onClose={() => {}}
        onOpen={() => {}}
        onSave={onSave}
        suggestedName="Mine"
      />,
    );
    const save = must('Save');
    expect(save.hasAttribute('aria-disabled')).toBe(false);
    expect(save.hasAttribute('aria-describedby')).toBe(false);
    press(save);
    expect(onSave).toHaveBeenCalledWith('Mine');
  });
});
