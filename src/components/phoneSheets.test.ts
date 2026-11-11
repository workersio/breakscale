import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/*
 * On a phone every dialog opens as a bottom sheet, the way Share and Settings
 * already did. Read off disk, as phoneLayout.test.ts does, so the rules are
 * checked as shipped.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** The text of the `@media (max-width: 720px)` block, braces balanced. */
function phoneBlock(css: string): string {
  const start = css.indexOf('@media (max-width: 720px) {');
  if (start < 0) throw new Error('no phone block');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unbalanced phone block');
}

function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(i, css.indexOf('}', i));
}

const SHEETS = [
  { name: 'Share', file: './Share.css', root: '.sh-root', card: '.sh-card' },
  { name: 'Settings', file: './Settings.css', root: '.st-root', card: '.st-card' },
  {
    name: 'Examples and Challenges',
    file: './Examples.css',
    root: '.ex-root',
    card: '.ex-card',
  },
  { name: 'Your designs', file: './Designs.css', root: '.dz-root', card: '.dz-card' },
];

describe('dialogs on a phone', () => {
  for (const s of SHEETS) {
    it(`opens ${s.name} as a bottom sheet`, () => {
      const phone = phoneBlock(read(s.file));
      const root = ruleBody(phone, s.root);
      expect(root).toMatch(/place-items:\s*end stretch/);
      expect(root).toMatch(/padding:\s*0/);
      const card = ruleBody(phone, s.card);
      expect(card).toMatch(/width:\s*100%/);
      expect(card).toMatch(/border-radius:\s*var\(--r-lg\) var\(--r-lg\) 0 0/);
      expect(card).toMatch(/safe-area-inset-bottom/);
      expect(card).toMatch(/animation:\s*app-sheet-in/);
      expect(ruleBody(phone, `${s.root}.is-closing ${s.card}`)).toMatch(
        /animation:\s*app-sheet-out/,
      );
    });
  }
});
