import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBytes, decodeTopology, encodeBytes, encodeTopology } from '../share';
import { Engine } from '../sim/engine';
import { PRESETS } from '../sim/presets';
import type { FaultEvent, SimNode, Topology } from '../sim/types';
import { fetchStored, setEndpointForTests, storeTopology } from './store';
import { packTopology, unpackTopology } from './wire';

/* ------------------------------------------------------------------ *
 * What these pin.
 *
 * A replay link has to open the run that was shared, not one like it, so
 * the seed and the fault schedule travel with the design and the engine
 * on the far side plays the same trajectory byte for byte. And a link
 * built before either could travel must still open exactly as it did:
 * the fixtures below were written by the encoder before the run tail
 * existed, and nothing about them may change.
 * ------------------------------------------------------------------ */

/**
 * Links written by the encoder before the run tail was added, with the
 * SHA-256 of what `decodeTopology` returned for each at the time.
 */
const LINKS_BEFORE_TAIL: Record<string, { link: string; decoded: string }> = {
  'single-server': {
    link: 'd3.AUVOO07DQBRcf0KRdJxgKoSQZVkEUdBFokmFJbjAS_YFr2Tvwr5nQukj-Bg5BhfgTsjb0M1PM1PkmWnnwpQ3-WU1F5tdu8crxy-Oprys58JgujJ5Vl7_Zi-eIcmqEDzDktKBhGu8df8MTqAdQwbqe44Ip0T1HJ7wiMifI4sKSEFQN_CCts0gYDp2FSTAKeLoBWFUeKaI-6YBQfgYvK3xHOk9VfaBLD5IFA_fIG-TeCanOIyut-lGZJxcFK3ggy5TS2bX7utpNd3-3P0B',
    decoded: '59e982ffe40a9e57c304796e06d8a4e311c7719f122d57a98005ea30562f394b',
  },
  'circuit-breaker': {
    link: 'd3.AU2PQUrEQBBFk04chFERwf1fyTBIzmA2wqwMegFrOpWknaQ7dHcM7nI0j-FylnOILKQzIO6K4v1X9dMkjopZRKv7B_GTzmKdFzu8sf1kq6fkfbrNeX28nEWUPovT1SyuC_rqWHuHvNjdPB2TKY1EnIrV3Sl-VXXjIVslD_ANo_-HgnQJpT9YehCkJddkeNGS0VBbLbiktnVQGoTKDBaOpdElRqVLM6Ii1T4u3N4yHdjC9Kzd4g1by84vUDB0Slpzzgej80wlTIWRlFe6hhnCF151bAafIa88W_jGMuMvFZoYx-cLvTX7MNakdDZdTJvv7S8',
    decoded: 'a74f9323e58aebb3c8f4a154655cc7a4eabb88cf2a8211419942a6fcf3314dae',
  },
  'load-balanced': {
    link: 'd3.ATWOP07DMByF4zhNqqgLnOBNDAhF5c_QgYGObB16ANz4B45k7Mg2RN0yMnIEjpExGyvH6DFQrGb83nv69PKCJbuBJ_l4ccW-soEnaf-Unooflm93z7gtX_o8PRUDj3h3xr9FxPsJs3E18GQzsm_er5KUZSxny7TkZVZe_rK9ckTw5D7JeXglHMEaghRBHISnCnslAoJrWk0eQREmcy1aUTfhCGEkpCUPY4NqzBterYurWXCDTjW1gg-N1gi29bAfAYaEw8NmDQFPtTWywlbKSTB_sUYfoUi3Hp0iE6Vz15GjGLTOHjS9V_2ifxyv_wE',
    decoded: '3ba98eaa50084c7ae643caee45ed04a707286fcc1eb162deb793c78319d1760d',
  },
};

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function preset(id: string): Topology {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p.topology;
}

/**
 * A preset with the ids the wire regenerates, so a run of it and a run of
 * its decoded link name the same nodes and edges in their snapshots. The
 * wire has always done this to ids; it is not what is under test.
 */
function onWire(id: string): Topology {
  const t = unpackTopology(packTopology(preset(id)));
  if (!t) throw new Error(`${id} did not survive the wire`);
  return t;
}

function servers(t: Topology): SimNode[] {
  return t.nodes.filter((n) => n.kind !== 'client');
}

/** Five entries, one of each action plus an option, at authored times. */
function fiveFaults(t: Topology): FaultEvent[] {
  const [a, b] = servers(t);
  const edge = t.edges[t.edges.length - 1];
  if (!a || !b || !edge) throw new Error('fixture too small');
  return [
    { atMs: 10000, action: 'inject', nodeId: a.id, kind: 'crash' },
    { atMs: 20000, action: 'clear', nodeId: a.id },
    { atMs: 25000, action: 'inject', nodeId: b.id, kind: 'slow', opts: { factor: 3 } },
    { atMs: 30000, action: 'cut', edgeId: edge.id },
    { atMs: 40000, action: 'restore', edgeId: edge.id },
  ];
}

async function decoded(link: string): Promise<Topology> {
  const r = await decodeTopology(link);
  if (r.status !== 'ok') throw new Error(`link did not open: ${r.status}`);
  return r.topology;
}

/* ------------------------------------------------------------------ *
 * Links from before the tail
 * ------------------------------------------------------------------ */

describe('links built before the run tail', () => {
  it('still decode to exactly what they decoded to then', async () => {
    for (const [id, { link, decoded: hash }] of Object.entries(LINKS_BEFORE_TAIL)) {
      const r = await decodeTopology(link);
      expect(r.status, id).toBe('ok');
      expect(sha256(JSON.stringify(r)), id).toBe(hash);
      if (r.status !== 'ok') continue;
      expect(r.topology.faults, id).toBeUndefined();
      expect(r.topology.seed, id).toBeUndefined();
    }
  });

  it('are still what the encoder writes for a design without a seed or schedule', async () => {
    for (const [id, { link }] of Object.entries(LINKS_BEFORE_TAIL)) {
      // The bytes the old encoder packed, lifted back out of its link.
      const body = Uint8Array.from(
        atob(link.slice(3).replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );
      expect(body[0], id).toBe(1);
      const stream = new Blob([body.subarray(1)])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      const before = new Uint8Array(await new Response(stream).arrayBuffer());

      const t = await decoded(link);
      expect(packTopology(t), id).toEqual(before);
      // An empty schedule is no schedule, and writes no tail either.
      expect(packTopology({ ...t, faults: [] }), id).toEqual(before);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The tail itself
 * ------------------------------------------------------------------ */

describe('run tail round trip', () => {
  it('carries a seed alone', () => {
    const base = onWire('single-server');
    for (const seed of [0, 1, 7, 123456789, 0xffffffff]) {
      const out = unpackTopology(packTopology({ ...base, seed }));
      expect(out).toEqual({ ...base, seed });
    }
  });

  it('carries a schedule alone, with node and edge ids remapped', () => {
    const t = preset('circuit-breaker');
    const faults = fiveFaults(t);
    const out = unpackTopology(packTopology({ ...t, faults }));
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.seed).toBeUndefined();
    // The ids are regenerated, so compare by the index each entry names.
    const nodeAt = (ts: Topology, id: string) => ts.nodes.findIndex((n) => n.id === id);
    const edgeAt = (ts: Topology, id: string) => ts.edges.findIndex((e) => e.id === id);
    const shape = (ts: Topology, fs: FaultEvent[]) =>
      fs.map((f) =>
        f.action === 'cut' || f.action === 'restore'
          ? { ...f, edgeId: edgeAt(ts, f.edgeId) }
          : { ...f, nodeId: nodeAt(ts, f.nodeId) },
      );
    expect(shape(out, out.faults ?? [])).toEqual(shape(t, faults));
  });

  it('carries every action, every option, ties in list order and unsorted times', () => {
    const base = onWire('circuit-breaker');
    const [a, b, c] = servers(base);
    const [e0, e1] = base.edges;
    if (!a || !b || !c || !e0 || !e1) throw new Error('fixture too small');
    const faults: FaultEvent[] = [
      {
        atMs: 5000,
        action: 'inject',
        nodeId: c.id,
        kind: 'errors',
        opts: { rate: 0.25 },
      },
      { atMs: 1000, action: 'inject', nodeId: a.id, kind: 'partition' },
      {
        atMs: 1000,
        action: 'inject',
        nodeId: b.id,
        kind: 'partition',
        opts: { edgeIds: [e1.id, e0.id] },
      },
      {
        atMs: 1000,
        action: 'inject',
        nodeId: a.id,
        kind: 'partition',
        opts: { edgeIds: [] },
      },
      { atMs: 0, action: 'cut', edgeId: e0.id },
      { atMs: 16.666666666666668, action: 'restore', edgeId: e0.id },
      {
        atMs: 1234.5,
        action: 'inject',
        nodeId: b.id,
        kind: 'slow',
        opts: { factor: 2.5, rate: 0.1 },
      },
      { atMs: 1e9 + 0.1, action: 'clear', nodeId: b.id },
      { atMs: 3, action: 'clear', nodeId: c.id },
    ];
    const out = unpackTopology(packTopology({ ...base, faults, seed: 42 }));
    expect(out).toEqual({ ...base, faults, seed: 42 });
  });

  it('leaves out an entry that names nothing in the design', () => {
    const base = onWire('single-server');
    const [a] = servers(base);
    if (!a) throw new Error('fixture too small');
    const keep: FaultEvent = { atMs: 1, action: 'inject', nodeId: a.id, kind: 'crash' };
    const out = unpackTopology(
      packTopology({
        ...base,
        faults: [keep, { atMs: 2, action: 'clear', nodeId: 'ghost' }],
      }),
    );
    expect(out?.faults).toEqual([keep]);
  });

  it('writes no seed it would have to fold into another one', () => {
    const base = onWire('single-server');
    const plain = sha256(packTopology(base));
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) {
      expect(sha256(packTopology({ ...base, seed }))).toBe(plain);
    }
  });

  it('costs a few bytes for a typical five-entry schedule', async () => {
    const t = preset('circuit-breaker');
    const withRun = { ...t, faults: fiveFaults(t), seed: 7 };
    const packed = packTopology(withRun).length - packTopology(t).length;
    const link =
      (await encodeTopology(withRun)).length - (await encodeTopology(t)).length;
    // Measured at 24 bytes packed (21 for the five entries, one each for the
    // header, the seed and the count) and 39 characters of link once
    // deflated. Exact for the packed bytes; the link has slack because
    // deflate's choices are its own.
    expect(packed).toBe(24);
    expect(link).toBeLessThanOrEqual(50);
  });
});

describe('a hostile tail', () => {
  const base = onWire('single-server');
  const head = packTopology(base);
  const withTail = (...tail: number[]) => {
    const out = new Uint8Array(head.length + tail.length);
    out.set(head);
    out.set(tail, head.length);
    return out;
  };

  it('is refused rather than half read', () => {
    const cases: [string, number[]][] = [
      ['an empty header', [0]],
      ['an unknown header bit', [4]],
      ['a seed past 32 bits', [1, 0x80, 0x80, 0x80, 0x80, 0x10]],
      ['a truncated seed', [1]],
      ['a schedule of zero entries', [2, 0]],
      ['an unknown op', [2, 1, 7 << 3, 0, 0]],
      ['options on a clear', [2, 1, (4 << 3) | 1, 0, 0]],
      ['a missing node', [2, 1, 0, 0, 99]],
      ['a missing edge', [2, 1, 5 << 3, 0, 99]],
      ['bytes after the tail', [1, 7, 0]],
    ];
    for (const [what, tail] of cases) {
      expect(unpackTopology(withTail(...tail)), what).toBeNull();
    }
    // The same shapes, well formed, do open.
    expect(unpackTopology(withTail(1, 7))?.seed).toBe(7);
  });

  it('gets its entries checked by the same validator as every other path', async () => {
    const [a] = servers(base);
    if (!a) throw new Error('fixture too small');
    // A negative time is structurally fine on the wire, so it is the
    // validator in share.ts that has to drop it.
    const link = await encodeTopology(base);
    const t = await decoded(link);
    const bytes = await encodeBytes({
      ...t,
      faults: [
        { atMs: -5, action: 'inject', nodeId: a.id, kind: 'crash' },
        { atMs: 5, action: 'inject', nodeId: a.id, kind: 'crash' },
      ],
    });
    const r = await decodeBytes(bytes);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.topology.faults).toEqual([
      { atMs: 5, action: 'inject', nodeId: a.id, kind: 'crash' },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Every path a link takes
 * ------------------------------------------------------------------ */

describe('replay links', () => {
  afterEach(() => {
    setEndpointForTests(null);
    vi.unstubAllGlobals();
  });

  it('carry the seed and schedule through a fragment link', async () => {
    const base = onWire('circuit-breaker');
    const t = { ...base, faults: fiveFaults(base), seed: 99 };
    expect(await decoded(await encodeTopology(t))).toEqual(t);
  });

  it('carry the seed and schedule through the short-link store', async () => {
    const base = onWire('circuit-breaker');
    const t = { ...base, faults: fiveFaults(base), seed: 99 };
    setEndpointForTests('https://store.test');
    let stored: Uint8Array<ArrayBuffer> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          stored = new Uint8Array(init.body as Uint8Array);
          return new Response(JSON.stringify({ id: 'abcdefghijklmn' }), {
            status: 201,
          });
        }
        return new Response(stored, { status: 200 });
      }),
    );
    const url = new URL(await storeTopology(t, 'https://breakscale.tech/'));
    const r = await fetchStored(url.search, url.hash);
    expect(r).toEqual({ status: 'ok', topology: t });
  });
});

/* ------------------------------------------------------------------ *
 * Determinism through a link
 * ------------------------------------------------------------------ */

describe('a run replayed from its link', () => {
  // The app's own step, which is not a whole number of milliseconds, so the
  // recorded fault times are not either and take the wire's exact escape.
  const FRAME = 1000 / 60;
  const FRAMES = 360;

  /**
   * A snapshot after every frame. A click lands between two frames, and the
   * app redraws straight after one, so `act` runs after the frame's advance
   * and before its snapshot.
   */
  function play(engine: Engine, act?: (frame: number) => void): string[] {
    const out: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      engine.advance(FRAME);
      act?.(i);
      out.push(JSON.stringify(engine.snapshot()));
    }
    return out;
  }

  it('matches a run broken by hand, snapshot for snapshot', async () => {
    const base = onWire('circuit-breaker');
    const [a, b] = servers(base);
    const edge = base.edges[base.edges.length - 1];
    if (!a || !b || !edge) throw new Error('fixture too small');

    const live = new Engine(base, 7);
    const original = play(live, (i) => {
      if (i === 40) live.recordFailure(a.id, 'slow', { factor: 4 });
      if (i === 90) live.recordCutEdge(edge.id);
      if (i === 150) live.recordFailure(b.id, 'errors', { rate: 0.3 });
      if (i === 200) live.recordRestoreEdge(edge.id);
      if (i === 260) live.recordClearFailure(a.id);
    });
    const exported = live.exportTopology();
    expect(exported.seed).toBe(7);
    expect(exported.faults).toHaveLength(5);

    const opened = await decoded(await encodeTopology(exported));
    expect(opened).toEqual(exported);
    const replay = play(new Engine(opened));
    // Compared as one hash first so a failure does not print a megabyte of
    // JSON, then by the first frame that differs, which is what to look at.
    const firstDiff = original.findIndex((s, i) => s !== replay[i]);
    expect(firstDiff).toBe(-1);
    expect(sha256(replay.join('\n'))).toBe(sha256(original.join('\n')));

    // And the seed and the faults are both doing something, so the match
    // above is not two healthy runs on the default seed agreeing.
    const sameAs = (run: string[]) =>
      sha256(run.join('\n')) === sha256(original.join('\n'));
    expect(sameAs(play(new Engine({ ...opened, seed: undefined })))).toBe(false);
    expect(sameAs(play(new Engine({ ...opened, faults: undefined })))).toBe(false);
  });

  it('matches an authored schedule on a chosen seed', async () => {
    const base = onWire('load-balanced');
    const t = {
      ...base,
      faults: fiveFaults(base).map((f) => ({ ...f, atMs: f.atMs / 10 })),
      seed: 2024,
    };
    const original = play(new Engine(t));
    const replay = play(new Engine(await decoded(await encodeTopology(t))));
    expect(original.findIndex((s, i) => s !== replay[i])).toBe(-1);
    expect(replay).toHaveLength(original.length);
  });
});
