import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DECODED_BYTES,
  MAX_SHARE_URL_CHARS,
  SHARE_VERSION,
  ShareLinkTooLargeError,
  buildShareUrl,
  decodeTopology,
  encodeTopology,
  hasShareHash,
} from './share';
import { PRESETS, defaultConfig } from './sim/presets';
import type { NodeConfig, Topology } from './sim/types';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const CONFIG: NodeConfig = {
  instances: 1,
  capacity: 8,
  serviceMs: 25,
  serviceCv: 0.6,
  queueLimit: 64,
  hitRate: 0,
  errorRate: 0,
  timeoutMs: 0,
  retries: 0,
  rps: 120,
  replicaCount: 3,
  replicationLagMs: 50,
  readFraction: 0.9,
  shardCount: 4,
  shardCapacity: 4,
  hotKeyFraction: 0,
};

const SIMPLE: Topology = {
  nodes: [
    {
      id: 'client-1',
      kind: 'client',
      label: 'Users',
      x: 0,
      y: 0,
      config: { ...CONFIG },
    },
    {
      id: 'service-1',
      kind: 'service',
      label: 'API',
      x: 200,
      y: 0,
      config: { ...CONFIG },
    },
  ],
  edges: [{ id: 'client-1->service-1', from: 'client-1', to: 'service-1', weight: 1 }],
};

const ANNOTATED: Topology = {
  ...SIMPLE,
  annotations: [
    {
      id: 'note-1',
      kind: 'note',
      text: 'The API is the bottleneck here.',
      x: 40,
      y: 120,
      width: 220,
      size: 'md',
      font: 'hand',
      bold: true,
    },
    {
      id: 'section-1',
      kind: 'section',
      label: 'Serving the request',
      x: -20,
      y: -40,
      width: 400,
      height: 200,
      tone: 3,
    },
  ],
};

const NETFLIX = PRESETS.find((p) => p.id === 'netflix')!.topology;

/** The production origin; what a copied link actually starts with. */
const ORIGIN = 'https://breakscale.vercel.app/';

/**
 * A link regenerates ids, so two designs are the same design when they
 * agree on everything else and their edges join the same node positions.
 */
function essence(t: Topology): unknown {
  const at = new Map(t.nodes.map((n, i) => [n.id, i]));
  return {
    nodes: t.nodes.map(({ id: _id, ...n }) => n),
    edges: t.edges.map(({ id: _id, from, to, ...e }) => ({
      ...e,
      from: at.get(from),
      to: at.get(to),
    })),
    annotations: (t.annotations ?? []).map(({ id: _id, ...a }) => a),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A generation-2 link body: flag byte 0 (raw) then JSON text. */
function legacyRawLink(doc: string, prefix = 'd2'): string {
  const bytes = new TextEncoder().encode(doc);
  const body = new Uint8Array(bytes.length + 1);
  body[0] = 0;
  body.set(bytes, 1);
  return `#${prefix}.${toBase64Url(body)}`;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A generation-2 link body exactly as that encoder wrote it: deflated, defaults stripped. */
async function legacyDeflatedLink(topology: Topology): Promise<string> {
  const nodes = topology.nodes.map((node) => {
    const def = defaultConfig(node.kind) as unknown as Record<string, unknown>;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.config)) if (v !== def[k]) config[k] = v;
    return { ...node, config };
  });
  const json = JSON.stringify({
    nodes,
    edges: topology.edges,
    ...(topology.annotations ? { annotations: topology.annotations } : {}),
  });
  const packed = await deflateRaw(new TextEncoder().encode(json));
  const body = new Uint8Array(packed.length + 1);
  body[0] = 1;
  body.set(packed, 1);
  return `#d2.${toBase64Url(body)}`;
}

/* ------------------------------------------------------------------ *
 * Running the same suite down BOTH encodings.
 *
 * `CompressionStream` is missing from some environments the app has to
 * work in, so the fallback is not a theoretical branch: it is the path a
 * real reader takes. Skipping it because the runner happens to have the
 * API would leave half the module untested, so it is exercised by hiding
 * the globals for the duration of a case rather than by trusting that
 * some future runner will do it for us.
 * ------------------------------------------------------------------ */

const REAL_CS = globalThis.CompressionStream;
const REAL_DS = globalThis.DecompressionStream;

function suppressCompression(): void {
  Reflect.deleteProperty(globalThis, 'CompressionStream');
  Reflect.deleteProperty(globalThis, 'DecompressionStream');
}

function restoreCompression(): void {
  globalThis.CompressionStream = REAL_CS;
  globalThis.DecompressionStream = REAL_DS;
}

afterEach(restoreCompression);

describe('the environment this suite claims to cover', () => {
  it('really does have CompressionStream, so the compressed path is exercised', () => {
    // Guards the honesty of everything below. If the runner ever loses the
    // API, the compressed cases would silently become a second run of the
    // uncompressed ones and this test says so instead.
    expect(typeof REAL_CS).toBe('function');
    expect(typeof REAL_DS).toBe('function');
  });
});

describe('round trip, compressed', () => {
  it('returns the same nodes and edges', async () => {
    const hash = await encodeTopology(SIMPLE);
    const out = await decodeTopology(hash);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(essence(out.topology)).toEqual(essence(SIMPLE));
  });

  it('mints ids the editor would have, so a later add cannot collide', async () => {
    const out = await decodeTopology(await encodeTopology(SIMPLE));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.nodes.map((n) => n.id)).toEqual(['client-1', 'service-1']);
    expect(out.topology.edges[0]?.id).toBe('client-1->service-1');
  });

  it('carries annotations through', async () => {
    const out = await decodeTopology(await encodeTopology(ANNOTATED));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(essence(out.topology)).toEqual(essence(ANNOTATED));
  });

  it('round trips every worked example unchanged', async () => {
    for (const p of PRESETS) {
      const out = await decodeTopology(await encodeTopology(p.topology));
      expect(out.status, p.id).toBe('ok');
      if (out.status !== 'ok') return;
      expect(essence(out.topology), p.id).toEqual(essence(p.topology));
    }
  });

  it('is a fraction of the raw JSON it carries', async () => {
    const hash = await encodeTopology(NETFLIX);
    const raw = JSON.stringify(NETFLIX).length;
    expect(hash.length).toBeLessThan(raw / 6);
  });

  it('is deterministic: the same design gives the same link', async () => {
    expect(await encodeTopology(NETFLIX)).toBe(
      await encodeTopology(structuredClone(NETFLIX)),
    );
  });
});

describe('round trip, uncompressed fallback', () => {
  it('encodes and decodes with no CompressionStream at all', async () => {
    suppressCompression();
    const hash = await encodeTopology(ANNOTATED);
    const out = await decodeTopology(hash);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(essence(out.topology)).toEqual(essence(ANNOTATED));
  });

  it('produces a longer payload than the compressed one, as expected', async () => {
    const packed = await encodeTopology(NETFLIX);
    suppressCompression();
    const plain = await encodeTopology(NETFLIX);
    expect(plain.length).toBeGreaterThan(packed.length);
  });

  it('reads an uncompressed link on a machine that CAN compress', async () => {
    suppressCompression();
    const hash = await encodeTopology(NETFLIX);
    restoreCompression();
    const out = await decodeTopology(hash);
    expect(out.status).toBe('ok');
  });

  it('reports a compressed link it cannot inflate instead of showing nothing', async () => {
    const hash = await encodeTopology(NETFLIX);
    suppressCompression();
    const out = await decodeTopology(hash);
    expect(out.status).toBe('invalid');
  });

  it('leaves a design uncompressed when deflate would only add bytes', async () => {
    // A single node packs to a dozen bytes; deflate cannot
    // beat that, so the link is the same with or without it.
    const tiny: Topology = {
      nodes: [
        { id: 'n', kind: 'service', label: 'b', x: 0, y: 0, config: { ...CONFIG } },
      ],
      edges: [],
    };
    const packed = await encodeTopology(tiny);
    suppressCompression();
    const plain = await encodeTopology(tiny);
    expect(packed).toBe(plain);
  });
});

describe('shape of the encoded link', () => {
  it('carries the version prefix', async () => {
    expect(await encodeTopology(SIMPLE)).toMatch(new RegExp(`^${SHARE_VERSION}\\.`));
  });

  it('uses no character that is hostile in a URL', async () => {
    const hash = await encodeTopology(NETFLIX);
    expect(hash.slice(SHARE_VERSION.length + 1)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('replaces the fragment of the base URL and keeps the rest', async () => {
    const url = await buildShareUrl(SIMPLE, 'https://example.test/app?x=1#old');
    expect(url.startsWith('https://example.test/app?x=1#')).toBe(true);
    expect(url).not.toContain('#old');
  });

  it('recognises its own hash, and the two older ones, and nothing else', async () => {
    expect(hasShareHash(await encodeTopology(SIMPLE))).toBe(true);
    expect(hasShareHash(`#${await encodeTopology(SIMPLE)}`)).toBe(true);
    expect(hasShareHash('#d1.abc')).toBe(true);
    expect(hasShareHash('#d2.abc')).toBe(true);
    expect(hasShareHash('#d4.abc')).toBe(false);
    expect(hasShareHash('#section-two')).toBe(false);
    expect(hasShareHash('')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The size promise. A link is only useful where it can be pasted, and
 * the worked examples are the designs people will paste most.
 * ------------------------------------------------------------------ */

describe('size', () => {
  it('fits every worked example in a URL under the limit', async () => {
    for (const p of PRESETS) {
      const url = await buildShareUrl(p.topology, ORIGIN);
      expect(url.length, p.id).toBeLessThanOrEqual(MAX_SHARE_URL_CHARS);
    }
  });

  it('refuses to build a link that would not survive being pasted', async () => {
    // Forty copies of the largest example: a design no link can carry.
    const nodes = [];
    const edges = [];
    for (let k = 0; k < 40; k++) {
      for (const n of NETFLIX.nodes) nodes.push({ ...n, id: `${k}-${n.id}` });
      for (const e of NETFLIX.edges) {
        edges.push({
          ...e,
          id: `${k}-${e.id}`,
          from: `${k}-${e.from}`,
          to: `${k}-${e.to}`,
        });
      }
    }
    const big: Topology = { nodes, edges };
    await expect(buildShareUrl(big, ORIGIN)).rejects.toBeInstanceOf(
      ShareLinkTooLargeError,
    );
    try {
      await buildShareUrl(big, ORIGIN);
    } catch (e) {
      const err = e as ShareLinkTooLargeError;
      expect(err.chars).toBeGreaterThan(MAX_SHARE_URL_CHARS);
      expect(err.limit).toBe(MAX_SHARE_URL_CHARS);
    }
  });

  it('counts the base URL against the limit, not only the fragment', async () => {
    const hash = await encodeTopology(SIMPLE);
    const room = MAX_SHARE_URL_CHARS - hash.length - 1;
    const base = `https://x.test/${'p'.repeat(room - 'https://x.test/'.length)}`;
    await expect(buildShareUrl(SIMPLE, base)).resolves.toHaveLength(
      MAX_SHARE_URL_CHARS,
    );
    await expect(buildShareUrl(SIMPLE, `${base}p`)).rejects.toBeInstanceOf(
      ShareLinkTooLargeError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Older links keep opening. A link someone pasted last month is a
 * document, and a format bump must not make it a broken one.
 * ------------------------------------------------------------------ */

describe('older links', () => {
  it('opens a generation-2 link exactly as that generation wrote it', async () => {
    const out = await decodeTopology(await legacyDeflatedLink(NETFLIX));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    // Generation 2 carried ids, so these come back verbatim.
    expect(out.topology.nodes).toEqual(NETFLIX.nodes);
    expect(out.topology.edges).toEqual(NETFLIX.edges);
    expect(out.topology.annotations).toEqual(NETFLIX.annotations);
  });

  it('restores the defaults a generation-2 link stripped', async () => {
    const stripped = JSON.stringify({
      nodes: [{ ...SIMPLE.nodes[1], config: { capacity: 99 } }],
      edges: [],
    });
    const out = await decodeTopology(legacyRawLink(stripped));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.nodes[0]?.config).toEqual({
      ...defaultConfig('service'),
      capacity: 99,
    });
  });

  it('keeps a fault schedule a JSON link carries, minus entries that name nothing', async () => {
    const good = { atMs: 1500, action: 'inject', nodeId: 'service-1', kind: 'crash' };
    const doc = JSON.stringify({
      ...SIMPLE,
      faults: [good, { atMs: 10, action: 'cut', edgeId: 'nowhere' }],
    });
    const out = await decodeTopology(legacyRawLink(doc, 'd1'));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.faults).toEqual([good]);
  });

  it('opens a generation-1 link, which carried every field', async () => {
    const out = await decodeTopology(legacyRawLink(JSON.stringify(ANNOTATED), 'd1'));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.nodes).toEqual(ANNOTATED.nodes);
    expect(out.topology.annotations).toEqual(ANNOTATED.annotations);
  });
});

/* ------------------------------------------------------------------ *
 * Hostile input. Every one of these is a string somebody else's URL
 * could hand this build, so the only acceptable outcomes are 'invalid'
 * or 'absent'. Nothing here may throw and nothing may return a topology.
 * ------------------------------------------------------------------ */

describe('hostile input', () => {
  it('treats a fragment that is not ours as absent, not as an error', async () => {
    expect((await decodeTopology('')).status).toBe('absent');
    expect((await decodeTopology('#')).status).toBe('absent');
    expect((await decodeTopology('#about')).status).toBe('absent');
    expect((await decodeTopology('#d4.abcdef')).status).toBe('absent');
  });

  it('reports a link from a generation it knows that did not survive', async () => {
    expect((await decodeTopology('#d3.abcdef')).status).toBe('invalid');
    expect((await decodeTopology('#d2.abcdef')).status).toBe('invalid');
  });

  it('rejects a truncated hash', async () => {
    const hash = await encodeTopology(NETFLIX);
    // Cut at several points, including inside the base64 and right after
    // the prefix, because a link is mangled wherever the chat app that
    // carried it decided the URL ended.
    for (const frac of [0.02, 0.25, 0.5, 0.75, 0.99]) {
      const cut = hash.slice(0, Math.floor(hash.length * frac));
      const out = await decodeTopology(cut);
      expect(out.status).not.toBe('ok');
    }
  });

  it('rejects an uncompressed hash cut anywhere', async () => {
    suppressCompression();
    const hash = await encodeTopology(ANNOTATED);
    for (let len = SHARE_VERSION.length + 1; len < hash.length; len++) {
      const out = await decodeTopology(hash.slice(0, len));
      expect(out.status, `cut at ${len}`).not.toBe('ok');
    }
  });

  it('rejects valid base64 wrapped around garbage', async () => {
    const garbage = new Uint8Array(400);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
    const out = await decodeTopology(`#${SHARE_VERSION}.${toBase64Url(garbage)}`);
    expect(out.status).toBe('invalid');
  });

  it('rejects well-formed JSON that is not a topology, in an older link', async () => {
    for (const doc of [
      '{}',
      '[]',
      'null',
      '"a string"',
      '{"nodes":[],"edges":[{"id":"e","from":"nope","to":"nope","weight":1}]}',
      '{"nodes":[{"id":"x","kind":"not-a-kind","label":"","x":0,"y":0,"config":{}}],"edges":[]}',
    ]) {
      const out = await decodeTopology(legacyRawLink(doc));
      expect(out.status, doc).toBe('invalid');
    }
  });

  it('rejects an alphabet that is not base64url', async () => {
    expect((await decodeTopology(`#${SHARE_VERSION}.abc+def/gh==`)).status).toBe(
      'invalid',
    );
    expect((await decodeTopology(`#${SHARE_VERSION}.<script>`)).status).toBe('invalid');
  });

  it('refuses a payload that decompresses to something enormous', async () => {
    // A real bomb: ~64MB of zeroes, which deflate shrinks to a few
    // kilobytes of URL. Decoding it must abandon the stream rather than
    // allocate the output, so the assertion is really about what did NOT
    // happen to memory here.
    const huge = new Uint8Array(64 * 1024 * 1024);
    const packed = await deflateRaw(huge);
    // The bomb really is small on the wire; that is what makes it one.
    expect(packed.length).toBeLessThan(MAX_DECODED_BYTES);
    const body = new Uint8Array(packed.length + 1);
    body[0] = 1; // the deflated flag
    body.set(packed, 1);
    let b64 = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < body.length; i += CHUNK) {
      b64 += String.fromCharCode(...body.subarray(i, i + CHUNK));
    }
    const url = btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const out = await decodeTopology(`#${SHARE_VERSION}.${url}`);
    expect(out.status).toBe('invalid');
  }, 30000);

  it('refuses an uncompressed payload larger than the cap', async () => {
    suppressCompression();
    const filler = 'x'.repeat(MAX_DECODED_BYTES + 1024);
    const fat: Topology = {
      ...SIMPLE,
      nodes: [{ ...SIMPLE.nodes[0]!, label: filler }, SIMPLE.nodes[1]!],
    };
    const hash = await encodeTopology(fat);
    const out = await decodeTopology(hash);
    expect(out.status).toBe('invalid');
  });

  it('strips a hostile annotation colour rather than passing it through', async () => {
    const nasty: Topology = {
      ...SIMPLE,
      annotations: [
        {
          id: 'note-1',
          kind: 'note',
          text: 'Looks harmless',
          x: 0,
          y: 0,
          width: 220,
          size: 'md',
          // A colour crafted to close the declaration and open another,
          // which is what a style attribute would have run.
          color: 'red; background:url(https://evil.test/x.png)',
        },
        {
          id: 'section-1',
          kind: 'section',
          label: 'Tier',
          x: 0,
          y: 0,
          width: 300,
          height: 200,
          tone: 0,
          color: 'expression(alert(1))',
        },
      ],
    };
    const out = await decodeTopology(await encodeTopology(nasty));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const anns = out.topology.annotations ?? [];
    expect(anns).toHaveLength(2);
    for (const a of anns) {
      // The colour is gone entirely; the annotation survives and falls
      // back to its theme shade.
      expect(a.color).toBeUndefined();
    }
    expect(anns[0]!.id).toBe('note-1');
  });

  it('drops an empty note on the way in, the way every other input does', async () => {
    const t: Topology = {
      ...SIMPLE,
      annotations: [
        { id: 'a', kind: 'note', text: 'kept', x: 0, y: 0, width: 220, size: 'md' },
        { id: 'b', kind: 'note', text: '   ', x: 0, y: 0, width: 220, size: 'md' },
      ],
    };
    const out = await decodeTopology(await encodeTopology(t));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.annotations).toHaveLength(1);
    expect(out.topology.nodes).toHaveLength(2);
  });

  it('drops a malformed annotation from an older link without losing the design', async () => {
    const doc = JSON.stringify({
      nodes: SIMPLE.nodes,
      edges: SIMPLE.edges,
      annotations: [
        { id: 'note-1', kind: 'note', text: 'kept', x: 0, y: 0, width: 220 },
        { id: 'broken', kind: 'note', text: 'no coordinates' },
        'not an object',
        null,
      ],
    });
    const out = await decodeTopology(legacyRawLink(doc));
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.topology.annotations).toHaveLength(1);
    expect(out.topology.nodes).toHaveLength(2);
  });
});
