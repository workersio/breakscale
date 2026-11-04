import { isTopology } from './clipboard';
import { sanitizeAnnotations } from './sim/annotations';
import { sanitizeFaults } from './sim/faults';
import { sanitizeSeed } from './sim/seed';
import type { Topology, NodeKind } from './sim/types';
import { defaultConfig } from './sim/presets';
import { packTopology, unpackTopology } from './share/wire';

/* ------------------------------------------------------------------ *
 * Share links.
 *
 * A design is carried entirely in the URL fragment, so a link built here
 * is a complete document that needs nothing to exist. The fragment
 * (everything after `#`) is never sent to a server by the browser, which
 * is why the design goes there rather than in a query string.
 *
 * This is no longer the only kind of link. `share/store.ts` builds the
 * short kind, which keeps the design in a store and names it with an id;
 * that path encrypts first and puts its key in the fragment for exactly
 * the reason the design goes there here. Both end in the same validated
 * topology. What this file owns is the format that needs no store, which
 * is why its readers are kept: every link ever built by a `d1.`, `d2.` or
 * `d3.` encoder opens offline, forever.
 *
 * The payload is `d3.` followed by base64url text. Two facts drive that
 * shape:
 *
 *   - The version prefix. A future format has to be DETECTED, not
 *     misparsed: without a prefix, a v2 payload fed to a v1 reader would
 *     decode into plausible garbage and the reader would have no way to
 *     say "this link is newer than I am". One short token in front is the
 *     whole cost of never having that problem.
 *   - base64url, not base64. `+`, `/` and `=` are all hostile in a URL:
 *     the first two get percent-escaped by some clients and the padding
 *     is routinely eaten by chat apps and mail clients that guess where a
 *     link ends. The URL-safe alphabet has none of those characters.
 *
 * WHAT TRAVELS. The link has to fit inside the ~2000 characters that
 * chat apps and mail clients reliably carry, and the readable `Topology`
 * JSON does not: it spends most of its bytes on property names, string
 * ids and default values both ends already know. So the design goes
 * through a separate compact wire representation first (share/wire.ts),
 * then deflate, then base64url. Compression is the LAST step, not the
 * plan: deflate cannot recover the bytes a verbose layout wastes, it can
 * only shrink what it is given.
 *
 *   Topology  ->  packTopology  ->  deflate  ->  base64url  ->  #d3.…
 *
 * Deflate is applied only where the browser offers it and only when it
 * actually helps: for a three-node design the stream overhead can exceed
 * the saving, so the encoder keeps whichever of the two is shorter and
 * marks its choice in a single leading byte. The decoder reads that flag
 * rather than sniffing, so neither path can ever be mistaken for the
 * other.
 *
 * Older links (`d1.`, `d2.`) carried JSON and still open: their readers
 * are kept, unchanged, behind the prefix that names them.
 *
 * Everything arriving through here came from someone else's URL and is
 * untrusted exactly the way the clipboard is. It is validated by the SAME
 * `isTopology` the paste path and the saved session use, and its
 * annotations by the same `sanitizeAnnotations`; there is deliberately no
 * second validator here to drift out of step with those.
 * ------------------------------------------------------------------ */

/**
 * Format marker. Bumped only when the bytes behind it change meaning, at
 * which point an old reader reports an unreadable link instead of showing
 * a wrong one.
 */
export const SHARE_VERSION = 'd3';

const PREFIX = `${SHARE_VERSION}.`;

/** Every prefix this build can read. */
const KNOWN_PREFIXES = ['d1.', 'd2.', 'd3.'] as const;

/**
 * Longest share URL we will hand out, in characters, including the origin
 * and the fragment. Internet Explorer's old 2083-character ceiling is
 * gone, but Discord, Slack, Teams and several mail clients still cut or
 * refuse to linkify longer URLs, and a link that arrives in two pieces is
 * a link that does not open. 2000 leaves a margin under every one of
 * those.
 */
export const MAX_SHARE_URL_CHARS = 2000;

/**
 * Thrown by `buildShareUrl` when a design does not fit. Nothing is
 * truncated, dropped or rounded to make it fit: a link that opens a
 * different design from the one that was shared is worse than no link.
 * The caller tells the reader and offers the file export, which has no
 * size limit.
 */
export class ShareLinkTooLargeError extends Error {
  readonly chars: number;
  readonly limit: number;
  constructor(chars: number, limit: number) {
    super(`share link is ${chars} characters; the limit is ${limit}`);
    this.name = 'ShareLinkTooLargeError';
    this.chars = chars;
    this.limit = limit;
  }
}

/**
 * First byte of the decoded payload: which of the two encodings follows.
 * A flag rather than a sniff, so a document that happens to begin with a
 * deflate-looking byte cannot be mistaken for a compressed one.
 */
const RAW = 0;
const DEFLATED = 1;

/**
 * Largest document we will accept out of a link, in bytes.
 *
 * This is the decompression bomb guard. Deflate happily turns a few
 * hundred bytes of URL into hundreds of megabytes of output, and a
 * decoder that only checked its INPUT size would allocate all of it
 * before discovering the design was nonsense. The limit is applied to
 * the running output total, so a bomb is abandoned mid-stream rather
 * than after it has landed. Two megabytes is far above any real design
 * (the largest worked example is around 30KB of JSON) and far below
 * what would trouble a browser tab.
 */
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;

/**
 * Ceiling on the encoded text itself, as a cheap first gate. Browsers
 * start truncating URLs somewhere above this, so a longer one could not
 * have arrived intact anyway and there is no point decoding it.
 */
const MAX_ENCODED_CHARS = 512 * 1024;

/**
 * A byte buffer backed by an ordinary ArrayBuffer.
 *
 * Written out rather than left as a bare `Uint8Array`, whose default
 * buffer type also admits a SharedArrayBuffer: the stream APIs will not
 * take one, so spelling the narrower type keeps the mismatch a compile
 * error here rather than a runtime surprise in one browser.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/* ---------------- base64url ---------------- */

function toBase64Url(bytes: Bytes): string {
  // Chunked, because `String.fromCharCode(...bytes)` on a large design
  // spreads tens of thousands of arguments onto the stack and throws.
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Bytes | null {
  // Anything outside the alphabet means the link was mangled in transit
  // (or was never one of ours), and atob's own behaviour on stray
  // characters differs between engines. Reject it here so the answer is
  // the same everywhere.
  if (!/^[A-Za-z0-9\-_]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  // atob wants the padding back; the length modulo 4 says how much.
  const pad = b64.length % 4;
  if (pad === 1) return null;
  try {
    const bin = atob(pad === 0 ? b64 : b64 + '='.repeat(4 - pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/* ---------------- compression ---------------- */

/**
 * Whether this environment can deflate. Read at call time rather than
 * cached at module load, so a test can exercise both paths in one run
 * without the module remembering the wrong answer.
 */
function hasCompression(): boolean {
  return (
    typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
  );
}

/**
 * Feed a whole buffer into a transform stream and detach.
 *
 * Both promises are explicitly swallowed. When the reader on the other
 * end gives up on a bomb (see `drain`) the pending write and close reject
 * with that abort, and an unobserved rejection there would surface as a
 * crash in a context that has already handled the problem correctly.
 */
function pump(writable: WritableStream<BufferSource>, bytes: Bytes): void {
  const writer = writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
}

async function deflate(bytes: Bytes): Promise<Bytes> {
  const cs = new CompressionStream('deflate-raw');
  pump(cs.writable, bytes);
  const chunks = await drain(cs.readable, Number.POSITIVE_INFINITY);
  if (!chunks) throw new Error('deflate failed');
  return concat(chunks, Number.POSITIVE_INFINITY);
}

/**
 * Inflate with a hard ceiling on the OUTPUT. Returns null when the
 * stream is not valid deflate, and null when it runs past `limit`: a
 * link that expands to more than a real design ever could is a bomb, not
 * a diagram, and the only safe reading of it is no reading at all.
 */
async function inflate(bytes: Bytes, limit: number): Promise<Bytes | null> {
  try {
    const ds = new DecompressionStream('deflate-raw');
    pump(ds.writable, bytes);
    const chunks = await drain(ds.readable, limit);
    if (!chunks) return null;
    return concat(chunks, limit);
  } catch {
    // Malformed deflate data: the stream errors rather than returning.
    return null;
  }
}

/**
 * Read a stream to completion, giving up the moment the accumulated
 * output passes `limit`. Cancelling the reader is what actually stops a
 * bomb: without it the stream keeps inflating in the background.
 */
async function drain(
  stream: ReadableStream<Bytes>,
  limit: number,
): Promise<Bytes[] | null> {
  const reader = stream.getReader();
  const chunks: Bytes[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limit) {
        // Cancelling tears down the underlying inflater, which rejects
        // whatever it had pending; that rejection is the expected result
        // of giving up and is not a second failure to report.
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return chunks;
}

function concat(chunks: Bytes[], limit: number): Bytes {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const c of chunks) {
    if (at + c.length > out.length) break;
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/* ---------------- encode ---------------- */

/** One flag byte in front of a body. */
function framed(flag: number, body: Bytes): Bytes {
  const out = new Uint8Array(body.length + 1);
  out[0] = flag;
  out.set(body, 1);
  return out;
}

/**
 * The bytes behind the prefix: a flag byte, then the packed design either
 * as is or deflated, whichever is shorter. Exposed for the size benchmark
 * so it can measure exactly what a link carries.
 */
export async function encodeBytes(topology: Topology): Promise<Bytes> {
  const packed = packTopology(topology);
  if (hasCompression()) {
    try {
      const deflated = await deflate(packed);
      if (deflated.length < packed.length) return framed(DEFLATED, deflated);
    } catch {
      // Fall through to the plain encoding. A link that is longer than
      // it needed to be still opens; a link that failed to build does
      // not.
    }
  }
  return framed(RAW, packed);
}

/**
 * Encode a topology as the fragment text of a share link, without the
 * leading `#`. Compressed when the browser can and it helps, plain
 * otherwise; either way the result is URL-safe text a decoder on the far
 * side reads the same way.
 *
 * Only the design travels: the offered-load slider value is derived from
 * the client nodes on the other side, and the preset id is a fact about
 * the SENDER's session rather than about the design, so neither is worth
 * the characters. Live simulation state (queues, percentiles, a fault in
 * force right now) is never sent. What does travel, when the topology
 * carries them, is its seed and fault schedule, because those are what
 * make a run replay the same on the other side.
 */
export async function encodeTopology(topology: Topology): Promise<string> {
  return PREFIX + toBase64Url(await encodeBytes(topology));
}

/**
 * The whole shareable URL for a design, built from a base URL so the
 * function stays testable without a DOM. Query string and path are kept;
 * only the fragment is replaced.
 *
 * Throws `ShareLinkTooLargeError` when the result would not survive the
 * places links get pasted. Nothing is trimmed to fit: a design that does
 * not fit goes through the store instead (`share/store.ts`), or as a file
 * where there is no store configured.
 */
export async function buildShareUrl(topology: Topology, base: string): Promise<string> {
  const hash = await encodeTopology(topology);
  const hashless = base.split('#')[0] ?? base;
  const url = `${hashless}#${hash}`;
  if (url.length > MAX_SHARE_URL_CHARS) {
    throw new ShareLinkTooLargeError(url.length, MAX_SHARE_URL_CHARS);
  }
  return url;
}

/* ---------------- decode ---------------- */

/**
 * What came back from a link.
 *
 * A discriminated union rather than `Topology | null`, because the three
 * outcomes need three different things said to the reader: a design that
 * opened, a link that is not ours to read (leave the session alone and
 * say nothing), and a link that WAS ours and did not survive the trip
 * (say so, because the reader is entitled to know their link is broken
 * rather than watching it silently do nothing).
 */
export type ShareResult =
  | { status: 'ok'; topology: Topology }
  | { status: 'absent' }
  | { status: 'invalid'; message: string };

/** Copy for the one case a reader has to be told about. */
const BAD_LINK =
  'That shared link could not be read, so your own design was opened instead.';

/**
 * Is this fragment even ours? Cheap and synchronous, so a boot path can
 * decide whether to wait for a decode before showing anything, without
 * paying for the decode itself.
 */
export function hasShareHash(hash: string): boolean {
  const norm = normalize(hash);
  return KNOWN_PREFIXES.some((p) => norm.startsWith(p));
}

function normalize(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}

/**
 * Decode a fragment back into a topology.
 *
 * Never throws and never returns something the engine cannot run:
 * truncation, a wrong alphabet, valid base64 wrapped around nonsense, a
 * payload that inflates without bound and a design carrying a hostile
 * annotation colour all end in a plain report rather than a crash, a
 * blank canvas or a style injection.
 */
export async function decodeTopology(hash: string): Promise<ShareResult> {
  const text = normalize(hash);
  if (!text) return { status: 'absent' };

  const prefix = KNOWN_PREFIXES.find((p) => text.startsWith(p));
  if (!prefix) {
    // Some other fragment: a deep link, a scroll anchor, a router path.
    // Not ours, so not an error.
    return { status: 'absent' };
  }
  if (text.length > MAX_ENCODED_CHARS) {
    return { status: 'invalid', message: BAD_LINK };
  }

  const body = fromBase64Url(text.slice(prefix.length));
  if (!body || body.length < 2) return { status: 'invalid', message: BAD_LINK };

  // Current-generation links share their whole tail with the stored
  // path, which arrives at the same bytes by a different route.
  if (prefix === 'd3.') return decodeBytes(body);

  const payload = await unframe(body);
  if (!payload) return { status: 'invalid', message: BAD_LINK };
  return validate(parseLegacy(payload, prefix));
}

/**
 * Strip the one-byte compression flag and inflate if it says to.
 *
 * Returns null for a flag this build does not know, a stream that will
 * not inflate, and a payload that inflates past the ceiling: all of them
 * mean the same thing to the reader.
 */
async function unframe(body: Bytes): Promise<Bytes | null> {
  const flag = body[0];
  const rest = body.subarray(1);
  if (flag === DEFLATED) {
    // A compressed link opened where nothing can inflate it.
    if (!hasCompression()) return null;
    return inflate(rest, MAX_DECODED_BYTES);
  }
  if (flag === RAW) return rest.length > MAX_DECODED_BYTES ? null : rest;
  return null;
}

/**
 * Turn the packed bytes of a design back into a validated topology.
 *
 * Split out from `decodeTopology` because a stored link arrives at the
 * same place by a different route: its bytes come from the store and are
 * decrypted rather than lifted out of the fragment. Both paths land here
 * so there is one validator rather than two that drift.
 */
export async function decodeBytes(payload: Bytes): Promise<ShareResult> {
  if (payload.length < 2) return { status: 'invalid', message: BAD_LINK };
  const body = await unframe(payload);
  if (!body) return { status: 'invalid', message: BAD_LINK };
  return validate(unpackTopology(body));
}

/** The shared tail of both decode paths: structural gate, then sanitize. */
function validate(parsed: Parsed | null): ShareResult {
  if (!parsed) return { status: 'invalid', message: BAD_LINK };

  const candidate = { nodes: parsed.nodes, edges: parsed.edges };
  // The SAME structural gate the clipboard and the saved session use. A
  // dangling edge, an unknown kind or a non-finite coordinate is rejected
  // here, before the engine is ever handed the graph.
  if (!isTopology(candidate)) return { status: 'invalid', message: BAD_LINK };

  // Annotations are presentation data the engine never sees, so they
  // cross the boundary through their own sanitizer, which is also what
  // strips a colour crafted to break out of a style attribute.
  const annotations = sanitizeAnnotations(parsed.annotations);
  // A fault schedule names nodes and edges, so it is checked against the
  // graph that just passed, and an entry pointing at nothing is dropped.
  const faults = sanitizeFaults(parsed.faults, candidate);
  const seed = sanitizeSeed(parsed.seed);

  return {
    status: 'ok',
    topology: {
      nodes: candidate.nodes,
      edges: candidate.edges,
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(faults.length > 0 ? { faults } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
}

/** The loose shape a link yields before validation. */
interface Parsed {
  nodes?: unknown;
  edges?: unknown;
  annotations?: unknown;
  faults?: unknown;
  seed?: unknown;
}

/**
 * The JSON readers for generation 1 and 2 links, kept so an old link
 * still opens. A d2 payload has its default config fields stripped, so
 * they are put back before validation, exactly as that generation's
 * encoder expected its reader to.
 */
function parseLegacy(payload: Bytes, prefix: string): Parsed | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Parsed;

  if (prefix === 'd2.' && Array.isArray(p.nodes)) {
    for (const node of p.nodes) {
      if (
        node &&
        typeof node === 'object' &&
        typeof (node as Record<string, unknown>).kind === 'string'
      ) {
        const n = node as { kind: NodeKind; config?: Record<string, unknown> };
        n.config = { ...defaultConfig(n.kind), ...n.config };
      }
    }
  }
  return p;
}
