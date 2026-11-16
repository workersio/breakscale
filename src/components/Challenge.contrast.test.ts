import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('brief colours', () => {
  /* A goal's live reading is dimmed text on the goal's recessed row, and the
     countdown and the starting-point verdict are dimmed and body text on the
     panel. Measured from src/index.css. */
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
    for (const [ink, ground] of [
      ['--text-dim', '--surface-2'],
      ['--text', '--surface-2'],
      ['--text-dim', '--surface'],
      ['--text', '--surface'],
    ] as const) {
      const r = ratio(get(ink), get(ground));
      expect(r, `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
