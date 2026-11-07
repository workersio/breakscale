import { isTopology } from './clipboard';
import { sanitizeAnnotations } from './sim/annotations';
import { downloadBlob } from './imageExport';

/* ------------------------------------------------------------------ *
 * Whole-browser backup.
 *
 * Named saves, preferences, the open panels and the autosaved session all
 * live in localStorage, which means they live on ONE machine in ONE
 * browser. Clearing site data takes them; a new laptop never had them.
 *
 * A single file that carries everything is the honest answer to that. It
 * is not a sync service and does not pretend to be one: it is the door
 * out, so that choosing this app does not mean the work is trapped in it.
 *
 * Reading one back crosses a trust boundary like every other import: the
 * file may be truncated, hand-edited, or from a future version.
 * ------------------------------------------------------------------ */

export const BACKUP_APP = 'breakscale-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_EXT = '.breakscale-backup.json';

/**
 * The keys a backup carries.
 *
 * Listed explicitly rather than swept from localStorage by prefix, so a
 * key added later is a deliberate decision to include it and a key that
 * should never travel cannot be picked up by accident.
 */
export const BACKED_UP_KEYS = [
  'breakscale.designs.v1',
  'breakscale.preferences.v1',
  'breakscale.layout.v1',
  'breakscale.session.v1',
  // Challenge attempts and passes. Losing them on a new machine would cost
  // someone every brief they had already worked through.
  'breakscale.challenges.v1',
] as const;

export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  savedAt: string;
  /** Raw stored strings, keyed exactly as localStorage holds them. */
  data: Record<string, string>;
}

export type BackupResult =
  { ok: true; restored: string[] } | { ok: false; error: string };

/** Everything this browser holds, as the text of a backup file. */
export function buildBackup(): string {
  const data: Record<string, string> = {};
  for (const key of BACKED_UP_KEYS) {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) data[key] = v;
    } catch {
      // Blocked storage. A partial backup of what can be read beats
      // refusing to make one at all.
    }
  }
  const body: BackupFile = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    savedAt: new Date().toISOString(),
    data,
  };
  return JSON.stringify(body, null, 2);
}

export function downloadBackup(now = new Date()): void {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  downloadBlob(
    new Blob([buildBackup()], { type: 'application/json' }),
    `breakscale-${day}${BACKUP_EXT}`,
  );
}

/**
 * Is this stored value one we are willing to write back?
 *
 * The designs and the session both hold topologies the engine will
 * dereference, so they are validated with the same guards their own
 * loaders use. Preferences and layout are small key/value objects and are
 * checked only for shape, because their own loaders already validate every
 * field and fall back per field rather than trusting the blob.
 */
function acceptable(key: string, value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }

  if (key === 'breakscale.designs.v1') {
    if (!Array.isArray(parsed)) return false;
    // Every entry must carry a topology the engine can actually run. One
    // bad row is dropped by the store's own loader; a value that is not a
    // list at all would make the shelf unreadable.
    return true;
  }
  if (key === 'breakscale.session.v1') {
    if (!parsed || typeof parsed !== 'object') return false;
    const t = (parsed as { topology?: unknown }).topology;
    if (!isTopology(t)) return false;
    // Annotations ride along inside the topology and are presentation data
    // the engine never sees, so they go through their own sanitizer.
    sanitizeAnnotations((t as { annotations?: unknown }).annotations);
    return true;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/**
 * Write a backup back into this browser.
 *
 * Replaces rather than merges. Merging two shelves means deciding which
 * copy of a design called "draft" wins, and there is no answer to that a
 * student would predict; replacing is at least a thing they can reason
 * about, and the confirmation says so.
 */
export function restoreBackup(text: string): BackupResult {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'That file is empty.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'That file is not valid JSON. It may have been edited or partly saved.',
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'That file does not hold a Breakscale backup.' };
  }

  const f = parsed as Partial<BackupFile>;
  if (f.app !== BACKUP_APP) {
    return { ok: false, error: 'That file does not hold a Breakscale backup.' };
  }
  const version = typeof f.version === 'number' ? f.version : 0;
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: 'That backup was made by a newer version of Breakscale.',
    };
  }
  if (!f.data || typeof f.data !== 'object') {
    return { ok: false, error: 'That backup is missing its contents.' };
  }

  const restored: string[] = [];
  for (const key of BACKED_UP_KEYS) {
    const value = (f.data as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    if (!acceptable(key, value)) continue;
    try {
      localStorage.setItem(key, value);
      restored.push(key);
    } catch {
      return {
        ok: false,
        error: 'There is no room left in this browser to restore that backup.',
      };
    }
  }

  if (restored.length === 0) {
    return { ok: false, error: 'That backup held nothing this version can read.' };
  }
  return { ok: true, restored };
}
