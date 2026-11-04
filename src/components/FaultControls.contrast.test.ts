import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

/**
 * WCAG AA for the text the fault controls paint, in both themes, computed
 * from index.css. Node environment on purpose: under jsdom import.meta.url
 * is not a file URL and the stylesheet cannot be read.
 */
describe('contrast', () => {
  // The pairs the controls paint, in both themes. Computed from index.css.
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
  const themes = [
    ['light', readTokens(css, ':root')],
    ['dark', readTokens(css, ":root[data-theme='dark']")],
  ] as const;
  const PAIRS: Array<[string, string]> = [
    // Status line and hints, healthy.
    ['--text-dim', '--surface'],
    // Status line and a cut cable's name, faulted.
    ['--danger', '--surface'],
    // .btn-danger at rest and hovered.
    ['--danger', '--surface'],
    ['--text-on-fill', '--danger'],
    // Fix, the plain button.
    ['--text', '--surface'],
  ];
  for (const [name, tokens] of themes) {
    it(`${name}: every text pair clears AA`, () => {
      for (const [fg, bg] of PAIRS) {
        const a = resolve(tokens, fg);
        const b = resolve(tokens, bg);
        if (!a || !b) throw new Error(`missing ${fg} or ${bg}`);
        expect(ratio(a, b), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
