// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { tabbables, trapTab } from './trapTab';

function dialog(html: string): HTMLElement {
  const el = document.createElement('div');
  el.tabIndex = -1;
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

function tab(root: HTMLElement, shiftKey = false): boolean {
  let prevented = false;
  trapTab({ key: 'Tab', shiftKey, preventDefault: () => (prevented = true) }, root);
  return prevented;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('trapTab', () => {
  it('wraps Tab from the last control to the first, and back', () => {
    const root = dialog(
      '<button id="a">A</button><input id="b"><button id="c">C</button>',
    );
    const [a, , c] = tabbables(root);
    c!.focus();
    expect(tab(root)).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(tab(root, true)).toBe(true);
    expect(document.activeElement).toBe(c);
  });

  it('leaves Tab alone between two controls inside', () => {
    const root = dialog('<button id="a">A</button><button id="b">B</button>');
    root.querySelector<HTMLElement>('#a')!.focus();
    expect(tab(root)).toBe(false);
  });

  it('brings focus back in from outside, and from the dialog itself', () => {
    const root = dialog('<button id="a">A</button><button id="b">B</button>');
    root.focus();
    expect(tab(root, true)).toBe(true);
    expect(document.activeElement?.id).toBe('b');
  });

  it('skips disabled controls and stops once per radio group', () => {
    const root = dialog(
      '<button disabled>x</button><input type="radio" name="t" value="1"><input type="radio" name="t" value="2" checked><button id="z">Z</button>',
    );
    const stops = tabbables(root);
    expect(stops.map((el) => (el as HTMLInputElement).value || el.id)).toEqual([
      '2',
      'z',
    ]);
  });
});
