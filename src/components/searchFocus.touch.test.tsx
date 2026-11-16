// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Examples } from './Examples';
import { PRESETS } from '../sim/presets';

/**
 * A search field that takes focus as a dialog opens raises a phone's
 * keyboard over the list the reader came to look at. With a finger, the
 * dialog itself takes focus instead; with a mouse, the field still does.
 */

let container: HTMLDivElement;
let root: Root;

function stubPointer(coarse: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function open(): void {
  act(() =>
    root.render(
      <Examples
        open
        onClose={() => {}}
        presets={PRESETS}
        activePresetId={null}
        onLoad={() => {}}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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

describe('examples dialog focus', () => {
  it('focuses the dialog, not the search field, on a touch screen', () => {
    stubPointer(true);
    open();
    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  });

  it('focuses the search field with a mouse', () => {
    stubPointer(false);
    open();
    expect(document.activeElement?.className).toBe('ex-search');
  });
});
