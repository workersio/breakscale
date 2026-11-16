import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('tour colours', () => {
  /* The card's words are text on its surface; the ring around the control a
     step points at is a non-text mark on the page and on the panels, and the
     step dots are non-text marks on the card. Measured from src/index.css. */
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const themes = [
    ['light', readTokens(css, ':root')],
    ['dark', readTokens(css, ":root[data-theme='dark']")],
  ] as const;

  it.each(themes)('meets AA in %s', (_, t) => {
    const get = (name: string) => {
      const v = resolve(t, name);
      if (!v) throw new Error(`no ${name}`);
      return v;
    };
    expect(ratio(get('--text'), get('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get('--text-dim'), get('--surface'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get('--accent'), get('--bg'))).toBeGreaterThanOrEqual(3);
    expect(ratio(get('--accent'), get('--surface'))).toBeGreaterThanOrEqual(3);
    // A step still to come.
    expect(ratio(get('--border-strong'), get('--surface'))).toBeGreaterThanOrEqual(3);
  });
});
