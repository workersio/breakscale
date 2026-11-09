// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../App';
import { PATH_KEY } from './pathProgress';
import { TOUR_KEY } from './tourSteps';

/**
 * The tour mounted in the whole app on a first visit, driven with real
 * pointer sequences: what it promises is about the controls around it.
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

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
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

function button(name: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );
  if (!el) throw new Error(`no button ${name}`);
  return el;
}

const card = () => document.querySelector<HTMLElement>('.tour-card');
const slider = () =>
  document.querySelector<HTMLInputElement>('.traffic-load input[type="range"]');

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

describe('the first-visit tour', () => {
  it('opens on a first visit with focus on it and a ring on the load', () => {
    mount();
    const c = card();
    expect(c?.getAttribute('role')).toBe('dialog');
    expect(document.getElementById('tour-title')?.textContent).toBe(
      'Break it on purpose',
    );
    expect(document.activeElement).toBe(c);
    expect(document.querySelector('[data-tour-ring]')?.className).toBe('traffic-load');
    expect(c?.closest('[data-chrome]')).not.toBeNull();
  });

  it('does not open for a returning visitor', () => {
    localStorage.setItem(
      'breakscale.session.v1',
      JSON.stringify({ topology: { nodes: [], edges: [] }, rps: 50, presetId: null }),
    );
    mount();
    expect(card()).toBeNull();
  });

  it('does not open inside a challenge', () => {
    window.history.replaceState(null, '', '/?challenge=hold-the-line');
    mount();
    expect(document.querySelector('section.chal')).not.toBeNull();
    expect(card()).toBeNull();
  });

  it('sets the load it asks for through the real slider path', () => {
    mount();
    expect(slider()?.getAttribute('aria-valuetext')).toBe('50 requests per second');
    press(button('Set it to 300'), 'touch');
    expect(slider()?.getAttribute('aria-valuetext')).toBe('300 requests per second');
    // Undo takes it back, so the tour's change is an ordinary one.
    press(button('Undo'));
    expect(slider()?.getAttribute('aria-valuetext')).toBe('50 requests per second');
  });

  it('walks load, break, fix and done on the running engine', () => {
    mount();
    press(button('Set it to 300'), 'touch');
    const title = () => document.getElementById('tour-title')?.textContent;
    for (let i = 0; i < 100 && title() !== 'Something filled up'; i += 1) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(title()).toBe('Something filled up');
    expect(card()?.textContent).toMatch(/Database is full: all 6 slots busy/);
    // Turned-away requests do not wait, so the sentence only says every
    // request waits when none is being turned away.
    const said = card()?.textContent ?? '';
    expect(said.includes('Every request now waits')).toBe(
      !said.includes('turning away'),
    );
    expect(document.querySelector('.cv-spotlight')).not.toBeNull();
    press(button('Show me the fix'), 'touch');
    expect(title()).toBe('Give it more room');
    const row = document.querySelector('[data-tour-ring]');
    expect(row?.textContent).toContain('Slots per instance');
    const input = row?.querySelector('input');
    if (!input) throw new Error('no slots field');
    act(() => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      set?.call(input, '12');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let i = 0; i < 300 && title() !== 'Fixed'; i += 1) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    expect(title()).toBe('Fixed');
    // The tour broke and fixed the first example, so the path counts it.
    expect(JSON.parse(localStorage.getItem(PATH_KEY) ?? '{}')).toEqual({
      explored: ['single-server'],
    });
    press(button('Done'));
    expect(card()).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe('1');
  });

  it('skips with a real press, takes its ring away, and never comes back', () => {
    mount();
    press(button('Skip tour'), 'touch');
    expect(card()).toBeNull();
    expect(document.querySelector('[data-tour-ring]')).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe('1');
    act(() => root.unmount());
    container.remove();
    mount();
    expect(card()).toBeNull();
  });

  it('skips on Escape from the card', () => {
    mount();
    act(() => {
      card()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(card()).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe('1');
  });

  it('ends for good when another example is loaded', () => {
    mount();
    press(button('Menu'));
    press(button('Examples'));
    const lb = [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
      b.textContent?.includes('Load balanced'),
    );
    if (!lb) throw new Error('no Load balanced card');
    press(lb);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(card()).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe('1');
  });
});

describe('the load slider from the keyboard', () => {
  it('moves on every arrow press, both ways', () => {
    localStorage.setItem(TOUR_KEY, '1');
    mount();
    const s = slider();
    if (!s) throw new Error('no slider');
    const key = (k: string) =>
      act(() => {
        s.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      key('ArrowRight');
      seen.push(s.getAttribute('aria-valuetext') ?? '');
    }
    key('ArrowLeft');
    seen.push(s.getAttribute('aria-valuetext') ?? '');
    expect(seen).toEqual([
      '55 requests per second',
      '60 requests per second',
      '65 requests per second',
      '60 requests per second',
    ]);
  });
});
