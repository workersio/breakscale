import { type Bytes, encodeBytes, decodeBytes, type ShareResult } from '../share';
import { hasCrypto, open, seal } from './crypto';

/* ------------------------------------------------------------------ *
 * Stored share links.
 *
 * The fragment format carries a whole design in the URL, which is what
 * makes a link a complete document that needs nothing to exist. It also
 * means the URL grows with the design, and past about 2000 characters
 * chat apps and mail clients stop carrying it: the designs most worth
 * sharing were the ones a link could not hold.
 *
 * A stored link fixes the length by moving the bytes rather than
 * shrinking them:
 *
 *   https://breakscale.tech/?s=<id>#k=<key>
 *
 * The id names an encrypted blob in the store. The key opens it and
 * rides in the fragment, which the browser never sends anywhere, so the
 * store holds ciphertext it has no way to read. See ./crypto.ts for why
 * that split is the whole design.
 *
 * The length is then fixed whatever the design: about 60 characters,
 * for a three-node sketch and a twenty-node reconstruction alike.
 *
 * WHAT THIS COSTS, SAID PLAINLY. A stored link needs the store to be
 * reachable when it is created and when it is opened, and the old
 * fragment links did not need anything. That is a real loss and it is
 * why the fragment readers are kept: `d1.`, `d2.` and `d3.` links keep
 * opening exactly as they did, offline, forever.
 * ------------------------------------------------------------------ */

/**
 * Where the store lives. Empty means this build has none, which is the
 * case for a contributor running the app locally without the Worker: the
 * app then falls back to fragment links and everything except short URLs
 * still works.
 */
function endpoint(): string {
  // Read at call time, not once at module load, so a test can exercise
  // both the configured and the unconfigured path in one run and so a
  // build without the variable is not baked in at import.
  return (import.meta.env?.VITE_SHARE_API ?? '').replace(/\/$/, '');
}

/**
 * Point this module at a store for the duration of a test.
 *
 * Exported for tests alone. The app never calls it: production reads the
 * build's own variable, and a store that could be repointed at runtime
 * would be a way to make someone's browser upload their design somewhere
 * the build never named.
 */
export function setEndpointForTests(url: string | null): void {
  override = url;
}

let override: string | null = null;

function resolved(): string {
  return override ?? endpoint();
}

/** Query parameter naming the stored blob. */
export const ID_PARAM = 's';

/** Fragment parameter carrying the key. */
const KEY_PREFIX = 'k=';

/**
 * How long to wait on the store before giving up.
 *
 * A share button that hangs is worse than one that fails: the reader can
 * act on "that did not work, here is the file export" and cannot act on
 * a spinner.
 */
const TIMEOUT_MS = 10_000;

/** Ceiling on a blob coming back, before it is decrypted. */
const MAX_BLOB_BYTES = 256 * 1024;

export function hasStore(): boolean {
  return resolved() !== '' && hasCrypto();
}

function toBase64Url(bytes: Bytes): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9\-_]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
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

/** Raised when the store could not take a design. */
export class ShareStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareStoreError';
  }
}

/**
 * Encrypt a design, hand the ciphertext to the store, and return the
 * whole link.
 *
 * The key never leaves this function except into the fragment of the
 * returned URL, and the request body is the sealed blob alone: no name,
 * no session, no preset id, nothing that would let stored designs be
 * grouped by who made them.
 */
export async function storeTopology(
  topology: Parameters<typeof encodeBytes>[0],
  base: string,
): Promise<string> {
  if (!hasStore())
    // Not reachable from the app, which checks `hasStore()` and falls
    // back to a fragment link. It is here for whoever calls this module
    // directly, and it names the variable rather than the symptom.
    throw new ShareStoreError(
      'No link store is configured. Set VITE_SHARE_API, or run `bun run dev:links` to use a local one.',
    );

  const { blob, key } = await seal(await encodeBytes(topology));

  let res: Response;
  try {
    res = await fetch(`${resolved()}/v1`, {
      method: 'POST',
      body: blob,
      headers: { 'content-type': 'application/octet-stream' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ShareStoreError(
      'Could not reach the link store. Check your connection, or save the design to a file instead.',
    );
  }

  if (res.status === 429) {
    // Someone sharing designs by hand never sees this; it is the limit
    // that stops one caller spending the day's budget. So it is worded
    // as a pause rather than a refusal, and it says how long, because a
    // wait nobody has put a number on feels indefinite.
    throw new ShareStoreError(
      'Too many links were made in a short time. Try again in a minute, or save the design to a file.',
    );
  }
  if (res.status === 413) {
    throw new ShareStoreError(
      'That design is too big for the link store. Save it to a file instead, which has no limit.',
    );
  }
  if (!res.ok) {
    throw new ShareStoreError(
      'The link store would not take this design. Saving it to a file works either way.',
    );
  }

  const body: unknown = await res.json().catch(() => null);
  const id =
    body !== null &&
    typeof body === 'object' &&
    'id' in body &&
    typeof body.id === 'string'
      ? body.id
      : null;
  if (id === null)
    throw new ShareStoreError(
      'The link could not be made. Try again, or save the design to a file.',
    );

  const url = new URL(base);
  url.hash = '';
  url.searchParams.set(ID_PARAM, id);
  return `${url.toString()}#${KEY_PREFIX}${toBase64Url(key)}`;
}

/**
 * Whether a location looks like a stored link, without fetching
 * anything. Cheap and synchronous for the same reason `hasShareHash` is:
 * the boot path decides what to show before any decode happens.
 */
export function hasStoredLink(search: string, hash: string): boolean {
  const id = new URLSearchParams(search).get(ID_PARAM);
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return id !== null && id !== '' && h.startsWith(KEY_PREFIX);
}

/**
 * Fetch and decrypt a stored design.
 *
 * Everything that can go wrong here is somebody else's URL going wrong,
 * so all of it ends in a plain report: an id that was never ours, a
 * store that is down, a key mistyped by one character, a blob truncated
 * by a chat client that ate the end of the URL. The decrypted bytes then
 * go through the SAME decode and validation the fragment path uses, so a
 * stored design is no more trusted than a pasted one.
 */
export async function fetchStored(search: string, hash: string): Promise<ShareResult> {
  const id = new URLSearchParams(search).get(ID_PARAM);
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (id === null || !h.startsWith(KEY_PREFIX)) return { status: 'absent' };

  const bad =
    'That shared link could not be read, so your own design was opened instead.';
  if (!hasStore()) return { status: 'invalid', message: bad };

  const key = fromBase64Url(h.slice(KEY_PREFIX.length));
  if (key === null || key.length !== 16) return { status: 'invalid', message: bad };

  let res: Response;
  try {
    res = await fetch(`${resolved()}/v1/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return {
      status: 'invalid',
      message: 'Could not reach the link store, so your own design was opened instead.',
    };
  }
  if (!res.ok) return { status: 'invalid', message: bad };

  const raw = await res.arrayBuffer();
  if (raw.byteLength === 0 || raw.byteLength > MAX_BLOB_BYTES) {
    return { status: 'invalid', message: bad };
  }

  const plain = await open(new Uint8Array(raw), key);
  if (plain === null) return { status: 'invalid', message: bad };

  return decodeBytes(plain);
}
