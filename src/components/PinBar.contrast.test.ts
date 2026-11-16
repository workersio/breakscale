import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('pin and speed colours', () => {
  /* The pin row's text and the speed button's shortfall ink, on the surface
     the charts strip and the bar's buttons are drawn on. The pinned line is
     a graphic and needs 3:1; its key and readings are text and need 4.5. */
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
    for (const ink of [
      '--text',
      '--text-dim',
      '--text-faint',
      '--ok',
      '--danger',
      '--warn',
    ]) {
      expect(
        ratio(get(ink), get('--surface')),
        `${ink} on --surface`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
