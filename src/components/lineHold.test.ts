import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINES,
  flushLines,
  rawLine,
  stepLine,
  stepLines,
  type LineState,
  type LineTrack,
} from './lineHold';
import { SETTLE_SNAPSHOTS } from './settledHealth';

function run(seq: readonly LineState[], start?: LineTrack): LineState[] {
  let t = start;
  const shown: LineState[] = [];
  for (const raw of seq) {
    t = stepLine(t, raw, t !== undefined);
    shown.push(t.shown);
  }
  return shown;
}

describe('rawLine', () => {
  it('reads nobody waiting, a line, and a full line turning calls away', () => {
    expect(rawLine(0, 64, 0)).toBe('none');
    expect(rawLine(3, 64, 0)).toBe('waiting');
    expect(rawLine(64, 64, 312)).toBe('refusing');
    // No limit means no line to draw against.
    expect(rawLine(3, 0, 0)).toBe('none');
    // Turned away with nobody left waiting: the bar has nothing to show.
    expect(rawLine(0, 64, 5)).toBe('none');
  });
});

describe('stepLine', () => {
  it('shows a line only once it has held for the settle run', () => {
    const shown = run(['none', ...Array<LineState>(SETTLE_SNAPSHOTS).fill('waiting')]);
    expect(shown.slice(0, SETTLE_SNAPSHOTS)).toEqual(
      Array<LineState>(SETTLE_SNAPSHOTS).fill('none'),
    );
    expect(shown[SETTLE_SNAPSHOTS]).toBe('waiting');
  });

  it('shows refusing at once', () => {
    expect(run(['none', 'refusing'])).toEqual(['none', 'refusing']);
  });

  it('steps down only after the settle run, to the worst seen in it', () => {
    const calm: LineState[] = ['waiting', 'none', 'none', 'waiting', 'none'];
    const shown = run(['refusing', ...calm]);
    expect(shown.slice(0, SETTLE_SNAPSHOTS)).toEqual(
      Array<LineState>(SETTLE_SNAPSHOTS).fill('refusing'),
    );
    expect(shown[SETTLE_SNAPSHOTS]).toBe('waiting');
  });

  it('does not blink on a line hovering between 0 and 2', () => {
    // A server near its limit: waiting every other snapshot, for 10s.
    const seq: LineState[] = [];
    for (let i = 0; i < 100; i++) seq.push(i % 2 ? 'waiting' : 'none');
    let changes = 0;
    const shown = run(seq);
    for (let i = 1; i < shown.length; i++) if (shown[i] !== shown[i - 1]) changes++;
    expect(changes).toBe(0);

    // Bursts of three: still under one change a second.
    const bursty: LineState[] = [];
    for (let i = 0; i < 100; i++) bursty.push(i % 6 < 3 ? 'waiting' : 'none');
    const b = run(bursty);
    let bChanges = 0;
    for (let i = 1; i < b.length; i++) if (b[i] !== b[i - 1]) bChanges++;
    expect(bChanges).toBeLessThan(10);
  });

  it('takes an edit while paused as it is', () => {
    const t = stepLine(undefined, 'none', false);
    expect(stepLine(t, 'waiting', false).shown).toBe('waiting');
  });
});

describe('stepLines', () => {
  it('drops history when time goes backwards', () => {
    let s = stepLines(EMPTY_LINES, new Map([['a', 'refusing']]), 100);
    s = stepLines(s, new Map([['a', 'none']]), 200);
    expect(s.shown.get('a')).toBe('refusing');
    s = stepLines(s, new Map([['a', 'none']]), 0);
    expect(s.shown.get('a')).toBe('none');
  });

  it('returns the same state when nothing changed', () => {
    const s = stepLines(EMPTY_LINES, new Map([['a', 'none']]), 100);
    expect(stepLines(s, new Map([['a', 'none']]), 100)).toBe(s);
  });

  it('lands a pending change when flushed', () => {
    let s = stepLines(EMPTY_LINES, new Map([['a', 'none']]), 100);
    s = stepLines(s, new Map([['a', 'waiting']]), 200);
    expect(s.shown.get('a')).toBe('none');
    expect(flushLines(s).shown.get('a')).toBe('waiting');
    const settled = flushLines(s);
    expect(flushLines(settled)).toBe(settled);
  });
});
