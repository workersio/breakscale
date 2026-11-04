import { isTopology } from './clipboard';
import { sanitizeAnnotations } from './sim/annotations';
import { sanitizeFaults } from './sim/faults';
import { sanitizeSeed } from './sim/seed';
import type { Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * Named saves.
 *
 * The autosaved session answers "where was I", and a file answers "keep
 * this forever". Neither answers "let me try a second idea without losing
 * the first", which is the thing a student actually does: build a design,
 * wonder what a cache would do, and want both afterwards.
 *
 * Kept in localStorage beside the session rather than in a file, because
 * the whole point is that it costs one click and no dialog. Files remain
 * the way to move a design between machines; this is the way to keep
 * several on one.
 *
 * Everything read back crosses a trust boundary. Storage can be edited by
 * hand, half-written when a tab is killed, or left over from an older
 * version of the format, so nothing here trusts its own shelf.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'breakscale.designs.v1';

/**
 * How many designs are kept.
 *
 * A cap rather than unlimited: localStorage is a shared 5MB budget per
 * origin, and a large topology serialises to tens of kilobytes. Twenty is
 * comfortably inside that and far more than the number of ideas anyone
 * juggles at once. The oldest is dropped when a new save would exceed it,
 * which is announced rather than silent.
 */
export const MAX_SAVED = 20;

/** Longest name kept. Anything past this is a paragraph, not a name. */
export const MAX_NAME = 60;

export interface SavedDesign {
  /** Stable id, so a rename never orphans the entry. */
  id: string;
  name: string;
  /** Milliseconds since the epoch, for ordering and for "saved 2 hours ago". */
  savedAt: number;
  topology: Topology;
}

/** What the interface shows in a list, without paying to parse every topology. */
export interface SavedSummary {
  id: string;
  name: string;
  savedAt: number;
  nodeCount: number;
}

function newId(): string {
  // crypto.randomUUID is absent in older Safari and in some test
  // environments, so a timestamped random suffix stands in. Collisions do
  // not matter here beyond one entry, and the timestamp makes them
  // vanishingly unlikely anyway.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validate one stored entry.
 *
 * Returns null rather than throwing, so one corrupt design costs its own
 * row and not the whole list.
 */
function parseEntry(raw: unknown): SavedDesign | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id) return null;
  if (!isTopology(e.topology)) return null;

  const annotations = sanitizeAnnotations(
    (e.topology as { annotations?: unknown }).annotations,
  );
  const faults = sanitizeFaults(
    (e.topology as { faults?: unknown }).faults,
    e.topology,
  );
  const seed = sanitizeSeed((e.topology as { seed?: unknown }).seed);
  return {
    id: e.id,
    name:
      typeof e.name === 'string' && e.name.trim()
        ? e.name.slice(0, MAX_NAME)
        : 'Untitled',
    savedAt:
      typeof e.savedAt === 'number' && Number.isFinite(e.savedAt) ? e.savedAt : 0,
    // Rebuilt field by field, so nothing the entry carried beyond these
    // fields reaches the engine.
    topology: {
      nodes: e.topology.nodes,
      edges: e.topology.edges,
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(faults.length > 0 ? { faults } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}

/**
 * The shelf as it actually sits in storage: the rows this version understands,
 * and the rows it does not.
 *
 * The second list is why this exists. Dropping a row that fails to parse is
 * right for DISPLAY, but every mutation here is read, change, write, so a row
 * dropped on the way in is a row deleted on the way out. Saving an unrelated
 * design was enough to erase someone else's, permanently, with nothing said.
 *
 * So the unreadable rows are carried through verbatim. A row this build cannot
 * open is not necessarily a row that is gone: it may be a newer format, or a
 * design tripped by a bug that a later build fixes. Keeping the bytes leaves
 * that recovery possible; rewriting the shelf without them does not.
 */
interface Shelf {
  designs: SavedDesign[];
  /** Rows that failed to parse, exactly as stored. Never inspected further. */
  unreadable: unknown[];
}

function readShelf(): Shelf {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { designs: [], unreadable: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { designs: [], unreadable: [] };

    const designs: SavedDesign[] = [];
    const unreadable: unknown[] = [];
    for (const row of parsed) {
      const entry = parseEntry(row);
      if (entry) designs.push(entry);
      // Bounded for the same reason MAX_SAVED exists: localStorage is a
      // shared 5MB budget, and rows nobody can open must not grow without
      // limit. Past the cap the oldest bytes go, which is the same trade the
      // readable half already makes.
      else if (unreadable.length < MAX_SAVED) unreadable.push(row);
    }
    designs.sort((a, b) => b.savedAt - a.savedAt);
    return { designs, unreadable };
  } catch {
    // Corrupt JSON or blocked storage. An empty shelf is a survivable
    // outcome; a thrown error during boot is not.
    return { designs: [], unreadable: [] };
  }
}

/** Everything on the shelf this build can open, newest first. */
export function loadDesigns(): SavedDesign[] {
  return readShelf().designs;
}

/** The list the interface renders, without the topologies. */
export function listDesigns(): SavedSummary[] {
  return loadDesigns().map((d) => ({
    id: d.id,
    name: d.name,
    savedAt: d.savedAt,
    nodeCount: d.topology.nodes.length,
  }));
}

function write(designs: SavedDesign[], unreadable: readonly unknown[]): boolean {
  try {
    // The rows we could not parse go back untouched, after the ones we could.
    // Order among them does not matter: nothing reads them, and the readable
    // half is sorted on the way in.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...designs, ...unreadable]));
    return true;
  } catch {
    // Quota exceeded, or storage disabled. Reported rather than swallowed:
    // unlike the autosave, a save the student ASKED for must not appear to
    // have worked when it did not.
    return false;
  }
}

export type SaveResult =
  { ok: true; id: string; evicted: string | null } | { ok: false; error: string };

/**
 * Save the current design under a name.
 *
 * Saving over an existing NAME replaces that entry rather than adding a
 * second one, which is what someone pressing save twice means. Everything
 * else is an insert.
 */
export function saveDesign(name: string, topology: Topology): SaveResult {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) return { ok: false, error: 'Give the design a name first.' };

  const { designs, unreadable } = readShelf();
  const existing = designs.findIndex(
    (d) => d.name.toLowerCase() === clean.toLowerCase(),
  );
  const entry: SavedDesign = {
    id: existing >= 0 ? designs[existing]!.id : newId(),
    name: clean,
    savedAt: Date.now(),
    topology: structuredClone(topology),
  };

  const next = existing >= 0 ? designs.with(existing, entry) : [entry, ...designs];
  next.sort((a, b) => b.savedAt - a.savedAt);

  // The oldest goes when the shelf is full, and the caller is told which,
  // so the interface can say so rather than letting work vanish quietly.
  let evicted: string | null = null;
  if (next.length > MAX_SAVED) {
    evicted = next[next.length - 1]!.name;
    next.length = MAX_SAVED;
  }

  if (!write(next, unreadable)) {
    return {
      ok: false,
      error: 'There is no room left in this browser to save another design.',
    };
  }
  return { ok: true, id: entry.id, evicted };
}

/** One design, by id, or null if it is gone. */
export function getDesign(id: string): SavedDesign | null {
  return loadDesigns().find((d) => d.id === id) ?? null;
}

export function deleteDesign(id: string): void {
  const { designs, unreadable } = readShelf();
  write(
    designs.filter((d) => d.id !== id),
    unreadable,
  );
}

/** Rename in place. Returns false when the name is empty or already taken. */
export function renameDesign(id: string, name: string): boolean {
  const clean = name.trim().slice(0, MAX_NAME);
  if (!clean) return false;
  const { designs, unreadable } = readShelf();
  if (
    designs.some((d) => d.id !== id && d.name.toLowerCase() === clean.toLowerCase())
  ) {
    return false;
  }
  const i = designs.findIndex((d) => d.id === id);
  if (i < 0) return false;
  return write(designs.with(i, { ...designs[i]!, name: clean }), unreadable);
}

/**
 * "2 hours ago", for the list.
 *
 * Relative rather than a timestamp: what a student wants to know is which
 * of two designs is the one they were just working on, and "14:32" only
 * answers that if they remember what time it was.
 */
export function savedAgo(savedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
