// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Health } from './format';
import {
  EMPTY_SETTLED,
  IDLE_SETTLE_MS,
  SETTLE_SNAPSHOTS,
  settleHealth,
  settleMap,
  useSettledHealth,
  useSettledHealthMap,
  type HealthTrack,
} from './settledHealth';

/**
 * Health colours step up at once and down only after the lower state has
 * held for SETTLE_SNAPSHOTS snapshots. The flapping sequence is the one measured on
 * hold-the-line, where the API server alternated ok and warn every tick.
 */

/** What is painted for each raw health, one snapshot each. */
function paint(raws: readonly Health[]): Health[] {
  let t: HealthTrack | undefined;
  return raws.map((h, i) => {
    t = settleHealth(t, h, i > 0);
    return t.shown;
  });
}

function rep(h: Health, n: number): Health[] {
  return Array.from({ length: n }, () => h);
}

/** Class changes a viewer would see over a painted sequence. */
function flips(seq: readonly Health[]): number {
  let n = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) n++;
  return n;
}

describe('settleHealth', () => {
  it('holds warn through a value flapping on its threshold', () => {
    const raw: Health[] = [];
    for (let i = 0; i < 60; i++) raw.push(i % 2 === 0 ? 'ok' : 'warn');
    expect(flips(raw)).toBe(59);
    const shown = paint(raw);
    expect(shown.slice(1).every((h) => h === 'warn')).toBe(true);
    expect(flips(shown)).toBe(1);
  });

  it('applies a worse state on the snapshot it arrives', () => {
    expect(paint(['ok', 'danger'])).toEqual(['ok', 'danger']);
    expect(paint(['ok', 'warn', 'danger'])).toEqual(['ok', 'warn', 'danger']);
  });

  it(`steps down only after ${SETTLE_SNAPSHOTS} snapshots in a row`, () => {
    const calm = rep('ok', SETTLE_SNAPSHOTS);
    expect(paint(['warn', ...calm, 'ok'])).toEqual([
      ...rep('warn', SETTLE_SNAPSHOTS),
      'ok',
      'ok',
    ]);
    // A relapse one snapshot short of settling restarts the count.
    const short = rep('ok', SETTLE_SNAPSHOTS - 1);
    expect(paint(['warn', ...short, 'warn', ...calm])).toEqual([
      ...rep('warn', 2 * SETTLE_SNAPSHOTS),
      'ok',
    ]);
  });

  it('steps down to the worst state seen while calming, not past it', () => {
    const calm = rep('ok', SETTLE_SNAPSHOTS - 1);
    expect(paint(['danger', 'warn', ...calm, ...rep('ok', SETTLE_SNAPSHOTS)])).toEqual([
      ...rep('danger', SETTLE_SNAPSHOTS),
      ...rep('warn', SETTLE_SNAPSHOTS),
      'ok',
    ]);
  });

  it('takes an edit at once when no new snapshot has arrived', () => {
    const t = settleHealth(undefined, 'warn', false);
    expect(settleHealth(t, 'ok', false).shown).toBe('ok');
    // And returns the same track when nothing changed, so a re-render is free.
    expect(settleHealth(t, 'warn', false)).toBe(t);
  });
});

describe('settleMap', () => {
  const m = (entries: [string, Health][]) => new Map(entries);

  it('keeps one track per node and drops removed nodes', () => {
    let s = settleMap(
      EMPTY_SETTLED,
      m([
        ['a', 'warn'],
        ['b', 'ok'],
      ]),
      100,
    );
    s = settleMap(
      s,
      m([
        ['a', 'ok'],
        ['b', 'warn'],
      ]),
      200,
    );
    expect(s.shown.get('a')).toBe('warn');
    expect(s.shown.get('b')).toBe('warn');
    s = settleMap(s, m([['b', 'ok']]), 300);
    expect([...s.shown.keys()]).toEqual(['b']);
  });

  it('returns the same state for the same snapshot and inputs', () => {
    const s = settleMap(EMPTY_SETTLED, m([['a', 'warn']]), 100);
    expect(settleMap(s, m([['a', 'warn']]), 100)).toBe(s);
    const none = settleMap(EMPTY_SETTLED, m([['a', 'ok']]), null);
    expect(settleMap(none, m([['a', 'ok']]), null)).toBe(none);
  });

  it('forgets everything when time goes backwards', () => {
    let s = settleMap(EMPTY_SETTLED, m([['a', 'danger']]), 5000);
    s = settleMap(s, m([['a', 'ok']]), 100);
    expect(s.shown.get('a')).toBe('ok');
  });
});

describe('the hooks', () => {
  let container: HTMLDivElement;
  let root: Root;
  const seen: string[] = [];

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    seen.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function One({ raw, tick }: { raw: Health; tick: number }) {
    const h = useSettledHealth(raw, tick);
    useLayoutEffect(() => {
      seen.push(h);
    });
    return null;
  }

  function Many({ raw, tick }: { raw: ReadonlyMap<string, Health>; tick: number }) {
    const h = useSettledHealthMap(raw, tick);
    useLayoutEffect(() => {
      seen.push(h.get('a') ?? '-');
    });
    return null;
  }

  it('settles across commits under StrictMode without looping', () => {
    const raws: Health[] = ['ok', 'warn', 'ok', 'warn', ...rep('ok', SETTLE_SNAPSHOTS)];
    raws.forEach((raw, i) =>
      act(() =>
        root.render(
          <StrictMode>
            <One raw={raw} tick={(i + 1) * 100} />
          </StrictMode>,
        ),
      ),
    );
    // A re-render with nothing new (a hover, say) changes nothing.
    act(() =>
      root.render(
        <StrictMode>
          <One raw="ok" tick={raws.length * 100} />
        </StrictMode>,
      ),
    );
    expect(seen.filter((_, i, a) => i === 0 || a[i - 1] !== seen[i])).toEqual([
      'ok',
      'warn',
      'ok',
    ]);
    expect(seen[seen.length - 1]).toBe('ok');
  });

  it('settles a map the same way', () => {
    const raws: Health[] = ['warn', ...rep('ok', SETTLE_SNAPSHOTS)];
    const committed: string[] = [];
    raws.forEach((raw, i) => {
      act(() => root.render(<Many raw={new Map([['a', raw]])} tick={(i + 1) * 100} />));
      committed.push(seen[seen.length - 1] ?? '');
    });
    expect(committed).toEqual([...rep('warn', SETTLE_SNAPSHOTS), 'ok']);
  });

  describe('paused inside the calm run', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('lands the all-clear once snapshots stop', () => {
      act(() => root.render(<One raw="danger" tick={100} />));
      act(() => root.render(<One raw="ok" tick={200} />));
      expect(seen[seen.length - 1]).toBe('danger');
      // Paused: re-renders with no new snapshot, then a quiet second.
      act(() => root.render(<One raw="ok" tick={200} />));
      act(() => vi.advanceTimersByTime(IDLE_SETTLE_MS - 1));
      expect(seen[seen.length - 1]).toBe('danger');
      act(() => vi.advanceTimersByTime(1));
      expect(seen[seen.length - 1]).toBe('ok');
    });

    it('does the same for a map', () => {
      act(() => root.render(<Many raw={new Map([['a', 'warn']])} tick={100} />));
      act(() => root.render(<Many raw={new Map([['a', 'ok']])} tick={200} />));
      expect(seen[seen.length - 1]).toBe('warn');
      act(() => vi.advanceTimersByTime(IDLE_SETTLE_MS));
      expect(seen[seen.length - 1]).toBe('ok');
    });

    it('never fires while snapshots keep arriving', () => {
      act(() => root.render(<One raw="warn" tick={100} />));
      for (let i = 1; i < SETTLE_SNAPSHOTS; i++) {
        act(() => root.render(<One raw="ok" tick={100 + i * 100} />));
        act(() => vi.advanceTimersByTime(100));
      }
      expect(seen[seen.length - 1]).toBe('warn');
    });
  });
});

describe('motion in the stylesheets', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const app = read('../App.css');
  const canvas = read('./Canvas.css');
  const inspector = read('./Inspector.css');
  const metrics = read('./Metrics.css');

  it('declares each sheet keyframe once', () => {
    for (const name of ['app-sheet-in', 'app-sheet-out']) {
      expect(app.split(`@keyframes ${name} `).length - 1).toBe(1);
    }
  });

  it('never transitions a meter width, which would lag the number beside it', () => {
    for (const css of [canvas, inspector, metrics]) {
      expect(css).not.toMatch(/transition:[^;]*(?<![-\w])width\b/);
    }
  });

  it('turns the status mark fade off under reduced motion', () => {
    const at = canvas.indexOf(
      '.cv-node-ring,\n  .cv-node-mark {\n    animation: none;',
    );
    expect(at).toBeGreaterThan(
      canvas.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
  });
});
