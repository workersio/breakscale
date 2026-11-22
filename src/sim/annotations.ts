/**
 * Canvas annotations: notes and sections.
 *
 * These are documentation, not simulation. The engine never sees them, they
 * carry no traffic and they cannot fail. They exist so a thirty-node diagram
 * of a real company's architecture can say which part is the edge tier and
 * which part is the async pipeline, and so a design shared as a link arrives
 * already explained.
 *
 * They live in their own module rather than in types.ts because the engine
 * has no business knowing about them. `Topology` gains one optional field and
 * nothing else changes; every existing topology stays valid.
 */

/** A free-standing piece of text placed anywhere on the canvas. */
export interface Note {
  id: string;
  kind: 'note';
  text: string;
  x: number;
  y: number;
  /**
   * Wrap width in world units. Height follows from the text, so a note never
   * has a stale height stored against content that has since changed.
   *
   * Ignored while `autoResize` is set: an auto-sized note never wraps.
   */
  width: number;
  /**
   * The note sizes itself to its text: no wrapping, the box is as wide as
   * the widest line, and typing grows it. What Excalidraw calls autoResize
   * and what Eraser's text does until a side is dragged. A freshly placed
   * note is born this way; dragging an edge clears it and the dragged width
   * becomes the wrap width. Absent means fixed width, which is what every
   * note that existed before this flag was, so an old link opens unchanged.
   */
  autoResize?: boolean;
  /**
   * Relative size. Notes serve two different jobs: a heading that titles a
   * whole diagram, and a small aside next to one component. One scale would
   * make one of those wrong.
   */
  size: 'sm' | 'md' | 'lg';
  /**
   * Continuous multiplier on the size preset, set by dragging a corner.
   *
   * The preset stays the coarse control (the S/M/L buttons, and what a
   * preset author writes); this is the fine one. Kept as a MULTIPLIER rather
   * than an absolute px size so the two cannot contradict each other: a note
   * scaled to 1.5 and then switched from md to lg is still half again bigger
   * than an lg note, which is what someone who dragged it that size expects.
   *
   * Absent means 1, so a note that has never been scaled stores nothing.
   */
  scale?: number;
  /**
   * Typeface. A hand-drawn face reads as a margin annotation rather than as
   * part of the system being described, which is the distinction a student
   * needs when the same canvas carries both.
   *
   * Optional, and absent means the UI default. The wrap in annotationLayout
   * measures in this same family, so a note is always wrapped in the face it
   * is painted in.
   */
  font?: AnnotationFont;
  /**
   * An explicit CSS colour, overriding the theme's default note ink.
   *
   * Optional on purpose. A note with no colour follows the theme, so it stays
   * readable when the palette changes; one with a colour is a deliberate
   * choice by whoever wrote it and is honoured exactly.
   *
   * `tone` below is the one the interface offers, because it is theme-safe;
   * this stays for a design that arrives carrying an explicit colour.
   */
  color?: string;
  /** Palette index for the text colour. See NoteTone. */
  tone?: number;
  /** Heavier weight, on top of whatever the size already sets. */
  bold?: boolean;
  /**
   * Slanted, and underlined.
   *
   * Separate flags rather than one enum because they combine: a note can be
   * bold AND italic. Absent rather than false when off, so a note that has
   * never been styled stores nothing and a share link stays short.
   */
  italic?: boolean;
  underline?: boolean;
}

/**
 * A labelled rectangle drawn behind a group of nodes, to mark a tier.
 *
 * Purely spatial: a section does not own the nodes inside it and nothing is
 * reparented. A node is "in" a section only in the sense that it happens to
 * sit within its bounds, which means dragging a node in or out needs no
 * bookkeeping and can never corrupt the topology.
 */
export interface Section {
  id: string;
  kind: 'section';
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Index into the section palette rather than a raw colour, so sections
   * restyle with the theme instead of pinning a hex value into saved designs
   * that would then clash after any redesign.
   *
   * Still the default, and still what every preset uses. `color` below is the
   * escape hatch for someone who wants a specific shade; leaving it unset is
   * the theme-safe path and stays the recommended one.
   */
  tone: number;
  /** An explicit CSS colour, overriding `tone`. See Note.color. */
  color?: string;
}

/**
 * The shades a note's text can take.
 *
 * Same indices the sections use, for the same reason: an index resolves per
 * theme, so a note coloured in the light theme is still readable in the dark
 * one. `tone` is absent on a note that has never been coloured, which means
 * "follow the body text" rather than "shade 0".
 */
export type NoteTone = number;

/**
 * The faces a note can be set in.
 *
 * Deliberately a short closed list rather than a free-text family name. Every
 * one of these has a stack defined in index.css and is measurable by
 * textMetrics, which is what keeps the wrap honest; an arbitrary family would
 * be measured against a fallback and wrap wrongly.
 */
/**
 * Four, not five. A "marker" face was offered and dropped: no marker font is
 * installed on a typical Linux or Windows box, so its stack fell through to
 * the same serif the serif button selects, and the picker showed two buttons
 * that were visibly identical and did the same thing. A choice the reader
 * cannot see is not a choice.
 */
export const ANNOTATION_FONTS = ['sans', 'hand', 'serif', 'mono'] as const;

export type AnnotationFont = (typeof ANNOTATION_FONTS)[number];

export type Annotation = Note | Section;

/** Sections render behind nodes; notes render in front. */
export function isSection(a: Annotation): a is Section {
  return a.kind === 'section';
}

export function isNote(a: Annotation): a is Note {
  return a.kind === 'note';
}

export const NOTE_DEFAULT_WIDTH = 220;
/**
 * Longest text a note will hold, in UTF-16 units (what a textarea counts).
 *
 * A bound, not a design choice: it is what sanitizeAnnotations applies to
 * text arriving from a link or a file, so the editor enforces the same
 * number and a note can never be typed longer than it would survive a
 * round trip. The value dates from when a whole design had to fit inside a
 * ~2000 character URL; with the link store that pressure is gone, but a
 * note is an annotation, and two thousand characters is already an essay.
 */
export const NOTE_MAX_CHARS = 2000;
/**
 * Wrap-width bounds for a note.
 *
 * Only the WIDTH is resizable: a note's height is derived from its wrapped
 * text on every layout and deliberately never stored, so dragging a bottom
 * edge would set a number the next render throws away. Narrower than the
 * minimum and the text breaks mid-word on every line; wider than the maximum
 * and it stops being an annotation and becomes a paragraph nobody reads.
 */
export const NOTE_MIN_WIDTH = 80;
export const NOTE_MAX_WIDTH = 900;

/**
 * Bounds on the corner-drag scale.
 *
 * Below the minimum a note is smaller than the node labels around it and
 * reads as a mistake; above the maximum it is a headline competing with the
 * diagram it annotates.
 */
export const NOTE_MIN_SCALE = 0.6;
export const NOTE_MAX_SCALE = 4;
export const SECTION_MIN_WIDTH = 120;
export const SECTION_MIN_HEIGHT = 90;

/**
 * How many shades the section palette offers.
 *
 * Each is an index, never a colour. The stylesheet resolves an index to a
 * trio that is redefined per theme, so a section keeps its identity across a
 * theme switch instead of carrying a hex that was only readable in one of
 * them. Thirteen: twelve hues plus a neutral.
 */
export const SECTION_TONE_COUNT = 13;

let counter = 0;

export function makeNote(x: number, y: number, text = 'Note'): Note {
  counter += 1;
  return {
    id: `note-${counter}`,
    kind: 'note',
    text,
    x,
    y,
    width: NOTE_DEFAULT_WIDTH,
    size: 'md',
    autoResize: true,
  };
}

export function makeSection(
  x: number,
  y: number,
  width = 320,
  height = 220,
  label = 'Section',
): Section {
  counter += 1;
  return {
    id: `section-${counter}`,
    kind: 'section',
    label,
    x,
    y,
    width: Math.max(width, SECTION_MIN_WIDTH),
    height: Math.max(height, SECTION_MIN_HEIGHT),
    tone: counter % SECTION_TONE_COUNT,
  };
}

/**
 * Validate annotations arriving from a saved design, a pasted link or an
 * imported file.
 *
 * Everything here crosses a trust boundary, so nothing is assumed. A single
 * malformed entry is dropped rather than allowed to throw, because a truncated
 * share link must still open the design it can recover instead of showing a
 * blank screen.
 */
export function sanitizeAnnotations(input: unknown): Annotation[] {
  if (!Array.isArray(input)) return [];
  const out: Annotation[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : null;
    if (!id || seen.has(id)) continue;

    const x = num(a.x);
    const y = num(a.y);
    if (x === null || y === null) continue;

    if (a.kind === 'note') {
      const text = typeof a.text === 'string' ? a.text.slice(0, NOTE_MAX_CHARS) : '';
      // An empty note is invisible and unselectable, so it would be a piece of
      // litter the reader cannot remove. Drop it. Checked after the cut, or a
      // note whose only words lie past the limit would survive as blanks.
      if (!text.trim()) continue;
      const width = num(a.width);
      out.push({
        id,
        kind: 'note',
        text,
        x,
        y,
        width: clamp(width ?? NOTE_DEFAULT_WIDTH, NOTE_MIN_WIDTH, NOTE_MAX_WIDTH),
        size: a.size === 'sm' || a.size === 'lg' ? a.size : 'md',
        ...font(a.font),
        ...colour(a.color),
        ...noteTone(a.tone),
        ...(a.bold === true ? { bold: true } : {}),
        ...(a.italic === true ? { italic: true } : {}),
        ...noteScale(a.scale),
        ...(a.underline === true ? { underline: true } : {}),
        ...(a.autoResize === true ? { autoResize: true } : {}),
      });
      seen.add(id);
    } else if (a.kind === 'section') {
      const width = num(a.width);
      const height = num(a.height);
      const tone = num(a.tone);
      out.push({
        id,
        kind: 'section',
        label: typeof a.label === 'string' ? a.label.slice(0, 200) : '',
        x,
        y,
        width: clamp(width ?? 320, SECTION_MIN_WIDTH, 4000),
        height: clamp(height ?? 220, SECTION_MIN_HEIGHT, 4000),
        tone:
          tone === null
            ? 0
            : ((Math.floor(tone) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) %
              SECTION_TONE_COUNT,
        ...colour(a.color),
      });
      seen.add(id);
    }
  }
  return out;
}

/**
 * Accept a font only if it is one we actually have a stack for.
 *
 * An unknown family would be measured against a fallback and painted in
 * another, so the note would wrap to the wrong width. Dropping it back to the
 * default is the only safe reading.
 */
function font(v: unknown): { font?: AnnotationFont } {
  return typeof v === 'string' && (ANNOTATION_FONTS as readonly string[]).includes(v)
    ? { font: v as AnnotationFont }
    : {};
}

/**
 * A colour arriving from a share link or an imported file is untrusted text
 * that ends up in a style attribute, so it is matched against an explicit
 * pattern rather than passed through. `url(...)`, a semicolon closing the
 * declaration, or anything else inventive is dropped and the annotation falls
 * back to its theme colour.
 *
 * Deliberately narrow: hex, rgb/rgba, hsl/hsla, and the CSS named colours the
 * browser already knows. That covers every colour a picker can produce.
 */
const COLOUR_RE =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\([0-9a-z%.,\s/+-]{1,64}\)|[a-z]{3,24})$/i;

function colour(v: unknown): { color?: string } {
  if (typeof v !== 'string') return {};
  const c = v.trim();
  if (!c || c.length > 72 || !COLOUR_RE.test(c)) return {};
  return { color: c };
}

/**
 * A note's shade index, or nothing.
 *
 * Absent is meaningful here in a way it is not for a section: a note with no
 * tone follows the body text colour, which is the right default and not the
 * same as shade 0.
 */
/**
 * A note's scale, or nothing.
 *
 * Absent means 1 and is the common case, so an unset or out-of-range value
 * returns nothing rather than writing a redundant 1 into every note.
 */
function noteScale(v: unknown): { scale?: number } {
  const n = num(v);
  if (n === null) return {};
  const c = clamp(n, NOTE_MIN_SCALE, NOTE_MAX_SCALE);
  return c === 1 ? {} : { scale: c };
}

function noteTone(v: unknown): { tone?: number } {
  const n = num(v);
  if (n === null) return {};
  const i =
    ((Math.floor(n) % SECTION_TONE_COUNT) + SECTION_TONE_COUNT) % SECTION_TONE_COUNT;
  return { tone: i };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
