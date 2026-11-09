import { NODE_KINDS, isTopology } from '../../src/clipboard';
import { WIRE_FIELDS, WIRE_SCHEMA } from '../../src/share/wire';
import { sanitizeAnnotations } from '../../src/sim/annotations';
import { behaviourFor } from '../../src/sim/behaviour';
import { sanitizeFaults } from '../../src/sim/faults';
import { MAX_SEED, sanitizeSeed } from '../../src/sim/seed';
import { defaultConfig } from '../../src/sim/presets';
import {
  BULKHEAD_MODES,
  TRAFFIC_PATTERNS,
  type NodeConfig,
  type NodeKind,
  type SimEdge,
  type SimNode,
  type Topology,
} from '../../src/sim/types';
import { defaultLabel, suggestKind } from './kinds';

/* ------------------------------------------------------------------ *
 * Turning what a model wrote into a topology the engine can run.
 *
 * The app's own trust boundary (`parseDesignFile`) answers a student who
 * picked the wrong file, so one sentence is enough: "that design is
 * damaged". A model needs the opposite. It will fix exactly what it is
 * told and nothing else, so every rejection here names the node or the
 * edge, says what was wrong with it, and lists what would have been
 * accepted. All the problems come back at once, because a model that
 * learns about them one call at a time spends five calls on one design.
 *
 * The input is deliberately smaller than a saved topology. A node needs
 * an id and a kind; everything else has a default. That is what makes
 * "draw me a rate limiter" one short call, and a full `.breakscale` file
 * is still accepted as is, because it is the same shape with every
 * optional field filled in.
 * ------------------------------------------------------------------ */

export type DesignResult =
  | { ok: true; topology: Topology; name: string | null }
  | { ok: false; errors: string[] };

/** Past this the model is better served by fixing the first batch. */
const MAX_ERRORS = 12;

/** A design this large is not something anyone reads on one canvas. */
export const MAX_NODES = 200;

/** Canvas geometry, from Canvas.tsx, for placing nodes that came without a position. */
const NODE_W = 184;
const NODE_H = 88;
const GRID = 8;
const COL_GAP = 80;
const ROW_GAP = 48;
const MARGIN = 40;

const FIELDS: ReadonlySet<string> = new Set(WIRE_FIELDS);

/**
 * Settings whose value is a word rather than a number. Everything else in
 * NodeConfig is numeric, which the wire format already relies on.
 */
const WORD_FIELDS: Readonly<Record<string, readonly string[]>> = {
  traffic: TRAFFIC_PATTERNS,
  bulkheadMode: BULKHEAD_MODES,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function quoted(list: readonly string[]): string {
  return list.map((s) => `'${s}'`).join(', ');
}

/** The closest known word, for "did you mean". Case and punctuation only. */
function suggest(word: string, known: readonly string[]): string | null {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = squash(word);
  return known.find((k) => squash(k) === target) ?? null;
}

/**
 * Validate and expand a design. Accepts the short form (`{ nodes, edges }`)
 * or a whole `.breakscale` file, which carries the same thing under
 * `topology`.
 */
export function buildTopology(input: unknown): DesignResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ['A design is an object with `nodes` and `edges`.'] };
  }
  const body = isRecord(input.topology) ? input.topology : input;
  const errors: string[] = [];
  const fail = (msg: string) => {
    if (errors.length < MAX_ERRORS) errors.push(msg);
  };

  if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
    return { ok: false, errors: ['`nodes` must be a non-empty array.'] };
  }
  if (body.nodes.length > MAX_NODES) {
    return {
      ok: false,
      errors: [`That is ${body.nodes.length} nodes; the limit is ${MAX_NODES}.`],
    };
  }
  if (body.edges !== undefined && !Array.isArray(body.edges)) {
    return { ok: false, errors: ['`edges` must be an array.'] };
  }

  const nodes: SimNode[] = [];
  const placed = new Set<string>();
  const ids = new Set<string>();

  body.nodes.forEach((raw: unknown, i: number) => {
    const where = `nodes[${i}]`;
    if (!isRecord(raw)) return fail(`${where} is not an object.`);
    const id = raw.id;
    if (typeof id !== 'string' || id.trim() === '') {
      return fail(
        `${where} needs an \`id\`, a short unique string like 'api' or 'db'.`,
      );
    }
    const name = `node '${id}'`;
    if (ids.has(id)) return fail(`Two nodes share the id '${id}'. Ids must be unique.`);
    ids.add(id);

    const kind = raw.kind;
    if (typeof kind !== 'string' || !NODE_KINDS.includes(kind as NodeKind)) {
      const hint = typeof kind === 'string' ? suggestKind(kind) : null;
      return fail(
        `${name} has kind ${JSON.stringify(kind)}, which is not a component.` +
          (hint ? ` Did you mean '${hint}'?` : ` Kinds: ${quoted(NODE_KINDS)}.`),
      );
    }

    const config = expandConfig(kind as NodeKind, raw.config, name, fail);
    const label =
      typeof raw.label === 'string' && raw.label.trim()
        ? raw.label.trim().slice(0, 60)
        : defaultLabel(kind as NodeKind);

    const hasX = Number.isFinite(raw.x);
    const hasY = Number.isFinite(raw.y);
    if (hasX && hasY) placed.add(id);
    nodes.push({
      id,
      kind: kind as NodeKind,
      label,
      x: hasX ? (raw.x as number) : 0,
      y: hasY ? (raw.y as number) : 0,
      config,
    });
  });

  const edges: SimEdge[] = [];
  const edgeIds = new Set<string>();
  const rawEdges: unknown[] = Array.isArray(body.edges) ? body.edges : [];
  rawEdges.forEach((raw, i) => {
    const where = `edges[${i}]`;
    if (!isRecord(raw)) return fail(`${where} is not an object.`);
    const { from, to } = raw;
    if (typeof from !== 'string' || typeof to !== 'string') {
      return fail(`${where} needs \`from\` and \`to\`, each a node id.`);
    }
    const missing = [from, to].filter((end) => !ids.has(end));
    if (missing.length > 0) {
      return fail(
        `${where} goes from '${from}' to '${to}', but there is no node ${quoted(missing)}.`,
      );
    }
    if (from === to) return fail(`${where} connects '${from}' to itself.`);
    // The engine lets a consumer be wired to its queue in either direction,
    // so an edge from a worker INTO a queue makes the worker drain that
    // queue too. A model means "publishes to" by it, and the result is a
    // loop that feeds the worker its own output while the queue's real
    // consumer starves.
    const source = nodes.find((n) => n.id === from);
    const target = nodes.find((n) => n.id === to);
    if (
      source &&
      target &&
      behaviourFor(source.kind).pullsFromQueues &&
      behaviourFor(target.kind).buffersForConsumers
    ) {
      return fail(
        `${where} goes from ${source.kind} '${from}' into ${target.kind} '${to}'. A ${source.kind} wired to a ${target.kind} drains it, whichever way the edge points. ` +
          `If '${from}' consumes '${to}', draw it as '${to}' to '${from}'. If '${from}' publishes to '${to}', put a service between them.`,
      );
    }
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `${from}->${to}`;
    if (edgeIds.has(id)) {
      return fail(`${where} repeats the connection '${from}' to '${to}'.`);
    }
    edgeIds.add(id);

    const weight = raw.weight ?? 1;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return fail(
        `${where} has weight ${JSON.stringify(raw.weight)}; use a number, 0 or more.`,
      );
    }
    const edge: SimEdge = { id, from, to, weight };
    // The engine already treats an autoscaler's edges as control; setting
    // the flag too is what makes the canvas draw them as control, the way
    // every example does.
    if (
      raw.control === true ||
      nodes.find((n) => n.id === from)?.kind === 'autoscaler'
    ) {
      edge.control = true;
    }
    if (typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs)) {
      edge.latencyMs = Math.max(0, raw.latencyMs);
    }
    // Refused rather than clamped, like the seed: 5 most likely meant 5%,
    // and a link that drops everything is not what was asked for.
    if (raw.lossRate !== undefined) {
      const loss = raw.lossRate;
      if (typeof loss !== 'number' || !Number.isFinite(loss) || loss < 0 || loss > 1) {
        return fail(
          `${where} has lossRate ${JSON.stringify(loss)}; use a fraction from 0 to 1, so 0.05 drops 5%.`,
        );
      }
      if (loss > 0) edge.lossRate = loss;
    }
    edges.push(edge);
  });

  // The fault schedule is optional. An entry the engine could not play is an
  // error here, not a silent drop as in the app, so the model can fix it.
  if (body.faults !== undefined && !Array.isArray(body.faults)) {
    fail('`faults` must be an array.');
  }
  const faults = sanitizeFaults(body.faults, { nodes, edges }, (i, why) =>
    fail(`faults[${i}] ${why}`),
  );
  // The seed is optional too, and refused rather than rounded: the engine
  // would fold 1.5 into some other seed and the run would not be the one
  // the design asked for.
  const seed = sanitizeSeed(body.seed);
  if (body.seed !== undefined && seed === undefined) {
    fail(
      `\`seed\` is ${JSON.stringify(body.seed)}; use a whole number from 0 to ${MAX_SEED}.`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  if (placed.size < nodes.length) layout(nodes, edges, placed);

  const annotations = sanitizeAnnotations(body.annotations);
  const topology: Topology = {
    nodes,
    edges,
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(faults.length > 0 ? { faults } : {}),
    ...(seed !== undefined ? { seed } : {}),
  };
  // Belt and braces: the same gate the app puts every stored or pasted
  // design through. Anything that passed the checks above and fails here
  // is a bug in this file, not in the model's design.
  if (!isTopology(topology)) {
    return { ok: false, errors: ['The design could not be built. This is a bug.'] };
  }

  const rawName = isRecord(input) ? input.name : undefined;
  const name =
    typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 80) : null;
  return { ok: true, topology, name };
}

/** A node's defaults with the model's overrides on top, each one checked. */
function expandConfig(
  kind: NodeKind,
  raw: unknown,
  name: string,
  fail: (msg: string) => void,
): NodeConfig {
  const config = defaultConfig(kind);
  if (raw === undefined) return config;
  if (!isRecord(raw)) {
    fail(`${name} has a \`config\` that is not an object.`);
    return config;
  }
  const settable = config as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (!FIELDS.has(key)) {
      const hint = suggest(key, WIRE_SCHEMA[kind]);
      fail(
        `${name} (${kind}) has no setting '${key}'.` +
          (hint
            ? ` Did you mean '${hint}'?`
            : ` Its settings are ${quoted(WIRE_SCHEMA[kind])}.`),
      );
      continue;
    }
    const words = WORD_FIELDS[key];
    if (words) {
      if (typeof value !== 'string' || !words.includes(value)) {
        fail(`${name}: '${key}' must be one of ${quoted(words)}.`);
        continue;
      }
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(
        `${name}: '${key}' must be a number, 0 or more; got ${JSON.stringify(value)}.`,
      );
      continue;
    }
    settable[key] = value;
  }
  return config;
}

/**
 * Place the nodes that came without a position, left to right in the
 * direction requests flow, which is how every example in the app reads.
 *
 * A node's column is the longest request path from any entry point to it,
 * so a database both the API and a worker call sits past both. Cycles
 * (a retry queue feeding back into the service it retries) are cut by
 * capping the relaxation at one pass per node. A controller such as an
 * autoscaler shares its target's column, since it carries no traffic.
 */
function layout(nodes: SimNode[], edges: SimEdge[], placed: ReadonlySet<string>): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isControl = (e: SimEdge) =>
    e.control === true || byId.get(e.from)?.kind === 'autoscaler';
  const traffic = edges.filter((e) => !isControl(e));

  const col = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of traffic) {
      const next = (col.get(e.from) ?? 0) + 1;
      if (next > (col.get(e.to) ?? 0) && next < nodes.length) {
        col.set(e.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const e of edges) {
    if (isControl(e)) col.set(e.from, col.get(e.to) ?? 0);
  }

  const columns: SimNode[][] = [];
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    (columns[c] ??= []).push(n);
  }

  // Order each column by where its callers sit, so wires cross less.
  const row = new Map<string, number>();
  for (const column of columns) {
    if (!column) continue;
    const score = (n: SimNode) => {
      const parents = traffic.filter((e) => e.to === n.id && row.has(e.from));
      if (parents.length === 0) return Number.POSITIVE_INFINITY;
      return parents.reduce((s, e) => s + (row.get(e.from) ?? 0), 0) / parents.length;
    };
    const scored = column.map((n, i) => ({ n, i, s: score(n) }));
    scored.sort((a, b) => a.s - b.s || a.i - b.i);
    scored.forEach(({ n }, r) => row.set(n.id, r));
    column.splice(0, column.length, ...scored.map(({ n }) => n));
  }

  const tallest = Math.max(...columns.map((c) => c?.length ?? 0));
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  columns.forEach((column, c) => {
    if (!column) return;
    const offset = ((tallest - column.length) * (NODE_H + ROW_GAP)) / 2;
    column.forEach((n, r) => {
      if (placed.has(n.id)) return;
      n.x = snap(MARGIN + c * (NODE_W + COL_GAP));
      n.y = snap(MARGIN + offset + r * (NODE_H + ROW_GAP));
    });
  });
}
