import { describe, expect, it } from 'vitest';
import { NODE_KINDS } from '../clipboard';
import type { Annotation, Note, Section } from '../sim/annotations';
import { PRESETS, defaultConfig } from '../sim/presets';
import type { NodeConfig, NodeKind, SimEdge, SimNode, Topology } from '../sim/types';
import {
  WIRE_FIELDS,
  WIRE_KINDS,
  WIRE_SCHEMA,
  packTopology,
  unpackTopology,
} from './wire';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function node(
  id: string,
  kind: NodeKind,
  x = 0,
  y = 0,
  overrides: Partial<NodeConfig> = {},
  label?: string,
): SimNode {
  return {
    id,
    kind,
    label: label ?? `${kind} label`,
    x,
    y,
    config: { ...defaultConfig(kind), ...overrides },
  };
}

function edge(from: string, to: string, extra: Partial<SimEdge> = {}): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1, ...extra };
}

/**
 * What the wire promises to preserve: everything except the ids, which
 * it regenerates, and node coordinates, which it rounds. Edges are
 * compared by the INDEX of the nodes they join, which is what the wire
 * actually carries.
 */
function essence(t: Topology): unknown {
  const at = new Map(t.nodes.map((n, i) => [n.id, i]));
  return {
    nodes: t.nodes.map(({ id: _id, ...n }) => ({
      ...n,
      // `+ 0` folds -0 into 0; the wire has no negative zero.
      x: Math.round(n.x) + 0,
      y: Math.round(n.y) + 0,
    })),
    edges: t.edges.map(({ id: _id, from, to, ...e }) => ({
      ...e,
      from: at.get(from),
      to: at.get(to),
    })),
    annotations: (t.annotations ?? []).map(({ id: _id, ...a }) => a),
  };
}

function roundTrip(t: Topology): Topology {
  const out = unpackTopology(packTopology(t));
  expect(out).not.toBeNull();
  return out as Topology;
}

function expectRoundTrip(t: Topology): Topology {
  const out = roundTrip(t);
  expect(essence(out)).toEqual(essence(t));
  return out;
}

/* ------------------------------------------------------------------ *
 * Protocol tables
 * ------------------------------------------------------------------ */

describe('protocol tables', () => {
  it('names every kind the app knows, so no design is refused for its palette', () => {
    for (const kind of NODE_KINDS) expect(WIRE_KINDS).toContain(kind);
  });

  it('names every config field of every kind, so none can be silently trimmed', () => {
    for (const kind of NODE_KINDS) {
      for (const field of Object.keys(defaultConfig(kind))) {
        expect(WIRE_FIELDS, `${kind}.${field}`).toContain(field);
      }
    }
    // The type-level check: adding a field to NodeConfig without adding
    // it here is a compile error, which is the point.
    const every: Record<keyof NodeConfig, true> = {
      capacity: true,
      instances: true,
      serviceMs: true,
      serviceCv: true,
      queueLimit: true,
      hitRate: true,
      errorRate: true,
      timeoutMs: true,
      retries: true,
      rps: true,
      bulkheadMode: true,
      acquireQueueMax: true,
      acquireTimeoutMs: true,
      traffic: true,
      trafficPeriodS: true,
      targetUtil: true,
      minCapacity: true,
      maxCapacity: true,
      cooldownMs: true,
      scaleStepPct: true,
      warmupMs: true,
      regions: true,
      activeRegion: true,
      failoverMs: true,
      rateLimitRps: true,
      burst: true,
      errorThreshold: true,
      windowMs: true,
      openMs: true,
      halfOpenProbes: true,
      replicaCount: true,
      replicationLagMs: true,
      readFraction: true,
      shardCount: true,
      shardCapacity: true,
      hotKeyFraction: true,
      indexMs: true,
      indexLagMs: true,
      rangeQueryFraction: true,
      rangeQueryMs: true,
      traversalDepth: true,
      indexSizeK: true,
      recallTarget: true,
      partitions: true,
      connectionMs: true,
      authFailRate: true,
      outlierAfter: true,
      coldStartMs: true,
      keepWarmMs: true,
      maxConcurrency: true,
      intervalMs: true,
      batchSize: true,
      bulkheadMax: true,
      flushDelayMs: true,
      edgeShare: true,
      lowPriorityShare: true,
      priorityReserve: true,
      lockMs: true,
      prefixRps: true,
      renditions: true,
      cpuMsCap: true,
    };
    for (const field of Object.keys(every)) expect(WIRE_FIELDS).toContain(field);
  });

  it('gives every kind a schema whose fields are all wire fields', () => {
    for (const kind of WIRE_KINDS) {
      const schema = WIRE_SCHEMA[kind];
      expect(schema.length).toBeGreaterThan(0);
      expect(new Set(schema).size).toBe(schema.length);
      for (const f of schema) expect(WIRE_FIELDS).toContain(f);
    }
  });

  it('lists every knob a kind is born with in that kind’s schema', () => {
    // Otherwise a routine override would take the extras path, which is
    // still correct but costs a byte per field.
    for (const kind of WIRE_KINDS) {
      const schema = WIRE_SCHEMA[kind];
      for (const field of Object.keys(defaultConfig(kind))) {
        // EXTRA_DEFAULTS puts the replica and shard knobs on every kind;
        // only the kinds that read them need them in the schema.
        if (
          ['replicaCount', 'replicationLagMs'].includes(field) &&
          kind !== 'replica'
        ) {
          continue;
        }
        if (
          field === 'readFraction' &&
          !['replica', 'db', 'searchindex'].includes(kind)
        ) {
          continue;
        }
        if (
          ['shardCount', 'shardCapacity', 'hotKeyFraction'].includes(field) &&
          kind !== 'shard'
        ) {
          continue;
        }
        expect(schema, `${kind}.${field}`).toContain(field);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Round trips
 * ------------------------------------------------------------------ */

describe('round trip', () => {
  it('handles an empty topology', () => {
    const out = expectRoundTrip({ nodes: [], edges: [] });
    expect(out.annotations).toBeUndefined();
  });

  it('handles one node', () => {
    expectRoundTrip({ nodes: [node('a', 'service')], edges: [] });
  });

  it('handles one edge', () => {
    expectRoundTrip({
      nodes: [node('a', 'client'), node('b', 'service')],
      edges: [edge('a', 'b')],
    });
  });

  it('handles every kind at its defaults', () => {
    const nodes = NODE_KINDS.map((k, i) => node(`${k}-x`, k, i * 10, i * 20));
    expectRoundTrip({ nodes, edges: [] });
  });

  it('restores the default label from nothing, and keeps every other label', () => {
    const t: Topology = {
      nodes: [
        node('a', 'lb', 0, 0, {}, 'Load Balancer'),
        node('b', 'lb', 0, 0, {}, ''),
        node('c', 'lb', 0, 0, {}, 'load balancer'),
        node('d', 'lb', 0, 0, {}, 'Load Balancer '),
      ],
      edges: [],
    };
    const out = expectRoundTrip(t);
    expect(out.nodes.map((n) => n.label)).toEqual([
      'Load Balancer',
      '',
      'load balancer',
      'Load Balancer ',
    ]);
    // The default costs one byte; the others carry their text.
    const one = (label: string) =>
      packTopology({ nodes: [node('a', 'lb', 0, 0, {}, label)], edges: [] }).length;
    expect(one('Load Balancer')).toBeLessThan(one('Load Balancer '));
  });

  it('carries every config field of every kind when overridden', () => {
    // Each field gets a value no default uses, chosen per type: a
    // fraction for the 0..1 knobs, an integer elsewhere, a non-default
    // pattern for traffic.
    const nodes = NODE_KINDS.map((kind, i) => {
      const overrides: Record<string, unknown> = {};
      for (const field of WIRE_FIELDS) {
        if (field === 'traffic') overrides[field] = 'spike';
        else if (field === 'bulkheadMode') overrides[field] = 'wait';
        else overrides[field] = 7 + i + WIRE_FIELDS.indexOf(field) / 1000;
      }
      return node(`${kind}-1`, kind, 0, 0, overrides as Partial<NodeConfig>);
    });
    expectRoundTrip({ nodes, edges: [] });
  });

  it('carries a field its kind does not normally use', () => {
    // A service given a database's lock time: not in the service schema,
    // so it takes the extras path, and it still comes back.
    const t: Topology = {
      nodes: [node('a', 'service', 0, 0, { lockMs: 42, traffic: 'diurnal' })],
      edges: [],
    };
    const out = expectRoundTrip(t);
    expect(out.nodes[0]?.config.lockMs).toBe(42);
    expect(out.nodes[0]?.config.traffic).toBe('diurnal');
  });

  it('restores defaults for fields the wire omitted', () => {
    const t: Topology = { nodes: [node('a', 'db', 0, 0, { capacity: 99 })], edges: [] };
    const out = roundTrip(t);
    expect(out.nodes[0]?.config).toEqual({ ...defaultConfig('db'), capacity: 99 });
  });

  it('treats an undefined field as absent rather than failing', () => {
    const t: Topology = {
      nodes: [
        node('a', 'client', 0, 0, { traffic: undefined, trafficPeriodS: undefined }),
      ],
      edges: [],
    };
    const out = roundTrip(t);
    expect(out.nodes[0]?.config).toEqual(defaultConfig('client'));
  });

  it('carries every optional edge field, the control flag and a weight', () => {
    const t: Topology = {
      nodes: [node('a', 'autoscaler'), node('b', 'service'), node('c', 'db')],
      edges: [
        edge('a', 'b', { control: true }),
        edge('b', 'c', { weight: 3 }),
        edge('c', 'b', { latencyMs: 12, bandwidthRps: 500, lossRate: 0.01 }),
        edge('b', 'b', { weight: 0.25, control: true, latencyMs: 0 }),
      ],
    };
    const out = expectRoundTrip(t);
    expect(out.edges[0]?.control).toBe(true);
    expect(out.edges[1]?.control).toBeUndefined();
    expect(out.edges[1]?.weight).toBe(3);
    expect(out.edges[2]).toMatchObject({
      latencyMs: 12,
      bandwidthRps: 500,
      lossRate: 0.01,
    });
    expect(out.edges[3]?.latencyMs).toBe(0);
  });

  it('drops an explicit control: false, which means the same as absent', () => {
    const t: Topology = {
      nodes: [node('a', 'client'), node('b', 'service')],
      edges: [edge('a', 'b', { control: false })],
    };
    const out = roundTrip(t);
    expect(out.edges[0]?.control).toBeUndefined();
  });

  it('keeps edge order, which region nodes depend on', () => {
    const t: Topology = {
      nodes: [node('r', 'region'), node('a', 'service'), node('b', 'service')],
      edges: [edge('r', 'b'), edge('r', 'a')],
    };
    const out = roundTrip(t);
    expect(out.edges.map((e) => e.to)).toEqual([out.nodes[2]?.id, out.nodes[1]?.id]);
  });

  it('carries a note with every style set and a section with a colour', () => {
    const note: Note = {
      id: 'n',
      kind: 'note',
      text: 'Styled',
      x: 10.5,
      y: -20.25,
      width: 300,
      size: 'lg',
      scale: 1.5,
      font: 'mono',
      color: '#ff0000',
      tone: 12,
      bold: true,
      italic: true,
      underline: true,
      autoResize: true,
    };
    const section: Section = {
      id: 's',
      kind: 'section',
      label: 'Tier',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      tone: 5,
      color: 'rgb(1, 2, 3)',
    };
    const plain: Note = {
      id: 'p',
      kind: 'note',
      text: 'Plain',
      x: 0,
      y: 0,
      width: 220,
      size: 'sm',
    };
    const out = expectRoundTrip({
      nodes: [],
      edges: [],
      annotations: [note, section, plain],
    });
    expect(out.annotations?.map((a) => a.id)).toEqual([
      'note-1',
      'section-1',
      'note-2',
    ]);
  });

  it('carries every font and every size', () => {
    const annotations: Annotation[] = [];
    for (const font of ['sans', 'hand', 'serif', 'mono'] as const) {
      for (const size of ['sm', 'md', 'lg'] as const) {
        annotations.push({
          id: `${font}-${size}`,
          kind: 'note',
          text: 'x',
          x: 0,
          y: 0,
          width: 100,
          size,
          font,
        });
      }
    }
    expectRoundTrip({ nodes: [], edges: [], annotations });
  });

  it('keeps special characters and unicode in labels and notes', () => {
    const labels = [
      'Pub/Sub "Topic" <b>&amp;</b>',
      'Cache → DB',
      '日本語 ラベル',
      '🚀 launch',
      'multi\nline',
      '\\backslash and   nul',
    ];
    const t: Topology = {
      nodes: labels.map((l, i) => node(`n${i}`, 'service', 0, 0, {}, l)),
      edges: [],
      annotations: labels.map((l, i) => ({
        id: `a${i}`,
        kind: 'note' as const,
        text: l,
        x: 0,
        y: 0,
        width: 220,
        size: 'md' as const,
      })),
    };
    expectRoundTrip(t);
  });

  it('keeps large, negative and fractional coordinates', () => {
    const t: Topology = {
      nodes: [
        node('a', 'service', 123456, -98765),
        node('b', 'service', 0.4, 0.6),
        node('c', 'service', -0.5, 2.5),
      ],
      edges: [],
      annotations: [
        {
          id: 'n',
          kind: 'note',
          text: 'far',
          x: 123456.789,
          y: -0.001,
          width: 333.33,
          size: 'md',
        },
      ],
    };
    const out = expectRoundTrip(t);
    // Nodes round; annotations do not.
    expect(out.nodes.map((n) => [n.x, n.y])).toEqual([
      [123456, -98765],
      [0, 1],
      [0, 3],
    ]);
    expect(out.annotations?.[0]).toMatchObject({
      x: 123456.789,
      y: -0.001,
      width: 333.33,
    });
  });

  it('reproduces every number exactly, including the ones outside the compact form', () => {
    const values = [
      0,
      1,
      -1,
      0.5,
      0.6,
      0.92,
      0.005,
      0.0001,
      0.00001,
      1 / 3,
      2500,
      5000,
      30000,
      12000,
      1024,
      65535,
      65536,
      1e6,
      1e21,
      1e-7,
      123456789.123,
      2 ** 53 - 1,
      -(2 ** 53) + 1,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      0.1 + 0.2,
    ];
    const t: Topology = {
      nodes: values.map((v, i) =>
        node(`n${i}`, 'service', 0, 0, { serviceMs: v, capacity: v }),
      ),
      edges: [],
    };
    const out = roundTrip(t);
    for (let i = 0; i < values.length; i++) {
      expect(out.nodes[i]?.config.serviceMs, String(values[i])).toBe(values[i]);
      expect(out.nodes[i]?.config.capacity, String(values[i])).toBe(values[i]);
    }
  });

  it('round trips every worked example', () => {
    for (const p of PRESETS) {
      const out = roundTrip(p.topology);
      expect(essence(out), p.id).toEqual(essence(p.topology));
    }
  });
});

/* ------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------ */

describe('ids', () => {
  it('mints node ids in the shape the editor uses, numbered per kind', () => {
    const t: Topology = {
      nodes: [node('x', 'service'), node('y', 'db'), node('z', 'service')],
      edges: [edge('x', 'y'), edge('z', 'y')],
    };
    const out = roundTrip(t);
    expect(out.nodes.map((n) => n.id)).toEqual(['service-1', 'db-1', 'service-2']);
    expect(out.edges.map((e) => e.id)).toEqual(['service-1->db-1', 'service-2->db-1']);
  });

  it('keeps two edges between the same pair distinct', () => {
    const t: Topology = {
      nodes: [node('a', 'client'), node('b', 'service')],
      edges: [edge('a', 'b'), { ...edge('a', 'b'), id: 'other', weight: 2 }],
    };
    const out = roundTrip(t);
    expect(new Set(out.edges.map((e) => e.id)).size).toBe(2);
    expect(out.edges[1]?.weight).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

describe('determinism', () => {
  it('encodes the same design to the same bytes regardless of key order or ids', () => {
    for (const p of PRESETS) {
      const a = packTopology(p.topology);
      const shuffled: Topology = {
        ...p.topology,
        nodes: p.topology.nodes.map((n) => ({
          config: Object.fromEntries(Object.entries(n.config).reverse()) as NodeConfig,
          y: n.y,
          x: n.x,
          label: n.label,
          kind: n.kind,
          id: `renamed-${n.id}`,
        })),
        edges: p.topology.edges.map((e) => ({
          ...e,
          id: `e-${e.id}`,
          from: `renamed-${e.from}`,
          to: `renamed-${e.to}`,
        })),
      };
      expect(packTopology(shuffled), p.id).toEqual(a);
    }
  });

  it('is a fixed point: decode then encode gives the same bytes', () => {
    for (const p of PRESETS) {
      const a = packTopology(p.topology);
      const b = packTopology(unpackTopology(a) as Topology);
      expect(b, p.id).toEqual(a);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Links written by earlier builds. The tables are append only, so bytes
 * an older generation-3 encoder produced must keep opening as the same
 * design after a field is added.
 * ------------------------------------------------------------------ */

describe('links written by earlier builds', () => {
  // Packed by the generation-3 encoder before the bulkhead had its
  // acquisition fields: a client, a bulkhead with bulkheadMax 4, serviceMs 5,
  // queueLimit 200, instances 3 and timeoutMs 800, then a service carrying
  // lockMs 40, a field outside its kind's schema.
  const BEFORE_ACQUIRE_FIELDS =
    '03020000000000001b90030000ba0140502530850102a0060000010136800500020104';

  it('opens a bulkhead and an out-of-schema field as they were written', () => {
    const bytes = Uint8Array.from(BEFORE_ACQUIRE_FIELDS.match(/../g) ?? [], (h) =>
      Number.parseInt(h, 16),
    );
    const t = unpackTopology(bytes);
    expect(t).not.toBeNull();
    const [, bulkhead, service] = (t as Topology).nodes;
    expect(bulkhead?.config).toEqual({
      ...defaultConfig('bulkhead'),
      bulkheadMax: 4,
      serviceMs: 5,
      queueLimit: 200,
      instances: 3,
      timeoutMs: 800,
    });
    expect(service?.config).toEqual({ ...defaultConfig('service'), lockMs: 40 });
  });
});

/* ------------------------------------------------------------------ *
 * Hostile bytes. None of these may throw; all must return null.
 * ------------------------------------------------------------------ */

describe('hostile bytes', () => {
  const sample = PRESETS.find((p) => p.id === 'discord')?.topology as Topology;
  const good = packTopology(sample);

  it('returns null for every truncation', () => {
    for (let len = 0; len < good.length; len++) {
      expect(unpackTopology(good.subarray(0, len)), `cut at ${len}`).toBeNull();
    }
  });

  it('returns null for trailing bytes', () => {
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(unpackTopology(longer)).toBeNull();
  });

  it('returns null for an unknown kind', () => {
    // Header: 1 node, 0 edges, 0 annotations; then a kind index past the table.
    expect(unpackTopology(new Uint8Array([1, 0, 0, 200, 0, 0, 0, 0]))).toBeNull();
  });

  it('returns null for a mask naming a field past the schema', () => {
    // Kind 0 (client), x 0, y 0, default label, then a 40-bit mask.
    const bytes = new Uint8Array([
      1, 0, 0, 0, 0, 0, 0, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ]);
    expect(unpackTopology(bytes)).toBeNull();
  });

  it('returns null for an edge naming a node that does not exist', () => {
    // 1 node (client, defaults), 1 edge from 0 to 5.
    expect(unpackTopology(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 10]))).toBeNull();
  });

  it('returns null for a header claiming more items than a link could carry', () => {
    // nodeCount = 2^21, then nothing.
    expect(unpackTopology(new Uint8Array([0x80, 0x80, 0x80, 0x01, 0, 0]))).toBeNull();
  });

  it('returns null on random bytes rather than throwing', () => {
    let seed = 7;
    for (let round = 0; round < 500; round++) {
      const len = round % 64;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        bytes[i] = seed & 0xff;
      }
      let out: Topology | null = null;
      expect(() => {
        out = unpackTopology(bytes);
      }).not.toThrow();
      // Whatever came back is structurally a topology or nothing at all.
      if (out !== null) {
        const t = out as Topology;
        expect(Array.isArray(t.nodes)).toBe(true);
        expect(Array.isArray(t.edges)).toBe(true);
      }
    }
  });

  it('refuses a non-finite number smuggled through the float escape', () => {
    // 1 node: client, x 0, y 0, default label, mask bit 0 (rps) set, then
    // the float tag (7) and eight bytes of NaN.
    const bytes = new Uint8Array([
      1, 0, 0, 0, 0, 0, 0, 2, 7, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f,
    ]);
    expect(unpackTopology(bytes)).toBeNull();
  });
});
