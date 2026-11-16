import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ratio } from '../theme/contrast';
import { readTokens, resolve } from '../theme/tokens';

describe('context menu colours', () => {
  /* The menu's rows sit on --surface and turn --surface-2 under the
     pointer. The title is --text-dim and Delete is --danger. Inert rows
     (Paste with nothing copied) are exempt from AA but still checked at
     3:1 so they read as text, not as decoration. */
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
      for (const ink of ['--text', '--text-dim', '--danger']) {
        expect(ratio(get(ink), get(bg)), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(get('--text-faint'), get(bg))).toBeGreaterThanOrEqual(3);
    }
  });
});
