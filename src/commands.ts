/* ------------------------------------------------------------------ *
 * The command palette's list and its search, as data.
 *
 * The shell assembles the commands from handlers it already has
 * (appCommands.ts), so a row is never a second implementation of an action.
 * This module only scores and orders them. The scoring is a subsequence
 * match with bonuses for letters that start a word and for runs of
 * consecutive letters, which is what lets "netf" find Netflix and "lb" find
 * Load balancer without pulling in a search library.
 * ------------------------------------------------------------------ */

export type CommandGroup =
  | 'Run'
  | 'Faults'
  | 'Add'
  | 'Example'
  | 'Challenge'
  | 'Incident'
  | 'View'
  | 'Share'
  | 'Help'
  | 'Glossary';

export interface Command {
  /** Stable across renders and reloads; the recent list stores it. */
  id: string;
  label: string;
  group: CommandGroup;
  /** Other words that should find this row. Never shown. */
  keywords?: readonly string[];
  /** The key that does the same thing, printed on the right. */
  hint?: string;
  /** Why the row cannot run now. Shown under the label; Enter does nothing. */
  disabled?: string;
  /** Left out of the list until something is typed. The glossary has a
      hundred terms, which would bury every action under them. */
  searchOnly?: boolean;
  run: () => void;
}

const isWordStart = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1] ?? ' ';
  return !/[a-z0-9]/.test(prev);
};

/**
 * How well one search word matches `text`, or null when it does not.
 * Both are expected lower-cased. A plain substring always outranks a
 * scattered subsequence, and one at the start of a word outranks one in the
 * middle of it.
 */
function wordScore(word: string, text: string): number | null {
  const at = text.indexOf(word);
  if (at >= 0) {
    let best = at;
    // Prefer a later hit that starts a word: "ser" in "user service".
    for (let i = at; i >= 0; i = text.indexOf(word, i + 1)) {
      if (isWordStart(text, i)) {
        best = i;
        break;
      }
    }
    return 100 + word.length * 4 + (best === 0 ? 40 : isWordStart(text, best) ? 25 : 0);
  }
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of word) {
    const j = text.indexOf(ch, from);
    if (j < 0) return null;
    score += 1;
    if (j === prev + 1) score += 3;
    if (isWordStart(text, j)) score += 6;
    prev = j;
    from = j + 1;
  }
  return score;
}

/**
 * The score of `query` against a label and its keywords, or null when any
 * word of the query matches neither. Words can match in any order, so
 * "db crash" finds "Crash Database".
 */
export function fuzzyScore(
  query: string,
  label: string,
  keywords: readonly string[] = [],
): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const name = label.toLowerCase();
  const extra = keywords.map((k) => k.toLowerCase());
  let total = 0;
  for (const w of words) {
    const onLabel = wordScore(w, name);
    let best = onLabel;
    for (const k of extra) {
      const s = wordScore(w, k);
      // A keyword hit counts for a little less than the same hit on the
      // label, so the row a reader can SEE matching comes first.
      if (s !== null && (best === null || s - 5 > best)) best = s - 5;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * The rows to show for `query`, best first.
 *
 * With nothing typed: the recent commands, newest first, then everything
 * not marked search-only in the order given, uncapped. With a query, at
 * most `limit` rows. With a query: by score, then a
 * small lift for a recent command, then the given order, so ties never
 * shuffle between keystrokes.
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  recent: readonly string[] = [],
  limit = 60,
): Command[] {
  const recentRank = new Map(recent.map((id, i) => [id, i] as const));
  if (query.trim() === '') {
    const byId = new Map(commands.map((c) => [c.id, c] as const));
    const head: Command[] = [];
    for (const id of recent) {
      const c = byId.get(id);
      if (c && !c.disabled) head.push(c);
    }
    const seen = new Set(head.map((c) => c.id));
    const rest = commands.filter((c) => !c.searchOnly && !seen.has(c.id));
    return [...head, ...rest];
  }
  const scored: { c: Command; s: number; i: number }[] = [];
  commands.forEach((c, i) => {
    const s = fuzzyScore(query, c.label, c.keywords);
    if (s === null) return;
    const r = recentRank.get(c.id);
    scored.push({ c, s: s + (r === undefined ? 0 : 8 - r), i });
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.c);
}

export const RECENT_MAX = 5;

/** `id` moved to the front, without duplicates, capped. */
export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
}

const RECENT_KEY = 'breakscale.commands.v1';

/** The recent list from this browser, or empty when storage is unavailable. */
export function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function saveRecent(recent: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // A private window or full storage: the list is a convenience.
  }
}
