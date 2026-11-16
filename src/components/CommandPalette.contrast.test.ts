import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('command palette and presenting bar colours', () => {
  /* Every ink the palette rows and the presenting bar draw, on the grounds
     they draw it on: the card, the active row and the key caps. */
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const themes = [
    ['light', readTokens(css, ':root')],
    ['dark', readTokens(css, ":root[data-theme='dark']")],
  ] as const;

  const pairs: [string, string][] = [
    ['--text', '--surface'],
    ['--text-dim', '--surface'],
    ['--text-faint', '--surface'],
    ['--text', '--accent-soft'],
    ['--text-dim', '--accent-soft'],
    ['--text-dim', '--surface-2'],
    ['--danger', '--surface'],
  ];

  it.each(themes)('meets AA in %s', (_, t) => {
    const get = (name: string) => {
      const v = resolve(t, name);
      if (!v) throw new Error(`no ${name}`);
      return v;
    };
    for (const [ink, ground] of pairs) {
      expect(
        ratio(get(ink), get(ground)),
        `${ink} on ${ground}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(themes)('prints the measured ratios in %s', (name, t) => {
    const out = pairs.map(([ink, ground]) => {
      const r = ratio(resolve(t, ink) ?? '', resolve(t, ground) ?? '');
      return `${ink} on ${ground}: ${r.toFixed(2)}`;
    });
    console.log(name, out.join('; '));
    expect(out).toHaveLength(pairs.length);
  });
});
