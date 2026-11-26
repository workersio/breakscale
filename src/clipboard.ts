import type { NodeKind, SimEdge, SimNode, Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * Clipboard and duplication for the shell.
 *
 * One module owns the three operations that turn a selection into new
 * topology: serialising it for the system clipboard, validating whatever
 * comes back OFF the clipboard (untrusted by definition, exactly like a
 * share link), and stamping a subgraph with fresh ids so a duplicate or a
 * paste can never collide with a node that already exists.
 *
 * Everything here is pure data-in data-out, so the whole surface is unit
 * testable without a DOM.
 * ------------------------------------------------------------------ */

/**
 * Every kind the registry knows. This list gates what loads back out of
 * localStorage AND what is accepted from the clipboard, so every kind must
 * appear here or a student's saved or copied topology that uses it is
 * silently thrown away on restore.
 */
export const NODE_KINDS: readonly NodeKind[] = [
  'client',
  'lb',
  'service',
  'cache',
  'db',
  'queue',
  'worker',
  'replica',
  'shard',
  'autoscaler',
  'region',
  'cdn',
  'ratelimiter',
  'breaker',
  'objectstore',
  'searchindex',
  'timeseriesdb',
  'graphdb',
  'coldstorage',
  'vectordb',
  'streambroker',
  'pubsub',
  'websocket',
  'apigateway',
  'sidecar',
  'lambda',
  'cron',
  'bulkhead',
  'retryqueue',
  'transcoder',
  'edgecompute',
  'writebehind',
  'loadshedder',
];

/**
 * Structural validation of anything from outside the type system: a stored
 * session, a pasted clipboard payload. Every field the engine will
 * dereference is checked before it is trusted, and a dangling edge (which
 * would make the engine route into nothing) is rejected outright.
 */
export function isTopology(value: unknown): value is Topology {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(t.nodes) || !Array.isArray(t.edges)) return false;

  const ids = new Set<string>();
  for (const raw of t.nodes) {
    if (typeof raw !== 'object' || raw === null) return false;
    const n = raw as Partial<{
      id: unknown;
      kind: unknown;
      label: unknown;
      x: unknown;
      y: unknown;
      config: unknown;
    }>;
    if (typeof n.id !== 'string' || n.id === '') return false;
    if (typeof n.label !== 'string') return false;
    if (!NODE_KINDS.includes(n.kind as NodeKind)) return false;
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    if (typeof n.config !== 'object' || n.config === null) return false;
    const cfg = n.config as Record<string, unknown>;
    for (const key of [
      'capacity',
      'serviceMs',
      'serviceCv',
      'queueLimit',
      'hitRate',
      'errorRate',
      'timeoutMs',
      'retries',
      'rps',
    ]) {
      if (!Number.isFinite(cfg[key])) return false;
    }
    for (const key of [
      'chargeable',
      'idempotencyKeys',
      'flushEveryMs',
      'freshReads',
      'cacheKeys',
      'cacheTtlMs',
    ]) {
      if (cfg[key] !== undefined && !Number.isFinite(cfg[key])) return false;
    }
    if (ids.has(n.id)) return false;
    ids.add(n.id);
  }

  for (const raw of t.edges) {
    if (typeof raw !== 'object' || raw === null) return false;
    const e = raw as Partial<{
      id: unknown;
      from: unknown;
      to: unknown;
      weight: unknown;
    }>;
    if (typeof e.id !== 'string' || e.id === '') return false;
    if (typeof e.from !== 'string' || typeof e.to !== 'string') return false;
    if (!ids.has(e.from) || !ids.has(e.to)) return false;
    if (!Number.isFinite(e.weight)) return false;
  }

  return true;
}

/** What one copy operation carries: a self-contained subgraph. */
export interface ClipboardSubgraph {
  nodes: SimNode[];
  edges: SimEdge[];
}

/**
 * The selected nodes plus the edges BETWEEN them.
 *
 * An edge to something outside the selection is dropped: a pasted subgraph
 * must be self-contained, and a wire whose far end is a node the clipboard
 * does not carry would either dangle (rejected by validation) or grab some
 * unrelated node that happens to share an id in the receiving document.
 * Returns null when the selection holds no nodes; a lone edge cannot be
 * pasted into anything.
 */
export function selectionSubgraph(
  topology: Topology,
  selectedIds: ReadonlySet<string>,
): ClipboardSubgraph | null {
  const nodes = topology.nodes.filter((n) => selectedIds.has(n.id));
  if (nodes.length === 0) return null;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = topology.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
  return { nodes: structuredClone(nodes), edges: structuredClone(edges) };
}

/**
 * Serialise a selection for the system clipboard. Plain JSON with a marker
 * field, so a paste in a text editor shows something legible and a paste
 * back here has a cheap first check before the structural one.
 */
export function buildClipboardText(
  topology: Topology,
  selectedIds: ReadonlySet<string>,
): string | null {
  const sub = selectionSubgraph(topology, selectedIds);
  if (!sub) return null;
  return JSON.stringify({ app: 'breakscale', nodes: sub.nodes, edges: sub.edges });
}

/**
 * Parse clipboard text back into a subgraph. The clipboard is an untrusted
 * input channel exactly the way a share link is: anything can be on it, so
 * this validates the same way loadSession validates localStorage and
 * returns null for whatever does not hold up. It NEVER throws; a paste of
 * prose or of someone else's JSON is a silent no-op, not a crash.
 */
export function parseClipboardText(text: string): ClipboardSubgraph | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as { nodes?: unknown; edges?: unknown };
  const candidate = { nodes: p.nodes, edges: p.edges };
  if (!isTopology(candidate)) return null;
  return { nodes: candidate.nodes, edges: candidate.edges };
}

/**
 * An id of the same `kind-N` shape makeNode mints, guaranteed unused.
 *
 * Scanned against the live topology rather than a counter, because ids on
 * the clipboard may come from another tab whose counter this session never
 * saw, and a collision would silently merge two different nodes.
 */
function freshId(kind: NodeKind, used: Set<string>): string {
  let n = 1;
  while (used.has(`${kind}-${n}`)) n += 1;
  const id = `${kind}-${n}`;
  used.add(id);
  return id;
}

/**
 * Stamp a subgraph with fresh ids and an offset, ready to append to a
 * topology. Every internal edge is remapped to the new node ids and takes
 * the `from->to` id shape the rest of the app uses; config, label, weight
 * and the control flag all carry over. Used by Ctrl+D, alt-drag duplicate
 * and paste, so the three can never disagree about what a copy contains.
 */
export function cloneSubgraph(
  sub: ClipboardSubgraph,
  topology: Topology,
  dx: number,
  dy: number,
): ClipboardSubgraph {
  const used = new Set<string>();
  for (const n of topology.nodes) used.add(n.id);
  const idMap = new Map<string, string>();

  const nodes = sub.nodes.map((n) => {
    const id = freshId(n.kind, used);
    idMap.set(n.id, id);
    return {
      ...structuredClone(n),
      id,
      x: n.x + dx,
      y: n.y + dy,
    };
  });

  const edges: SimEdge[] = [];
  for (const e of sub.edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to) continue;
    edges.push({ ...structuredClone(e), id: `${from}->${to}`, from, to });
  }

  return { nodes, edges };
}
