import type { Topology } from './sim/types';
import { isTopology } from './clipboard';
import { sanitizeAnnotations } from './sim/annotations';
import { sanitizeFaults } from './sim/faults';
import { sanitizeSeed } from './sim/seed';

/* ------------------------------------------------------------------ *
 * Saving a design to a file, and reading one back.
 *
 * A share link carries a design between two browsers; a file carries it
 * between two people, or between today and a laptop that will be
 * reformatted before the term ends. The two want the same care and the
 * same validation, so this module is the file half of that story: build
 * the bytes, hand them to the browser as a download, and treat anything
 * that comes back in through the file picker as hostile until every field
 * has been checked.
 *
 * The parse half is pure data-in data-out and never touches the DOM, so
 * the whole trust boundary is unit testable without a browser. Only
 * `downloadDesign` and `readDesignFile` need one.
 * ------------------------------------------------------------------ */

/**
 * Marker written into every exported file, and required on the way back
 * in. It is not security, it is a courtesy: a student who opens the wrong
 * JSON gets "this is not a Breakscale design" instead of a wall of field
 * complaints about a file that was never ours to begin with.
 */
export const DESIGN_FILE_APP = 'breakscale';

/**
 * Format version of the file body.
 *
 * Bumped only when the shape changes in a way an older reader could not
 * understand. A reader accepts its own version and anything below it, so
 * a file written today keeps opening after the next change; a file from
 * the future is refused with a message that says to update, rather than
 * being half-read into a design missing whatever it gained.
 */
export const DESIGN_FILE_VERSION = 1;

/**
 * The extension every exported design carries.
 *
 * A bare `.breakscale` rather than `.breakscale.json`, following the same
 * choice Excalidraw makes with `.excalidraw`: the contents are JSON either
 * way, but a custom extension is what an operating system can associate with
 * an application, and it reads as a document belonging to this app rather
 * than as a data file that happens to be lying around.
 *
 * `.json` stays accepted on import, so a file saved before this change, or
 * one a text editor helpfully renamed, still opens.
 */
export const DESIGN_FILE_EXT = '.breakscale';

/** What the file picker will offer, which is broader than what we write. */
export const DESIGN_FILE_ACCEPT = '.breakscale,.breakscale.json,application/json';

/** What one exported file holds. */
export interface DesignFile {
  app: typeof DESIGN_FILE_APP;
  version: number;
  /** When it was written, ISO 8601. Informational; nothing reads it back. */
  savedAt: string;
  /** The preset it started from, when it started from one. */
  name?: string;
  topology: Topology;
}

/**
 * A design that survived validation, or the reason it did not.
 *
 * A discriminated union rather than "null means no": every rejection here
 * has a cause a student can act on, and returning null would throw that
 * away and leave the interface with nothing to say but "failed".
 */
export type DesignParseResult =
  { ok: true; topology: Topology; name: string | null } | { ok: false; error: string };

/**
 * Serialise the current design, annotations included, as the text of a
 * `.breakscale` file.
 *
 * Deep copied on the way out so the caller's live topology can never be
 * reached through the value being written, and pretty printed with two
 * spaces because a design file is something a student may well open in an
 * editor to see what a component's settings actually are.
 */
export function buildDesignFile(topology: Topology, name?: string | null): string {
  const body: DesignFile = {
    app: DESIGN_FILE_APP,
    version: DESIGN_FILE_VERSION,
    savedAt: new Date().toISOString(),
    ...(name ? { name } : {}),
    topology: structuredClone(topology),
  };
  return JSON.stringify(body, null, 2);
}

/**
 * The file name a save offers, from the design's name plus the date.
 *
 * The date is in the name rather than left to the operating system's
 * "(2)" suffix, because a student exporting the same example twice in a
 * week wants to know which one is which without opening both.
 */
export function designFileName(
  name: string | null | undefined,
  now = new Date(),
): string {
  const stem = slug(name) || 'design';
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${stem}-${day}${DESIGN_FILE_EXT}`;
}

/**
 * Lowercase, hyphenated, ASCII. A design name is free text and can hold
 * anything a student can type, including characters a file system will
 * refuse or a shell will treat as an argument, so nothing that is not a
 * letter, a digit or a hyphen survives this.
 */
function slug(name: string | null | undefined): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Validate the text of a file someone chose or dropped.
 *
 * This is the trust boundary. A file can hold anything: half a download,
 * someone else's JSON, a design hand-edited into nonsense, or a colour
 * field written to break out of a style attribute. Nothing here throws
 * and nothing here half-applies. Either every field the engine will
 * dereference has been checked and a whole topology comes back, or a
 * sentence comes back saying what was wrong and the caller leaves the
 * student's current design exactly as it was.
 *
 * The two validators are the same ones the clipboard and the stored
 * session use: `isTopology` for what the engine reads (and it rejects a
 * dangling edge, which would otherwise route traffic into nothing), and
 * `sanitizeAnnotations` for the presentation data the engine never sees.
 */
export function parseDesignFile(text: string): DesignParseResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'That file is empty.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        'That file is not valid JSON. It may have been edited or only partly saved.',
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'That file does not hold a Breakscale design.' };
  }

  const f = parsed as Partial<Record<keyof DesignFile, unknown>>;
  if (f.app !== DESIGN_FILE_APP) {
    return { ok: false, error: 'That file does not hold a Breakscale design.' };
  }

  const version =
    typeof f.version === 'number' && Number.isFinite(f.version) ? f.version : 0;
  if (version > DESIGN_FILE_VERSION) {
    return {
      ok: false,
      error:
        'That design was saved by a newer version of Breakscale. Reload the page and try again.',
    };
  }

  const raw = f.topology;
  if (!isTopology(raw)) {
    return {
      ok: false,
      error:
        'That design is damaged: a component or a connection is missing something the simulator needs.',
    };
  }

  // Rebuilt field by field rather than spread, so nothing the file carried
  // beyond nodes, edges, annotations, its fault schedule and its seed
  // reaches the engine.
  const annotations = sanitizeAnnotations(
    (raw as { annotations?: unknown }).annotations,
  );
  const faults = sanitizeFaults((raw as { faults?: unknown }).faults, raw);
  const seed = sanitizeSeed((raw as { seed?: unknown }).seed);
  const topology: Topology = {
    nodes: structuredClone(raw.nodes),
    edges: structuredClone(raw.edges),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(faults.length > 0 ? { faults } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };

  return {
    ok: true,
    topology,
    name:
      typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 80) : null,
  };
}

/**
 * Hand the design to the browser as a download.
 *
 * An object URL, a synthetic click, then `revokeObjectURL`: the URL holds
 * the whole file in memory until it is revoked, and a student who exports
 * twenty times while tuning a system would otherwise be carrying twenty
 * copies for the life of the tab. The revoke is deferred one frame
 * because Safari cancels a download whose URL is revoked in the same task
 * that started it.
 */
export function downloadDesign(
  topology: Topology,
  name?: string | null,
  now = new Date(),
): void {
  const text = buildDesignFile(topology, name);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = designFileName(name, now);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Read a chosen or dropped file and validate it.
 *
 * A read can fail on its own (the file was moved or a permission was
 * withdrawn between the pick and the read), so that failure gets the same
 * treatment as a malformed body: a sentence, never a throw.
 */
export async function readDesignFile(file: File): Promise<DesignParseResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: 'That file could not be read.' };
  }
  return parseDesignFile(text);
}
