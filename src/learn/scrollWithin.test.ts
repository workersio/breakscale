// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { scrollWithin } from './scrollWithin';

/**
 * The tour's step 3 brings the slots field into view. It must scroll the
 * inspector's own list and never the app shell, which is overflow:hidden
 * only to clip: scrolled, it slid every panel up under the top bar.
 */

function box(overflowY: string, top: number, height: number, scrollHeight: number) {
  const el = document.createElement('div');
  el.style.overflowY = overflowY;
  Object.defineProperty(el, 'clientHeight', { value: height });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
  el.getBoundingClientRect = () => ({ top, height }) as DOMRect;
  return el;
}

describe('scrollWithin', () => {
  it('centres the target in the nearest scrolling list and leaves the shell alone', () => {
    const shell = box('hidden', 0, 800, 813);
    const list = box('auto', 100, 400, 1600);
    const field = document.createElement('div');
    field.getBoundingClientRect = () => ({ top: 900, height: 60 }) as DOMRect;
    list.appendChild(field);
    shell.appendChild(list);
    document.body.appendChild(shell);

    scrollWithin(field);
    // 900 - 100 - (400 - 60) / 2 = 630
    expect(list.scrollTop).toBe(630);
    expect(shell.scrollTop).toBe(0);
    shell.remove();
  });

  it('does nothing when no ancestor scrolls', () => {
    const shell = box('hidden', 0, 800, 813);
    const field = document.createElement('div');
    shell.appendChild(field);
    document.body.appendChild(shell);
    scrollWithin(field);
    expect(shell.scrollTop).toBe(0);
    shell.remove();
  });
});
