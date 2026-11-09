import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTokens } from '../theme/tokens';

/**
 * Contrast is computed here, never eyeballed.
 *
 * These are regression guards, not documentation. The two explanation
 * surfaces are read by hundreds of students on projectors, cheap laptop
 * panels and in bright rooms, and the failure mode of a marker that is too
 * faint is invisible in review: the feature simply does not get discovered.
 *
 * One of these caught a real defect. The dotted underline was originally
 * --border-strong, which measures 1.58:1 — barely half the 3:1 that WCAG
 * 1.4.11 requires of a graphical object you need in order to understand the
 * interface. It is --line-3 now.
 *
 * Values mirror the tokens in src/index.css. If a token changes there and not
 * here, the test comparing them fails rather than drifting quietly.
 */

/* ---- tokens, copied from src/index.css --------------------------------- */
const TOKEN = {
  bg: '#faf7f3',
  surface: '#fffdfa',
  surface2: '#f7f3ee',
  surface3: '#f0ece5',
  border: '#e8e2da',
  // The divider ink as it was when the defect below was found, kept so that
  // test still measures it. The live --border-strong has since darkened.
  borderStrong: '#d2cbc2',
  line3: '#948c82',
  text: '#1e242e',
  textDim: '#525862',
  textFaint: '#626770',
  accent: '#325cbd',
  accentSoft: '#e3edff',
  accentInk: '#2d5277',
} as const;

/* ---- WCAG 2.1 relative luminance --------------------------------------- */

function channels(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function linearise(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearise) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** AA body text. */
const TEXT_MIN = 4.5;
/** AA non-text contrast: graphical objects and UI component boundaries. */
const GRAPHIC_MIN = 3;

/* ------------------------------------------------------------------ */

describe('the copied tokens', () => {
  const live = readTokens(
    readFileSync(new URL('../index.css', import.meta.url), 'utf8'),
    ':root',
  );
  const kebab = (k: string) => `--${k.replace(/([A-Z0-9])/g, '-$1').toLowerCase()}`;

  it.each(Object.entries(TOKEN).filter(([k]) => k !== 'borderStrong'))(
    '%s matches index.css',
    (key, value) => {
      expect(live[kebab(key)]?.toLowerCase()).toBe(value);
    },
  );
});

describe('the term affordance', () => {
  /*
   * The single most important measurement in the feature. This dotted
   * underline is the only signal that an explanation exists, so it is a
   * graphical object required to understand the content.
   */
  it.each([
    ['surface', TOKEN.surface],
    ['bg', TOKEN.bg],
    ['surface-2', TOKEN.surface2],
  ])('is visible on %s', (_name, background) => {
    expect(contrast(TOKEN.line3, background)).toBeGreaterThanOrEqual(GRAPHIC_MIN);
  });

  /* On a touch screen the underline stays on at rest (Tooltip.css), so the
     dark theme's ink has to clear the same bar. */
  it.each([
    ['bg', '#16151a'],
    ['surface', '#1d1c22'],
    ['surface-2', '#25242b'],
  ])('is visible on dark %s', (_name, background) => {
    expect(contrast('#807d8c', background)).toBeGreaterThanOrEqual(GRAPHIC_MIN);
  });

  it('would have failed with the quieter divider ink', () => {
    // Pins the defect this file was written for, so nobody "tidies" the
    // underline back to --border-strong.
    expect(contrast(TOKEN.borderStrong, TOKEN.surface)).toBeLessThan(GRAPHIC_MIN);
  });

  it('keeps its engaged state legible', () => {
    expect(contrast(TOKEN.text, TOKEN.accentSoft)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(TOKEN.accent, TOKEN.accentSoft)).toBeGreaterThanOrEqual(
      GRAPHIC_MIN,
    );
  });

  it('keeps the focus ring visible on every surface it lands on', () => {
    for (const bg of [TOKEN.surface, TOKEN.bg, TOKEN.accentSoft]) {
      expect(contrast(TOKEN.accent, bg)).toBeGreaterThanOrEqual(GRAPHIC_MIN);
    }
  });
});

describe('tooltip panel text', () => {
  it.each([
    ['term', TOKEN.text],
    ['short', TOKEN.textDim],
    ['why', TOKEN.text],
    ['see-also label', TOKEN.textFaint],
    ['see-also link', TOKEN.accentInk],
    ['see-also link hover', TOKEN.accent],
  ])('%s meets AA on the panel surface', (_name, ink) => {
    expect(contrast(ink, TOKEN.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
  });
});

describe('glossary text', () => {
  /* Every row background an entry can have: at rest, hovered, and selected
     or landed. Text must clear AA on all three, not just the default. */
  const ROW_BACKGROUNDS = [
    ['at rest', TOKEN.surface],
    ['hovered', TOKEN.surface2],
    ['active or landed', TOKEN.accentSoft],
  ] as const;

  const INKS = [
    ['term', TOKEN.text],
    ['short', TOKEN.textDim],
    ['why', TOKEN.text],
    ['see-also link', TOKEN.accentInk],
    ['see-also label', TOKEN.textFaint],
  ] as const;

  for (const [rowName, background] of ROW_BACKGROUNDS) {
    for (const [inkName, ink] of INKS) {
      it(`${inkName} meets AA on a row ${rowName}`, () => {
        expect(contrast(ink, background)).toBeGreaterThanOrEqual(TEXT_MIN);
      });
    }
  }

  it('keeps the header and search chrome legible', () => {
    // Title, subtitle, count, section headings.
    expect(contrast(TOKEN.text, TOKEN.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(TOKEN.textDim, TOKEN.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(TOKEN.textFaint, TOKEN.surface)).toBeGreaterThanOrEqual(TEXT_MIN);
    // The clear button sits on --surface-3 once hovered.
    expect(contrast(TOKEN.text, TOKEN.surface3)).toBeGreaterThanOrEqual(TEXT_MIN);
    expect(contrast(TOKEN.textFaint, TOKEN.surface3)).toBeGreaterThanOrEqual(
      GRAPHIC_MIN,
    );
  });

  it('makes the landed marker visible against both row states', () => {
    expect(contrast(TOKEN.accent, TOKEN.accentSoft)).toBeGreaterThanOrEqual(
      GRAPHIC_MIN,
    );
    expect(contrast(TOKEN.accent, TOKEN.surface)).toBeGreaterThanOrEqual(GRAPHIC_MIN);
  });
});
