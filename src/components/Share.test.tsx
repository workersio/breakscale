// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Share, type ShareState } from './Share';

/* ------------------------------------------------------------------ *
 * The share dialog with and without a run worth replaying. Without one,
 * the dialog has to be the one it always was: one Generate link button.
 * ------------------------------------------------------------------ */

class FakePointerEvent extends MouseEvent {
  pointerId = 1;
  pointerType = 'mouse';
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
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** pointerdown, mousedown, pointerup, mouseup, click, as a browser sends them. */
function press(el: Element): void {
  const at = { bubbles: true, cancelable: true, button: 0 };
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerdown', { ...at, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
  });
  act(() => {
    el.dispatchEvent(new FakePointerEvent('pointerup', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
  });
}

function buttons(): string[] {
  return Array.from(document.querySelectorAll('.sh-card button'))
    .map((b) => b.textContent ?? '')
    .filter((t) => t !== '');
}

function button(name: string): Element {
  const b = Array.from(document.querySelectorAll('.sh-card button')).find(
    (x) => x.textContent === name,
  );
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

function render(
  state: ShareState,
  extra: { replayable?: boolean; onShareReplay?: () => void } = {},
) {
  const onShare = vi.fn();
  act(() =>
    root.render(
      <Share
        open
        state={state}
        onClose={() => {}}
        onShare={onShare}
        onExport={() => {}}
        {...extra}
      />,
    ),
  );
  return onShare;
}

describe('Share', () => {
  it('offers the design link alone when the run has no faults', () => {
    render({ status: 'idle' }, { replayable: false, onShareReplay: () => {} });
    expect(buttons()).toEqual(['Generate link', 'Save to a file']);
    expect(document.body.textContent).not.toContain('replay');
  });

  it('offers a replay link once the run has faults, and each button builds its own', () => {
    const onShareReplay = vi.fn();
    const onShare = render({ status: 'idle' }, { replayable: true, onShareReplay });
    expect(buttons()).toEqual([
      'Generate replay link',
      'Generate link',
      'Save to a file',
    ]);
    press(button('Generate replay link'));
    expect(onShareReplay).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();
    press(button('Generate link'));
    expect(onShare).toHaveBeenCalledTimes(1);
  });

  it('names a replay link as one when it is ready', () => {
    render(
      { status: 'ready', url: 'https://breakscale.tech/#d3.x', replay: true },
      { replayable: true, onShareReplay: () => {} },
    );
    expect(buttons()).toContain('Copy replay link');
    expect(document.querySelector('.sh-url')?.getAttribute('aria-label')).toBe(
      'Link to this replay',
    );
  });

  it('retries the link that failed', () => {
    const onShareReplay = vi.fn();
    const onShare = render(
      { status: 'failed', message: 'nope', replay: true },
      { replayable: true, onShareReplay },
    );
    press(button('Try again'));
    expect(onShareReplay).toHaveBeenCalledTimes(1);
    expect(onShare).not.toHaveBeenCalled();
  });
});
