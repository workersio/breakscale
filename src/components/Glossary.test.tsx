// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Glossary } from './Glossary';
import { CATEGORY_LABEL, GLOSSARY } from '../content/glossary';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom implements neither.
  Element.prototype.scrollIntoView = vi.fn();
  if (!('escape' in CSS)) {
    (CSS as unknown as { escape: (s: string) => string }).escape = (s) =>
      s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function render(ui: React.ReactNode): void {
  act(() => root.render(ui));
}

function sheet(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function search(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.gl-search-input');
  if (!el) throw new Error('no search input');
  return el;
}

function entries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.gl-entry')];
}

function entryIds(): string[] {
  return entries().map((e) => e.dataset.entry ?? '');
}

function type(value: string): void {
  const input = search();
  act(() => {
    // Drive the value through the native setter so React's onChange fires,
    // which is what a real keystroke does.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  });
}

describe('rendering', () => {
  it('renders nothing at all when shut', () => {
    render(<Glossary open={false} onClose={() => {}} />);
    expect(sheet()).toBeNull();
    expect(document.querySelector('.gl-root')).toBeNull();
  });

  it('lists every entry with an empty query', () => {
    render(<Glossary open onClose={() => {}} />);
    expect(entries().length).toBe(GLOSSARY.length);
  });

  it('groups entries under their category labels', () => {
    render(<Glossary open onClose={() => {}} />);
    const headings = [...document.querySelectorAll('.gl-section-title')].map(
      (h) => h.textContent,
    );
    // Every heading shown is a real category label, and units lead.
    for (const h of headings) {
      expect(Object.values(CATEGORY_LABEL)).toContain(h);
    }
    expect(headings[0]).toBe(CATEGORY_LABEL.unit);
  });

  it('shows term, short and why for an entry', () => {
    render(<Glossary open onClose={() => {}} />);
    const el = entries().find((e) => e.dataset.entry === 'p99');
    const text = el?.textContent ?? '';
    expect(text).toContain('p99');
    expect(text).toContain('The slowest 1 in 100 requests');
    expect(text).toContain('The number to watch');
  });
});

describe('search', () => {
  it('filters as you type and ranks the exact term first', () => {
    render(<Glossary open onClose={() => {}} />);
    type('p99');
    const ids = entryIds();
    expect(ids.length).toBeLessThan(GLOSSARY.length);
    expect(ids[0]).toBe('p99');
  });

  it('matches aliases, so a student can search the words they know', () => {
    render(<Glossary open onClose={() => {}} />);
    type('median');
    expect(entryIds()[0]).toBe('p50');
    type('tail latency');
    expect(entryIds()[0]).toBe('p99');
  });

  it('reports the result count', () => {
    render(<Glossary open onClose={() => {}} />);
    expect(document.querySelector('.gl-count')?.textContent).toBe(
      `${GLOSSARY.length} terms`,
    );
    type('p99');
    const shown = entries().length;
    expect(document.querySelector('.gl-count')?.textContent).toBe(
      `${shown} of ${GLOSSARY.length} terms`,
    );
  });

  it('offers a way back when nothing matches', () => {
    render(<Glossary open onClose={() => {}} />);
    type('zzzzzz');
    expect(entries().length).toBe(0);
    const text = document.querySelector('.gl-list')?.textContent ?? '';
    expect(text).toContain('No term matches');
    // It says what to do next rather than just reporting failure.
    expect(text).toContain('clear the search');
  });

  it('clears with the clear button and restores the full list', () => {
    render(<Glossary open onClose={() => {}} />);
    type('p99');
    const clear = document.querySelector<HTMLElement>('.gl-search-clear');
    expect(clear).not.toBeNull();
    act(() => clear?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(entries().length).toBe(GLOSSARY.length);
    expect(document.activeElement).toBe(search());
  });

  it('shows no clear button when the query is empty', () => {
    render(<Glossary open onClose={() => {}} />);
    expect(document.querySelector('.gl-search-clear')).toBeNull();
  });

  it('focuses the search box on open', () => {
    render(<Glossary open onClose={() => {}} />);
    expect(document.activeElement).toBe(search());
  });

  it('does not resume a stale search on reopen', () => {
    render(<Glossary open onClose={() => {}} />);
    type('p99');
    render(<Glossary open={false} onClose={() => {}} />);
    // The sheet now stays mounted through its exit animation and resets its
    // search at unmount. jsdom runs no CSS animations, so deliver the
    // animationend the exit would fire; presence unmounts on it, exactly as
    // in a browser.
    act(() => {
      sheet()?.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    render(<Glossary open onClose={() => {}} />);
    expect(search().value).toBe('');
    expect(entries().length).toBe(GLOSSARY.length);
  });
});

describe('focusId', () => {
  it('marks the requested entry on open', () => {
    render(<Glossary open onClose={() => {}} focusId="utilisation" />);
    const el = entries().find((e) => e.dataset.entry === 'utilisation');
    expect(el?.className).toContain('is-landed');
    expect(el?.className).toContain('is-active');
  });

  it('scrolls the requested entry into view', () => {
    render(<Glossary open onClose={() => {}} focusId="region" />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('ignores an unknown id rather than blanking the list', () => {
    render(<Glossary open onClose={() => {}} focusId="not-real" />);
    expect(entries().length).toBe(GLOSSARY.length);
    expect(document.querySelector('.is-landed')).toBeNull();
  });
});

describe('cross references', () => {
  it('navigates to the referenced entry within the panel', () => {
    render(<Glossary open onClose={() => {}} />);
    const p99 = entries().find((e) => e.dataset.entry === 'p99');
    const link = [...(p99?.querySelectorAll<HTMLElement>('.gl-see-link') ?? [])].find(
      (b) => b.textContent === 'Utilisation',
    );
    expect(link).toBeDefined();
    act(() => link?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const target = entries().find((e) => e.dataset.entry === 'utilisation');
    expect(target?.className).toContain('is-landed');
  });

  it('clears an active filter so the target is actually visible', () => {
    render(<Glossary open onClose={() => {}} />);
    // Filter down to p99 only, then follow a link OUT of that filter. Without
    // clearing the query the target would be filtered away the instant it was
    // asked for, and the click would appear to do nothing.
    type('p99');
    const link = [...document.querySelectorAll<HTMLElement>('.gl-see-link')].find(
      (b) => b.textContent === 'Queue time',
    );
    expect(link).toBeDefined();
    act(() => link?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(search().value).toBe('');
    const target = entries().find((e) => e.dataset.entry === 'queue-time');
    expect(target).toBeDefined();
    expect(target?.className).toContain('is-landed');
  });
});

describe('keyboard', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Glossary open onClose={onClose} />);
    key(search(), 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves through results with the arrow keys', () => {
    render(<Glossary open onClose={() => {}} />);
    const ids = entryIds();
    key(search(), 'ArrowDown');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[0],
    );
    key(search(), 'ArrowDown');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[1],
    );
    key(search(), 'ArrowUp');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[0],
    );
  });

  it('clamps at both ends instead of wrapping', () => {
    render(<Glossary open onClose={() => {}} />);
    const ids = entryIds();
    // Up from nothing selects the last entry, then cannot go further down
    // past the end.
    key(search(), 'ArrowUp');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[ids.length - 1],
    );
    key(search(), 'ArrowDown');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[ids.length - 1],
    );
  });

  it('Enter from the search box jumps to the top hit', () => {
    render(<Glossary open onClose={() => {}} />);
    type('utilis');
    key(search(), 'Enter');
    const el = entries().find((e) => e.dataset.entry === 'utilisation');
    expect(el?.className).toContain('is-landed');
    // The query is cleared, so the reader sees the entry in its full context.
    expect(search().value).toBe('');
  });

  it('scrolls the selection into view as it moves', () => {
    render(<Glossary open onClose={() => {}} />);
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
    key(search(), 'ArrowDown');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('leaves Home and End to the caret while typing', () => {
    render(<Glossary open onClose={() => {}} />);
    key(search(), 'Home');
    // No selection: Home in a text field means "start of my text".
    expect(document.querySelector('.is-active')).toBeNull();
  });

  it('Home and End jump the list from outside the search box', () => {
    render(<Glossary open onClose={() => {}} />);
    const ids = entryIds();
    const list = document.querySelector('.gl-list');
    if (!list) throw new Error('no list');
    key(list, 'End');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[ids.length - 1],
    );
    key(list, 'Home');
    expect(document.querySelector('.is-active')?.getAttribute('data-entry')).toBe(
      ids[0],
    );
  });

  it('drops a stale selection when the query changes', () => {
    render(<Glossary open onClose={() => {}} />);
    key(search(), 'ArrowDown');
    expect(document.querySelector('.is-active')).not.toBeNull();
    // The selected entry is almost certainly filtered out now; keeping it
    // would make the next arrow press jump somewhere arbitrary.
    type('region');
    expect(document.querySelector('.is-active')).toBeNull();
  });
});

describe('focus management', () => {
  it('traps Tab inside the sheet', () => {
    render(<Glossary open onClose={() => {}} />);
    const s = sheet();
    if (!s) throw new Error('no sheet');
    const focusables = s.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) throw new Error('no focusables');

    act(() => first.focus());
    key(first, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);

    act(() => last.focus());
    key(last, 'Tab');
    expect(document.activeElement).toBe(first);
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    render(<Glossary open onClose={() => {}} />);
    expect(document.activeElement).toBe(search());

    render(<Glossary open={false} onClose={() => {}} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('is a labelled modal dialog', () => {
    render(<Glossary open onClose={() => {}} />);
    const s = sheet();
    expect(s?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = s?.getAttribute('aria-labelledby');
    expect(labelledBy).toBe('gl-title');
    expect(document.getElementById('gl-title')?.textContent).toBe('Glossary');
  });

  it('announces the changing result count politely', () => {
    render(<Glossary open onClose={() => {}} />);
    expect(document.querySelector('.gl-count')?.getAttribute('aria-live')).toBe(
      'polite',
    );
  });
});

describe('closing', () => {
  it('closes on the close button', () => {
    const onClose = vi.fn();
    render(<Glossary open onClose={onClose} />);
    const btn = document.querySelector<HTMLElement>('[aria-label="Close"]');
    act(() => btn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a scrim click', () => {
    const onClose = vi.fn();
    render(<Glossary open onClose={onClose} />);
    const scrim = document.querySelector<HTMLElement>('.gl-scrim');
    act(() => scrim?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('layout safety', () => {
  it('never makes the page itself scrollable', () => {
    render(<Glossary open onClose={() => {}} />);
    // The whole surface is fixed to the viewport; only .gl-list scrolls, and
    // it does so inside itself. Nothing is appended into the app's own tree.
    expect(document.querySelector('.gl-root')?.parentElement).toBe(document.body);
    expect(container.querySelector('.gl-root')).toBeNull();
  });
});
