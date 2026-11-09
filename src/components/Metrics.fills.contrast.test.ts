import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { over, ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

/**
 * The packet-loss band is a graphical mark, so it needs 3:1 in both themes,
 * as drawn: a band sits at 0.85 opacity on --surface. Node environment for
 * the same reason as FaultControls.contrast.test.ts.
 */
describe('packet-loss band', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const metrics = readFileSync(new URL('./Metrics.css', import.meta.url), 'utf8');

  it('has its own fill', () => {
    expect(metrics).toMatch(/\.mx-fill-packet-loss\s*\{\s*fill: var\(--cat-rust\);/);
  });

  for (const [name, selector] of [
    ['light', ':root'],
    ['dark', ":root[data-theme='dark']"],
  ] as const) {
    it(`${name}: clears 3:1 on the panel and the canvas`, () => {
      const tokens = readTokens(css, selector);
      const fill = resolve(tokens, '--cat-rust');
      const surface = resolve(tokens, '--surface');
      const bg = resolve(tokens, '--bg');
      if (!fill || !surface || !bg) throw new Error('missing token');
      expect(ratio(over(fill, surface, 0.85), surface)).toBeGreaterThanOrEqual(3);
      expect(ratio(fill, bg)).toBeGreaterThanOrEqual(3);
    });
  }
});
