import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('learning path colours', () => {
  /* Every text colour the dialog uses, on both surfaces a step can sit on:
     the card, and the hover fill. The done mark's ring is a non-text mark. */
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
    for (const bg of ['--surface', '--surface-2']) {
      for (const fg of [
        '--text',
        '--text-dim',
        '--text-faint',
        '--ok',
        '--accent-ink',
      ]) {
        expect(ratio(get(fg), get(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        ratio(get('--ok-mark'), get(bg)),
        `--ok-mark on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        ratio(get('--accent'), get(bg)),
        `--accent on ${bg}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});
