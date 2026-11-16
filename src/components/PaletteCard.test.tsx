// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Palette } from './Palette';
import { setGlossaryNavigate } from './Tooltip';
import type { NodeKind } from '../sim/types';

/**
 * The palette's "what is this?" card, driven with real pointer sequences:
 * it must explain a component without changing how one is placed.
 */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary = true;
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
let onAdd: ReturnType<typeof vi.fn<(kind: NodeKind) => void>>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onAdd = vi.fn<(kind: NodeKind) => void>();
  act(() => root.render(<Palette onAdd={onAdd} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  setGlossaryNavigate(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function row(kind: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `.pal-row[data-kind="${kind}"]`,
  );
  if (!el) throw new Error(`no row ${kind}`);
  return el;
}

const card = () => document.querySelector('.pal-card');

function fire(el: Element, type: string, pointerType: string, x = 10, y = 10): void {
  const init = { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y };
  act(() => {
    el.dispatchEvent(
      type.startsWith('pointer')
        ? new FakePointerEvent(type, { ...init, pointerType })
        : new MouseEvent(type, init),
    );
  });
}

/** A tap or click: down, up, click, with `holdMs` between down and up. */
function press(el: Element, pointerType: string, holdMs = 0): void {
  fire(el, 'pointerdown', pointerType);
  fire(el, 'mousedown', pointerType);
  act(() => vi.advanceTimersByTime(holdMs));
  fire(el, 'pointerup', pointerType);
  fire(el, 'mouseup', pointerType);
  fire(el, 'click', pointerType);
}

describe('the palette card', () => {
  it('opens on hover after a short delay with the beginner words', () => {
    const r = row('sidecar');
    fire(r, 'pointerover', 'mouse'); // React builds pointerenter from it
    expect(card()).toBeNull();
    act(() => vi.advanceTimersByTime(450));
    const text = card()?.textContent ?? '';
    expect(text).toContain('Sidecar proxy');
    expect(text).toContain('Example: Envoy');
    expect(text).toContain('When to use it:');
    expect(r.getAttribute('aria-describedby')).toBeTruthy();
    expect(r.getAttribute('title')).toBeNull();
    fire(r, 'pointerout', 'mouse');
    act(() => vi.advanceTimersByTime(200));
    expect(card()).toBeNull();
  });

  it('leaves a click adding the component, and closes for it', () => {
    const r = row('cache');
    fire(r, 'pointerover', 'mouse'); // React builds pointerenter from it
    act(() => vi.advanceTimersByTime(450));
    expect(card()).not.toBeNull();
    press(r, 'mouse');
    expect(onAdd).toHaveBeenCalledWith('cache');
    expect(card()).toBeNull();
  });

  it('a tap still adds, and a long press explains without adding', () => {
    press(row('objectstore'), 'touch', 100);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();

    press(row('objectstore'), 'touch', 600);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(card()?.textContent).toContain('Amazon S3');

    // The next tap is an ordinary one again.
    press(row('replica'), 'touch', 50);
    expect(onAdd).toHaveBeenLastCalledWith('replica');
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it('a long press that moves is a scroll, not a card', () => {
    const r = row('pubsub');
    fire(r, 'pointerdown', 'touch');
    fire(r, 'pointermove', 'touch', 10, 40);
    act(() => vi.advanceTimersByTime(600));
    expect(card()).toBeNull();
  });

  it('Learn more opens the glossary on that entry', () => {
    const go = vi.fn();
    setGlossaryNavigate(go);
    const r = row('sidecar');
    act(() => r.focus());
    const learn = card()?.querySelector('button');
    expect(learn?.textContent).toBe('Learn more');
    act(() => learn?.click());
    expect(go).toHaveBeenCalledWith('sidecar');
    expect(document.activeElement).toBe(r);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
