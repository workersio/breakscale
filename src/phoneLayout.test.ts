import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Read off disk, as theme.contrast.test.ts does, so the rules are checked as
// shipped rather than through a CSS transform.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const index = read('./index.css');
const app = read('./App.css');

/** Every `--name:` declared in index.css. */
const TOKENS = new Set([...index.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/** The body of the first rule for `selector` after `from`. */
function ruleBody(css: string, selector: string, from = 0): string {
  const i = css.indexOf(`${selector} {`, from);
  if (i < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(i, css.indexOf('}', i));
}

describe('phone stylesheet', () => {
  it('sizes the tab labels with a token that exists', () => {
    const body = ruleBody(app, '.app-tab');
    const m = body.match(/font-size:\s*var\((--[a-z0-9-]+)\)/);
    expect(m).not.toBeNull();
    expect(TOKENS.has(m?.[1] ?? '')).toBe(true);
    expect(body).not.toMatch(/letter-spacing/);
  });

  it('gives the slider its 44px touch band after the base rule, so it applies', () => {
    const base = index.indexOf('.slider {');
    const coarse = index.indexOf('.slider {', base + 1);
    expect(coarse).toBeGreaterThan(base);
    expect(index.lastIndexOf('@media (pointer: coarse)', coarse)).toBeGreaterThan(base);
    expect(ruleBody(index, '.slider', coarse)).toMatch(/height:\s*44px/);
  });

  it('makes the sheet grabber a 44px box', () => {
    const phone = app.indexOf('.app-grabber {', app.indexOf('.app-grabber {') + 1);
    expect(ruleBody(app, '.app-grabber', phone)).toMatch(/height:\s*44px/);
  });
});
