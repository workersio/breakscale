// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Term, TooltipLayer, setGlossaryNavigate } from './Tooltip';
import { setPreference, __resetPreferences } from '../content/preferences';

/**
 * Interaction tests, driven with REAL events.
 *
 * Everything here dispatches genuine PointerEvent / FocusEvent / KeyboardEvent
 * objects rather than calling React props directly, because the behaviours
 * that matter are exactly the ones a synthetic shortcut would paper over:
 * that touch is handled separately from hover, that a delay actually elapses,
 * and that focus and blur are wired to the right things.
 */

let container: HTMLDivElement;
let root: Root;

/** jsdom has no PointerEvent, so provide the parts these tests use. */
class FakePointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

beforeEach(() => {
  // Tooltips ship on, but a stored preference could say otherwise, so the
  // tests pin it rather than lean on the default.
  setPreference('tooltips', true);
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  setGlossaryNavigate(null);
  __resetPreferences();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(ui: React.ReactNode): void {
  act(() => root.render(ui));
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** The single open panel, or null. */
function panel(): HTMLElement | null {
  return document.querySelector('[role="tooltip"]');
}

function trigger(id = 'p99'): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-term="${id}"]`);
  if (!el) throw new Error(`no trigger for ${id}`);
  return el;
}

/**
 * Dispatches the native event a browser actually sends.
 *
 * React does not listen for `pointerenter` / `pointerleave` directly: those
 * do not bubble, so they cannot be delegated at the root. It synthesises them
 * from `pointerover` / `pointerout` instead. Dispatching the enter/leave pair
 * literally reaches no React handler at all — verified, and it is the reason
 * these tests drive the over/out pair.
 */
function pointer(el: Element, type: string, pointerType = 'mouse'): void {
  const native =
    type === 'pointerenter'
      ? 'pointerover'
      : type === 'pointerleave'
        ? 'pointerout'
        : type;
  // React reads relatedTarget to decide whether the pointer genuinely left
  // the element rather than moving to a descendant.
  const relatedTarget = native === 'pointerout' ? document.body : null;
  act(() => {
    el.dispatchEvent(
      new FakePointerEvent(native, { bubbles: true, pointerType, relatedTarget }),
    );
  });
}

function key(el: Element | Document, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

const App = (
  <>
    <Term id="p99">
      <span>1200 ms</span>
    </Term>
    <Term id="rps">
      <span>500</span>
    </Term>
    <TooltipLayer />
  </>
);

describe('hover', () => {
  it('waits the open delay before showing', () => {
    render(App);
    pointer(trigger(), 'pointerenter');
    // Must NOT be open yet: this is what stops a pointer sweeping across the
    // metrics strip from strobing six tooltips on its way past.
    tick(300);
    expect(panel()).toBeNull();
    tick(150);
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain('slowest 1 in 100');
  });

  it('cancels the pending open if the pointer leaves first', () => {
    render(App);
    pointer(trigger(), 'pointerenter');
    tick(200);
    pointer(trigger(), 'pointerleave');
    tick(500);
    expect(panel()).toBeNull();
  });

  it('opens the neighbour immediately inside the grace window', () => {
    render(App);
    pointer(trigger('p99'), 'pointerenter');
    tick(400);
    expect(panel()).not.toBeNull();

    pointer(trigger('p99'), 'pointerleave');
    tick(140); // close delay elapses
    expect(panel()).toBeNull();

    // Moving straight to the adjacent term must not re-impose the full wait.
    pointer(trigger('rps'), 'pointerenter');
    tick(0);
    expect(panel()).not.toBeNull();
    expect(panel()?.textContent).toContain('Requests per second');
  });

  it('holds open while the pointer travels into the panel', () => {
    render(App);
    pointer(trigger(), 'pointerenter');
    tick(400);
    const p = panel();
    expect(p).not.toBeNull();

    pointer(trigger(), 'pointerleave');
    // Within the close delay the pointer reaches the panel.
    tick(80);
    pointer(p as Element, 'pointerenter');
    tick(500);
    // Still open: this is what makes a "see also" link clickable.
    expect(panel()).not.toBeNull();
  });

  it('closes once the pointer leaves the panel too', () => {
    render(App);
    pointer(trigger(), 'pointerenter');
    tick(400);
    pointer(trigger(), 'pointerleave');
    pointer(panel() as Element, 'pointerenter');
    tick(50);
    pointer(panel() as Element, 'pointerleave');
    tick(200);
    expect(panel()).toBeNull();
  });
});

describe('keyboard', () => {
  it('opens immediately on focus, with no delay', () => {
    render(App);
    act(() => trigger().focus());
    // Deliberate navigation: waiting would read as the app being broken.
    tick(0);
    expect(panel()).not.toBeNull();
  });

  it('closes on blur', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    expect(panel()).not.toBeNull();
    act(() => trigger().blur());
    expect(panel()).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(App);
    const t = trigger();
    act(() => t.focus());
    tick(0);
    expect(panel()).not.toBeNull();
    key(document, 'Escape');
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(t);
  });

  it('is not dismissed by a stray pointer leaving the trigger', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    // The mouse happens to be resting on the term and moves away. A keyboard
    // user's tooltip must not vanish because of that.
    pointer(trigger(), 'pointerleave');
    tick(500);
    expect(panel()).not.toBeNull();
  });

  it('toggles with Enter and with Space', () => {
    render(App);
    const t = trigger();
    act(() => t.focus());
    tick(0);
    key(t, 'Enter');
    expect(panel()).toBeNull();
    key(t, 'Enter');
    expect(panel()).not.toBeNull();
    key(t, ' ');
    expect(panel()).toBeNull();
  });

  it('is reachable by Tab', () => {
    render(App);
    expect(trigger().tabIndex).toBe(0);
  });
});

describe('scrolling', () => {
  it('follows the scroll that focusing a term below the fold causes', () => {
    render(App);
    act(() => trigger().focus());
    expect(panel()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(panel()).not.toBeNull();
  });

  it('closes on a scroll the reader makes later', () => {
    render(App);
    act(() => trigger().focus());
    tick(1000);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(panel()).toBeNull();
  });

  it('closes a hover tooltip on any scroll', () => {
    render(App);
    pointer(trigger(), 'pointerenter');
    tick(500);
    expect(panel()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(panel()).toBeNull();
  });
});

describe('touch', () => {
  it('does not open on a touch pointerenter', () => {
    render(App);
    // A tap emits pointerenter first. Opening here would leave the panel
    // stuck open under the finger.
    pointer(trigger(), 'pointerenter', 'touch');
    tick(1000);
    expect(panel()).toBeNull();
  });

  it('opens on tap and closes on a second tap', () => {
    render(App);
    const t = trigger();
    act(() => {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(panel()).not.toBeNull();
    act(() => {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(panel()).toBeNull();
  });

  /*
   * A real press on a focusable span runs pointerdown, focus, then click.
   * Focus opens the tooltip, and the click used to see it open and toggle it
   * shut again, so the first tap on every term did nothing. A bare click
   * with no focus before it, as above, cannot catch that.
   */
  function press(el: HTMLElement, pointerType: 'touch' | 'mouse'): void {
    act(() => {
      el.dispatchEvent(
        new FakePointerEvent('pointerdown', { bubbles: true, pointerType }),
      );
    });
    act(() => el.focus());
    act(() => {
      el.dispatchEvent(
        new FakePointerEvent('pointerup', { bubbles: true, pointerType }),
      );
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
  }

  it('opens on the first real tap and closes on the second', () => {
    render(App);
    const t = trigger();
    press(t, 'touch');
    tick(600);
    expect(panel()).not.toBeNull();
    expect(t.dataset.open).toBe('true');
    press(t, 'touch');
    expect(panel()).toBeNull();
  });

  it('opens on the first real mouse click', () => {
    render(App);
    press(trigger(), 'mouse');
    tick(600);
    expect(panel()).not.toBeNull();
  });

  it('closes on a tap when keyboard focus had already opened it', () => {
    render(App);
    const t = trigger();
    act(() => t.focus());
    expect(panel()).not.toBeNull();
    press(t, 'touch');
    expect(panel()).toBeNull();
  });

  it('pins a hover-opened tooltip on click rather than closing it', () => {
    render(App);
    const t = trigger();
    pointer(t, 'pointerenter');
    tick(500);
    expect(panel()).not.toBeNull();
    // Inside the grace window hover opens with no delay, so the pointer has
    // always opened it by the time the click lands. Closing here read as the
    // click doing nothing.
    press(t, 'mouse');
    pointer(t, 'pointerleave');
    tick(1000);
    expect(panel()).not.toBeNull();
    press(t, 'mouse');
    expect(panel()).toBeNull();
  });

  it('does not let a press dragged off a term steer a later synthesised click', () => {
    render(App);
    const t = trigger();
    // Pressed while closed, then dragged away: no click follows.
    act(() => {
      t.dispatchEvent(
        new FakePointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
      );
    });
    act(() => t.blur());
    // Later, keyboard focus opens it and assistive tech clicks it.
    act(() => t.focus());
    expect(panel()).not.toBeNull();
    act(() => {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    expect(panel()).toBeNull();
  });

  it('closes when the next tap lands elsewhere', () => {
    render(App);
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(panel()).not.toBeNull();
    // No Escape key and no pointerleave on touch, so an outside press is the
    // only way out. It must work.
    act(() => {
      document.body.dispatchEvent(
        new FakePointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'touch',
        }),
      );
    });
    expect(panel()).toBeNull();
  });

  it('survives a tap-opened tooltip losing the pointer', () => {
    render(App);
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    pointer(trigger(), 'pointerleave', 'touch');
    tick(1000);
    expect(panel()).not.toBeNull();
  });
});

describe('content and wiring', () => {
  it('shows term, short and why', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    const text = panel()?.textContent ?? '';
    expect(text).toContain('p99');
    expect(text).toContain('The slowest 1 in 100 requests');
    expect(text).toContain('The number to watch');
  });

  it('offers see-also links only once a navigate handler exists', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    expect(panel()?.querySelectorAll('.tip-see-link').length).toBe(0);

    act(() => root.unmount());
    setGlossaryNavigate(() => {});
    root = createRoot(container);
    render(App);
    act(() => trigger().focus());
    tick(0);
    const links = panel()?.querySelectorAll('.tip-see-link') ?? [];
    expect(links.length).toBe(3); // p50, utilisation, queue-time
  });

  it('a see-also link closes the tooltip and reports the id', () => {
    const seen: string[] = [];
    setGlossaryNavigate((id) => seen.push(id));
    render(App);
    act(() => trigger().focus());
    tick(0);
    const link = panel()?.querySelector<HTMLElement>('.tip-see-link');
    act(() => link?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(seen).toEqual(['p50']);
    expect(panel()).toBeNull();
  });

  it('marks only the open trigger, and unmarks it on close', () => {
    render(App);
    act(() => trigger('p99').focus());
    tick(0);
    expect(trigger('p99').dataset.open).toBe('true');
    expect(trigger('rps').dataset.open).toBeUndefined();
    key(document, 'Escape');
    expect(trigger('p99').dataset.open).toBeUndefined();
  });

  it('shows only one tooltip at a time', () => {
    render(App);
    act(() => trigger('p99').focus());
    tick(0);
    act(() => trigger('rps').focus());
    tick(0);
    expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
    expect(panel()?.textContent).toContain('Requests per second');
  });

  it('renders unknown ids as plain children with no affordance', () => {
    render(
      <>
        <Term id="not-a-real-term">
          <span>hello</span>
        </Term>
        <TooltipLayer />
      </>,
    );
    expect(container.textContent).toContain('hello');
    expect(container.querySelector('.term')).toBeNull();
  });

  it('escapes to closed when the layer unmounts', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    expect(panel()).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    expect(panel()).toBeNull();
  });
});

describe('accessibility wiring', () => {
  it('describes each term with an always-present description node', () => {
    render(App);
    const described = trigger().getAttribute('aria-describedby');
    expect(described).toBe('term-desc-p99');
    // Present even while the tooltip is shut, so a screen reader user learns
    // the explanation exists without having to trigger it.
    const node = document.getElementById('term-desc-p99');
    expect(node).not.toBeNull();
    expect(node?.textContent).toContain('The slowest 1 in 100 requests');
  });

  it('does not fold the description into the accessible name', () => {
    render(App);
    // The description node must be OUTSIDE the trigger, or it would be read
    // twice — once as the name, once as the description.
    expect(trigger().textContent).toBe('1200 ms');
    expect(trigger().querySelector('#term-desc-p99')).toBeNull();
  });

  it('gives the panel role=tooltip', () => {
    render(App);
    act(() => trigger().focus());
    tick(0);
    expect(panel()?.getAttribute('role')).toBe('tooltip');
  });

  it('is not announced as a button', () => {
    render(App);
    expect(trigger().getAttribute('role')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBeNull();
  });

  it('emits one description node per entry, not one per Term instance', () => {
    render(
      <>
        <Term id="p99">a</Term>
        <Term id="p99">b</Term>
        <Term id="p99">c</Term>
        <TooltipLayer />
      </>,
    );
    // Duplicate element ids would be invalid HTML and ambiguous to assistive
    // tech. Three triggers, one shared description.
    expect(document.querySelectorAll('#term-desc-p99').length).toBe(1);
  });
});
