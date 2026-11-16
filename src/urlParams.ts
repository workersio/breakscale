/**
 * Deep-link boot parameters.
 *
 * The app had no entry point for "open this example": presets came from
 * localStorage or a share link, so there was nothing to navigate to. These
 * parameters are read once at boot, before the first paint:
 *
 *   ?preset=<preset id>       load that example instead of the stored session
 *   ?theme=light|dark|system  override the theme for this page view
 *   ?paused=1                 boot with the simulation frozen
 *   ?warmup=<ms>              advance the simulation deterministically before
 *                             the first paint, capped at one minute
 *
 * `theme` is also read from the hash (`#theme=dark`), which is where a human
 * pasting a link tends to put it; the query wins when both are present. The
 * hash is otherwise share-link territory (the d1./d2. prefixes) and is left
 * alone: those payloads contain no "=" parameters, so parsing them is a
 * no-op by construction.
 *
 * Pure string parsing, so it unit-tests without a DOM. Anything malformed
 * costs only that one parameter; an unknown preset or theme boots the
 * stored session rather than an error page, exactly like a corrupt
 * localStorage value does.
 */

import { PRESETS } from './sim/presets';
import type { ThemeChoice } from './content/preferences';

export interface BootParams {
  /** A validated preset id, or null for "use the stored session". */
  readonly presetId: string | null;
  /** A validated theme choice, or null for "use the stored preference". */
  readonly theme: ThemeChoice | null;
  /** Boot with the simulation paused. */
  readonly paused: boolean;
  /** Simulated milliseconds to advance before the first paint. */
  readonly warmupMs: number;
}

export const EMPTY_BOOT_PARAMS: BootParams = {
  presetId: null,
  theme: null,
  paused: false,
  warmupMs: 0,
};

const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/** One minute of simulated warmup is more than any screenshot needs. */
const WARMUP_MAX_MS = 60_000;

/** First occurrence of `key`: the query string wins over the hash. */
function readParam(search: string, hash: string, key: string): string | null {
  const fromQuery = new URLSearchParams(search).get(key);
  if (fromQuery !== null) return fromQuery;
  return new URLSearchParams(hash.replace(/^#/, '')).get(key);
}

export function parseBootParams(search: string, hash: string): BootParams {
  const presetRaw = readParam(search, hash, 'preset');
  const presetId =
    presetRaw !== null && PRESETS.some((p) => p.id === presetRaw) ? presetRaw : null;

  const themeRaw = readParam(search, hash, 'theme');
  const theme =
    themeRaw !== null && (THEME_CHOICES as readonly string[]).includes(themeRaw)
      ? (themeRaw as ThemeChoice)
      : null;

  const pausedRaw = readParam(search, hash, 'paused');
  const paused = pausedRaw === '1' || pausedRaw === 'true';

  const warmupRaw = readParam(search, hash, 'warmup');
  let warmupMs = 0;
  if (warmupRaw !== null) {
    const n = Number(warmupRaw);
    if (Number.isFinite(n) && n > 0) warmupMs = Math.min(Math.round(n), WARMUP_MAX_MS);
  }

  return { presetId, theme, paused, warmupMs };
}
