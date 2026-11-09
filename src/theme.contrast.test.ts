/**
 * WCAG contrast for both themes, computed from index.css itself.
 *
 * AGENTS.md: "Text meets WCAG AA. Compute the ratio; do not estimate it."
 * The dark palette carries 132 derived per-kind colours on top of the core
 * ramp, which is far past what anyone can check by eye, so the check reads
 * the shipped stylesheet and does the arithmetic. A palette edit that drops a
 * pair below AA fails here rather than reaching a reader.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { ratio } from './theme/contrast';
import { readTokens, resolve } from './theme/tokens';
import type { Tokens } from './theme/tokens';

// Read off disk rather than importing. `import css from './index.css?raw'`
// yields an empty string under vitest, because CSS is handled by the style
// pipeline instead of being served as text, and an empty palette would make
// every assertion below pass vacuously.
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

const THEMES: Array<[string, Tokens]> = [
  ['light', readTokens(css, ':root')],
  ['dark', readTokens(css, ":root[data-theme='dark']")],
];

/** WCAG AA for body text. */
const AA = 4.5;
/** WCAG AA for large text and for non-text UI components. */
const AA_LARGE = 3;

/** Every opaque ground in the app, plus the meter trough. */
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3', '--track'];
const SOFT_PLATES = ['--accent-soft', '--ok-soft', '--warn-soft', '--danger-soft'];
const TEXT_GROUNDS = [...SURFACES, ...SOFT_PLATES];

function colour(t: Tokens, name: string): string {
  const v = resolve(t, name);
  if (!v) throw new Error(`missing token ${name}`);
  return v;
}

describe.each(THEMES)('%s theme', (_name, tokens) => {
  it('carries body text at AA on every surface it is painted on', () => {
    for (const surface of ['--bg', '--surface', '--surface-2', '--surface-3']) {
      expect(
        ratio(colour(tokens, '--text'), colour(tokens, surface)),
        `--text on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('carries dimmed text at AA on the two main surfaces', () => {
    for (const surface of ['--bg', '--surface']) {
      expect(
        ratio(colour(tokens, '--text-dim'), colour(tokens, surface)),
        `--text-dim on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('carries the faintest text at AA wherever text is painted', () => {
    // --text-faint used to be held only to the large-text floor, on two
    // surfaces. It captions small mono numbers inside chips, table bands and
    // meter rows, so it gets the body-text bar on every plate it lands on.
    for (const surface of TEXT_GROUNDS) {
      expect(
        ratio(colour(tokens, '--text-faint'), colour(tokens, surface)),
        `--text-faint on ${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('outlines buttons and inputs above the non-text floor', () => {
    // --border-strong is the only thing giving a button or an input its
    // shape: both paint --surface on a --bg page, which is barely a fifth of
    // a step of contrast, so the outline carries the whole boundary. WCAG
    // puts non-text UI components at 3:1, and the light theme sat at 1.51
    // until someone said the buttons were hard to see. Text contrast passing
    // is not evidence this does, which is why it needs its own assertion.
    for (const surface of ['--bg', '--surface']) {
      expect(
        ratio(colour(tokens, '--border-strong'), colour(tokens, surface)),
        `--border-strong on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('carries status colours at AA on every surface and on the track', () => {
    // A health word sits in a pressed row as often as on a panel, and the
    // dark --danger was 4.32 on --surface-3 while both surfaces passed.
    for (const status of ['--ok', '--warn', '--danger', '--accent']) {
      for (const surface of SURFACES) {
        expect(
          ratio(colour(tokens, status), colour(tokens, surface)),
          `${status} on ${surface}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('carries each status ink on its own soft plate', () => {
    for (const [ink, soft] of [
      ['--ok', '--ok-soft'],
      ['--warn', '--warn-soft'],
      ['--danger', '--danger-soft'],
      ['--accent-ink', '--accent-soft'],
    ]) {
      expect(
        ratio(colour(tokens, ink!), colour(tokens, soft!)),
        `${ink} on ${soft}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('keeps neutral text readable on every soft plate', () => {
    // Chips put a caption beside the coloured word, so the plate has to carry
    // the neutral ramp too, not only its own ink.
    for (const ink of ['--text', '--text-dim', '--text-faint']) {
      for (const soft of SOFT_PLATES) {
        expect(
          ratio(colour(tokens, ink), colour(tokens, soft)),
          `${ink} on ${soft}`,
        ).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it('keeps pressed and hovered fills readable', () => {
    // These were literal hex in the button rules, tuned for light only. In
    // dark the pressed toggle's hover put --accent-ink on a pale blue at
    // 1.35:1, and a pressed delete put dark text on a dark red at 2.54:1.
    for (const [ink, fill] of [
      ['--accent-ink', '--accent-soft-hover'],
      ['--text-on-fill', '--danger'],
      ['--text-on-fill', '--danger-press'],
    ]) {
      expect(
        ratio(colour(tokens, ink!), colour(tokens, fill!)),
        `${ink} on ${fill}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("draws the select chevron in this theme's faint ink", () => {
    // A data URI cannot read a custom property, so the stroke is spelled out
    // per theme. The light one used to be the only one, at 2.78:1 on a dark
    // input.
    const stroke = /stroke='%23([0-9a-f]{6})'/i.exec(
      tokens['--select-chevron'] ?? '',
    )?.[1];
    expect(stroke, 'chevron stroke').toBeDefined();
    expect(`#${stroke}`).toBe(colour(tokens, '--text-faint'));
    for (const surface of ['--surface', '--surface-2']) {
      expect(
        ratio(`#${stroke}`, colour(tokens, surface)),
        `chevron on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('reads a button label against its own accent fill', () => {
    expect(
      ratio(colour(tokens, '--accent-fg'), colour(tokens, '--accent')),
      '--accent-fg on --accent',
    ).toBeGreaterThanOrEqual(AA);
  });

  it('carries every component kind label on its own fill', () => {
    // 33 kinds, one assertion each: the node label is the text a student
    // actually reads, and it sits on the kind's tinted plate rather than on
    // the page background.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-ink$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    expect(kinds.length).toBe(33);
    for (const kind of kinds) {
      expect(
        ratio(
          colour(tokens, `--kind-${kind}-ink`),
          colour(tokens, `--kind-${kind}-fill`),
        ),
        `${kind} ink on fill`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it('separates every kind fill from the canvas it sits on', () => {
    // Not a text requirement, but a node whose plate is indistinguishable
    // from the canvas has no edges, so the diagram stops reading as boxes.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-fill$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    for (const kind of kinds) {
      expect(
        ratio(colour(tokens, `--kind-${kind}-fill`), colour(tokens, '--bg')),
        `${kind} fill against --bg`,
      ).toBeGreaterThan(1.02);
    }
  });

  it('gives every kind border enough presence to read as an outline', () => {
    // Not a WCAG threshold. The node border is a soft inner outline, not the
    // shape's edge (the -stroke token does that job), and the shipped light
    // palette sits at 1.95 to 2.13 against its own fill. The floor is set
    // just under that measured range so a derived palette cannot quietly
    // wash a border out, without inventing a stricter rule than the design
    // it is checking.
    const kinds = [
      ...new Set(
        Object.keys(tokens)
          .map((k) => /^--kind-([a-z0-9]+)-line$/.exec(k)?.[1])
          .filter((k): k is string => Boolean(k)),
      ),
    ];
    for (const kind of kinds) {
      expect(
        ratio(
          colour(tokens, `--kind-${kind}-line`),
          colour(tokens, `--kind-${kind}-fill`),
        ),
        `${kind} line against its fill`,
      ).toBeGreaterThanOrEqual(1.9);
    }
  });
});

describe('annotation shades', () => {
  // The shades are declared once, in :root, as aliases of component kinds.
  // They are deliberately NOT redeclared for dark: the kind tokens are, so
  // an alias resolves to the dark trio on its own. That indirection is the
  // whole reason a section keeps its identity across a theme switch, so the
  // check has to resolve each alias against the theme being tested rather
  // than expecting an --ann-* block to exist in both.
  const light = THEMES[0]![1];
  const dark = THEMES[1]![1];

  const shades = [
    ...new Set(
      Object.keys(light)
        .map((k) => /^--ann-(\d+)-ink$/.exec(k)?.[1])
        .filter((k): k is string => Boolean(k)),
    ),
  ];

  it('offers the full palette', () => {
    expect(shades.length).toBe(13);
  });

  /** Follow --ann-N-role through its kind alias into `theme`. */
  function shadeColour(theme: Tokens, tone: string, role: string): string {
    const aliased = light[`--ann-${tone}-${role}`];
    if (!aliased) throw new Error(`missing --ann-${tone}-${role}`);
    const m = /^var\((--[a-z0-9-]+)\)$/i.exec(aliased.trim());
    if (!m) return aliased.trim();
    const v = resolve(theme, m[1]!);
    if (!v) throw new Error(`${m[1]} is not defined in this theme`);
    return v;
  }

  it.each([
    ['light', light],
    ['dark', dark],
  ])('reads in the %s theme, every shade', (_name, theme) => {
    // A shade that is unreadable in one theme is worse than not offering it:
    // a student picks it in light mode and loses the label in dark.
    for (const tone of shades) {
      expect(
        ratio(shadeColour(theme, tone, 'ink'), shadeColour(theme, tone, 'fill')),
        `shade ${tone} ink on fill`,
      ).toBeGreaterThanOrEqual(AA);
      expect(
        ratio(shadeColour(theme, tone, 'line'), shadeColour(theme, tone, 'fill')),
        `shade ${tone} border on fill`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });
});

describe('theme parity', () => {
  it('defines the same colour tokens in both themes', () => {
    // A token present in light and missing in dark silently falls back to the
    // light value, which is the single most common way a dark theme ends up
    // with one glaring white patch.
    const [, light] = THEMES[0]!;
    const [, dark] = THEMES[1]!;
    const isColour = (v: string) => /^(#|rgba?\(|hsla?\()/i.test(v);
    const missing = Object.keys(light)
      .filter((k) => isColour(light[k]!))
      .filter((k) => !(k in dark));
    expect(missing).toEqual([]);
  });

  it('honours the OS preference block with the same values as the explicit one', () => {
    // The media query cannot alias the [data-theme] block (it has to stand
    // alone before any script runs), so the two are duplicated and must not
    // drift apart.
    const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const auto = readTokens(media, "  :root:not([data-theme='light'])");
    const [, dark] = THEMES[1]!;
    for (const [k, v] of Object.entries(auto)) {
      expect(dark[k], `${k} drifted between the explicit and OS dark blocks`).toBe(v);
    }
    expect(Object.keys(auto).length).toBeGreaterThan(140);
  });
});

describe('stylesheets', () => {
  // Every stylesheet the app ships, read off disk for the same reason as
  // index.css above.
  const sheets = ['.', './components', './learn'].flatMap((dir) =>
    readdirSync(new URL(dir, import.meta.url))
      .filter((f) => f.endsWith('.css'))
      .map((f) => {
        const path = `${dir}/${f}`;
        return [path, readFileSync(new URL(path, import.meta.url), 'utf8')] as const;
      }),
  );

  // Blank comments out but keep their newlines, so line numbers still match.
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));

  it('finds the stylesheets it is meant to check', () => {
    expect(sheets.map(([p]) => p)).toEqual(
      expect.arrayContaining(['./index.css', './App.css', './components/Canvas.css']),
    );
  });

  it('writes colour only as a token declaration', () => {
    // AGENTS.md: all colour comes from tokens. A literal in a rule is how the
    // dark theme picked up a light-only pressed fill, so any hex or rgb()
    // outside a `--name:` line fails here.
    const offenders: string[] = [];
    for (const [path, text] of sheets) {
      stripComments(text)
        .split('\n')
        .forEach((line, i) => {
          if (
            /#[0-9a-f]{3,8}\b|rgba?\(/i.test(line) &&
            !/^\s*--[a-z0-9-]+:/i.test(line)
          ) {
            offenders.push(`${path}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('never dims a disabled control with opacity', () => {
    // Opacity takes the label down with it: the disabled Inspect tab read at
    // 1.89:1. Disabled states are expressed with tokens instead.
    const offenders: string[] = [];
    for (const [path, text] of sheets) {
      for (const m of stripComments(text).matchAll(
        /([^{}]*:disabled[^{}]*)\{([^}]*)\}/g,
      )) {
        if (/\bopacity\s*:/.test(m[2] ?? ''))
          offenders.push(`${path}: ${(m[1] ?? '').trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
