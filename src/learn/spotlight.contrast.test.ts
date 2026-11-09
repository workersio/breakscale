import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('spotlight colours', () => {
  /* The tag's word is text on its own fill; the ring is a non-text mark on
     the canvas, and so is the tag's border. Measured from src/index.css. */
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
    expect(ratio(get('--danger'), get('--danger-soft'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get('--danger-mark'), get('--bg'))).toBeGreaterThanOrEqual(3);
    expect(ratio(get('--danger-mark'), get('--surface'))).toBeGreaterThanOrEqual(3);
  });
});
