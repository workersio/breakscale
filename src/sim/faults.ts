import { canCrashOneInstance } from './behaviour';
import type { FailureKind, FailureOpts, FaultEvent, NodeKind, Topology } from './types';
import { FAILURE_KINDS } from './types';

/* ------------------------------------------------------------------ *
 * Fault schedules crossing a trust boundary.
 *
 * A schedule arrives from a saved design, an imported file, a link or a
 * model writing a design over MCP, so nothing about it is assumed. One
 * validator serves all of them: the app's loaders drop a bad entry and keep
 * the rest, the way `sanitizeAnnotations` does, and the MCP path passes
 * `onDrop` to turn each dropped entry into an error the model can fix.
 * ------------------------------------------------------------------ */

/**
 * Ceiling on schedule length, applied before any work. A real run has a
 * handful of faults; a few hundred is already a stress test, and a hostile
 * file claiming a million must fail on the count.
 */
export const MAX_FAULT_EVENTS = 1000;

const ACTIONS: readonly FaultEvent['action'][] = ['inject', 'clear', 'cut', 'restore'];

/**
 * Validate a fault schedule, entry by entry.
 *
 * With `topology`, an entry naming a node or edge that is not in it is
 * dropped too; without it only the shape is checked, which is what the
 * engine does, since it checks targets when an entry comes due. Entries are
 * rebuilt field by field, so nothing an entry carried beyond its own fields
 * survives, and their order is kept: the engine sorts by time itself.
 */
export function sanitizeFaults(
  input: unknown,
  topology?: Pick<Topology, 'nodes' | 'edges'>,
  onDrop?: (index: number, why: string) => void,
): FaultEvent[] {
  if (!Array.isArray(input)) return [];
  const nodeKinds = topology
    ? new Map<string, NodeKind>(topology.nodes.map((n) => [n.id, n.kind]))
    : null;
  const edgeIds = topology ? new Set(topology.edges.map((e) => e.id)) : null;
  const out: FaultEvent[] = [];

  input.forEach((raw: unknown, index) => {
    const why = problemWith(raw, nodeKinds, edgeIds, index);
    if (why === null) out.push(rebuild(raw as FaultEvent));
    else onDrop?.(index, why);
  });
  return out;
}

/** Why an entry cannot be played, or null when it can. */
function problemWith(
  raw: unknown,
  nodeKinds: ReadonlyMap<string, NodeKind> | null,
  edgeIds: ReadonlySet<string> | null,
  index: number,
): string | null {
  if (index >= MAX_FAULT_EVENTS) {
    return `is past the limit of ${MAX_FAULT_EVENTS} faults.`;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'is not an object.';
  const f = raw as Record<string, unknown>;

  if (typeof f.atMs !== 'number' || !Number.isFinite(f.atMs) || f.atMs < 0) {
    return `has atMs ${shown(f.atMs)}; use a time in milliseconds, 0 or more.`;
  }
  if (!ACTIONS.includes(f.action as FaultEvent['action'])) {
    return `has action ${JSON.stringify(f.action)}; use inject, clear, cut or restore.`;
  }

  if (f.action === 'cut' || f.action === 'restore') {
    if (typeof f.edgeId !== 'string' || f.edgeId === '') return 'needs `edgeId`.';
    if (edgeIds && !edgeIds.has(f.edgeId)) {
      return `names edge '${f.edgeId}', but there is no such edge.`;
    }
    return null;
  }

  if (typeof f.nodeId !== 'string' || f.nodeId === '') return 'needs `nodeId`.';
  const nodeKind = nodeKinds?.get(f.nodeId);
  if (nodeKinds && nodeKind === undefined) {
    return `names node '${f.nodeId}', but there is no such node.`;
  }
  if (f.action === 'clear') return null;

  if (!FAILURE_KINDS.includes(f.kind as FailureKind)) {
    return `has kind ${JSON.stringify(f.kind)}; use ${FAILURE_KINDS.join(', ')}.`;
  }
  // Checked here rather than left to the engine, which ignores such an entry:
  // a schedule that says a machine died should not load as one where nothing
  // happened.
  if (
    f.kind === 'crash-instance' &&
    nodeKind !== undefined &&
    !canCrashOneInstance(nodeKind)
  ) {
    return `crashes one instance of '${f.nodeId}', but a ${nodeKind} cannot lose one instance; use crash.`;
  }
  if (f.opts === undefined) return null;
  if (!f.opts || typeof f.opts !== 'object' || Array.isArray(f.opts)) {
    return 'has `opts` that is not an object.';
  }
  const o = f.opts as Record<string, unknown>;
  for (const key of ['factor', 'rate'] as const) {
    if (
      o[key] !== undefined &&
      (typeof o[key] !== 'number' || !Number.isFinite(o[key]))
    ) {
      return `has opts.${key} ${shown(o[key])}; use a number.`;
    }
  }
  if (o.edgeIds !== undefined) {
    if (!Array.isArray(o.edgeIds) || o.edgeIds.some((id) => typeof id !== 'string')) {
      return 'has opts.edgeIds that is not a list of edge ids.';
    }
    const missing = o.edgeIds.find(
      (id: string) => edgeIds !== null && !edgeIds.has(id),
    );
    if (missing !== undefined) {
      return `cuts edge '${missing}', but there is no such edge.`;
    }
  }
  return null;
}

/** A value as a reader would type it: NaN reads as NaN, not as JSON's null. */
function shown(v: unknown): string {
  return typeof v === 'number' ? String(v) : JSON.stringify(v);
}

/** A fresh copy carrying only the fields its action uses. */
function rebuild(f: FaultEvent): FaultEvent {
  switch (f.action) {
    case 'cut':
    case 'restore':
      return { atMs: f.atMs, action: f.action, edgeId: f.edgeId };
    case 'clear':
      return { atMs: f.atMs, action: 'clear', nodeId: f.nodeId };
    case 'inject': {
      const opts: FailureOpts = {};
      if (f.opts?.factor !== undefined) opts.factor = f.opts.factor;
      if (f.opts?.rate !== undefined) opts.rate = f.opts.rate;
      if (f.opts?.edgeIds !== undefined) opts.edgeIds = f.opts.edgeIds.slice();
      return {
        atMs: f.atMs,
        action: 'inject',
        nodeId: f.nodeId,
        kind: f.kind,
        ...(Object.keys(opts).length > 0 ? { opts } : {}),
      };
    }
  }
}
