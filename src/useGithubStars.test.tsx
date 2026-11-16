// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { failedRecently, useGithubStars } from './useGithubStars';

/**
 * A refused star request is remembered for an hour. Uncached, every load
 * asked again, was refused again, and logged a console error each time.
 */

let shown: number | null = null;
function Probe() {
  const count = useGithubStars();
  useEffect(() => {
    shown = count;
  }, [count]);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const HOUR = 60 * 60 * 1000;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  // Let the fetch chain settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function unmount(): void {
  act(() => root.unmount());
  container.remove();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  localStorage.clear();
  shown = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useGithubStars', () => {
  it('does not ask again within the hour after a refusal', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, json: () => null }));
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failedRecently(Date.now())).toBe(true);

    await mount();
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shown).toBeNull();
  });

  it('asks again once the hour is up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(failedRecently(Date.now())).toBe(true);

    vi.setSystemTime(Date.now() + HOUR + 1);
    expect(failedRecently(Date.now())).toBe(false);
    await mount();
    unmount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows and caches a count that arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => ({ stargazers_count: 42 }) }),
      ),
    );
    await mount();
    expect(shown).toBe(42);
    unmount();
    expect(JSON.parse(localStorage.getItem('bs-stars') ?? '{}').count).toBe(42);
    expect(failedRecently(Date.now())).toBe(false);
  });
});
