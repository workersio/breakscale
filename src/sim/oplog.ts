import type { FailureReason } from './types';

/* ------------------------------------------------------------------ *
 * The operation log: what each request did, for the correctness checks.
 *
 * Every request carries an id (`rid`) from the client onward. A child call
 * keeps its parent's id, and so does a retry, a write-behind flush and a
 * retry queue's redelivery, so every try of one logical request shares it.
 * A message a cron, a pub/sub topic or a stream broker sends on its own is
 * a new request with a new id.
 *
 * One request can legitimately reach the same part twice, down two
 * different paths of calls (A to B to Pay, and A to C to Pay). So a call is
 * named by its request id and its path, a hash of the parts it passed
 * through. A retry goes down the same path, so it has the same name, and a
 * second call down another path does not.
 *
 * Like the tally, the log only reads what the run does: it draws nothing,
 * changes no event and is not in the snapshot, so a run with a log replays
 * exactly as the same run without one. Off unless `Engine.startOpLog` asks
 * for it.
 *
 * Modelling choices the checks rest on:
 * - A part's work takes effect ("applies") when its own service finishes,
 *   after a crash check and its error rolls. A crash during service means
 *   the work was lost, and an error is a clean refusal, so neither applies.
 *   The work applies before the part's own downstream calls are made.
 * - A timeout cancels nothing. Work its caller gave up on keeps running and
 *   still applies, which is how a retry after a timeout charges twice.
 * - A write-behind cache's ack is the only place a write is said to be
 *   saved before it is. Every other store answers once the write is done,
 *   so a crash there fails the call and the caller hears it. A queue also
 *   answers before the work is done, but what it holds is a job, and the
 *   tally's `lostJobs` counts those. The buffered copy lands when the store
 *   behind the cache answers a try of its flush with success, even one the
 *   cache had stopped waiting for, since a timeout cancels nothing. It is
 *   lost only when every try has ended and none landed.
 * - A store whose reads trail its writes (a replica set, a search index)
 *   shows a write to reads once its lag has passed since the write applied.
 *   A read there sees what was visible when its service started, which is
 *   when the store's own code judges a read stale.
 * ------------------------------------------------------------------ */

export interface OpLogOptions {
  /** Node ids where every finished call charges money, on top of those set `chargeable: 1`. */
  chargeable?: readonly string[];
  /**
   * Which requests get a full event log: none (the checks only, which is
   * what a search needs), these request ids, or every one up to `maxEvents`.
   */
  follow?: 'none' | readonly number[] | 'all';
  /** Most events kept with `follow` set. Default 100,000; past it `truncated` is set. */
  maxEvents?: number;
}

/** What a request's root heard, per request id. */
export const OUTCOME_PENDING = 0;
export const OUTCOME_OK = 1;
export const OUTCOME_FAILED = 2;

/** What became of a write a write-behind cache buffered. */
export const BUFFER_PENDING = 0;
export const BUFFER_LANDED = 1;
export const BUFFER_DROPPED = 2;

/**
 * Everything one run recorded, as a copy the caller owns. Ids are indexes
 * into `names`. Requests are indexed by `rid - ridBase`.
 */
export interface OpLog {
  ridBase: number;
  names: string[];
  /** Per request: when its client sent it, or NaN for one no client sent. */
  invokeMs: Float64Array;
  /** Per request: the client's name index, or -1. */
  client: Int32Array;
  key: Uint8Array;
  /** Per request: OUTCOME_PENDING, OUTCOME_OK or OUTCOME_FAILED. */
  outcome: Uint8Array;
  /** Per request: when the client heard its answer, or NaN. */
  answeredMs: Float64Array;
  /** Every charge, in the order they happened. */
  charges: {
    rid: Int32Array;
    node: Int32Array;
    path: Int32Array;
    t: Float64Array;
  };
  /**
   * Every write a write-behind cache said was saved, in the order it did,
   * with what became of the copy it kept: BUFFER_PENDING, BUFFER_LANDED or
   * BUFFER_DROPPED, and when.
   */
  buffers: {
    rid: Int32Array;
    node: Int32Array;
    path: Int32Array;
    t: Float64Array;
    state: Uint8Array;
    endMs: Float64Array;
    /** Name index of why a dropped copy failed, else -1. */
    reason: Int32Array;
    /** Name index of the part whose failure lost it, else -1. */
    lostAt: Int32Array;
  };
  /**
   * Every read and write a store whose reads trail its writes applied.
   * `t` is when a read was served, or when a write became visible to reads.
   */
  accesses: {
    rid: Int32Array;
    node: Int32Array;
    key: Int32Array;
    write: Uint8Array;
    t: Float64Array;
  };
  events: EventColumns;
  /** More requests or events happened than the log keeps. */
  truncated: boolean;
}

interface EventColumns {
  t: Float64Array;
  rid: Int32Array;
  type: Uint8Array;
  node: Int32Array;
  /** The other node: the target of a send or of a timed-out call, where a copy was lost. */
  peer: Int32Array;
  edge: Int32Array;
  attempt: Int32Array;
  /** The call's path, on an apply. */
  value: Int32Array;
  /** By type: charged on an apply, still running on a dedupe, who heard an answer. */
  flag: Uint8Array;
  reason: Int32Array;
}

const E_INVOKE = 0;
const E_SEND = 1;
const E_LOST = 2;
const E_TIMEOUT = 3;
const E_RETRY = 4;
const E_APPLY = 5;
const E_DEDUPE = 6;
const E_ANSWER = 7;
const E_BUFFER = 8;
const E_LANDED = 9;
const E_DROPPED = 10;

/* Flags on an answer: who heard it. */
const HEARD_CALLER = 0;
const HEARD_CLIENT = 1;
const HEARD_NOBODY = 2;

const DEFAULT_MAX_EVENTS = 100_000;
/**
 * Most requests the per-request columns hold, at 22 bytes each: about 23MB.
 * Charges, buffered writes and reads are only kept for these requests.
 */
const MAX_REQUESTS = 1 << 20;
const INITIAL_REQUESTS = 8192;
const INITIAL_CHARGES = 1024;
const INITIAL_EVENTS = 1024;
const INITIAL_BUFFERS = 1024;
const INITIAL_ACCESSES = 1024;

function grownF64(a: Float64Array, need: number, fill = 0): Float64Array {
  if (need <= a.length) return a;
  const b = new Float64Array(Math.max(need, a.length * 2));
  if (fill !== 0) b.fill(fill, a.length);
  b.set(a);
  return b;
}

function grownI32(a: Int32Array, need: number, fill = 0): Int32Array {
  if (need <= a.length) return a;
  const b = new Int32Array(Math.max(need, a.length * 2));
  if (fill !== 0) b.fill(fill, a.length);
  b.set(a);
  return b;
}

function grownU8(a: Uint8Array, need: number): Uint8Array {
  if (need <= a.length) return a;
  const b = new Uint8Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

/**
 * The recorder the engine writes to. Nothing here allocates per event: the
 * columns are typed arrays that double when full, and names are interned.
 */
export class OpLogRecorder {
  readonly ridBase: number;
  private readonly extraCharge: ReadonlySet<string>;
  private readonly followAll: boolean;
  private readonly followSet: ReadonlySet<number> | null;
  private readonly maxEvents: number;
  private truncated = false;

  private names: string[] = [];
  private nameIndex = new Map<string, number>();

  private nReq = 0;
  private invokeMs: Float64Array = new Float64Array(INITIAL_REQUESTS).fill(Number.NaN);
  private client: Int32Array = new Int32Array(INITIAL_REQUESTS).fill(-1);
  private key: Uint8Array = new Uint8Array(INITIAL_REQUESTS);
  private outcome: Uint8Array = new Uint8Array(INITIAL_REQUESTS);
  private answeredMs: Float64Array = new Float64Array(INITIAL_REQUESTS).fill(
    Number.NaN,
  );

  private nCharge = 0;
  private cRid: Int32Array = new Int32Array(INITIAL_CHARGES);
  private cNode: Int32Array = new Int32Array(INITIAL_CHARGES);
  private cPath: Int32Array = new Int32Array(INITIAL_CHARGES);
  private cT: Float64Array = new Float64Array(INITIAL_CHARGES);

  private nBuf = 0;
  private bRid: Int32Array = new Int32Array(INITIAL_BUFFERS);
  private bNode: Int32Array = new Int32Array(INITIAL_BUFFERS);
  private bPath: Int32Array = new Int32Array(INITIAL_BUFFERS);
  private bT: Float64Array = new Float64Array(INITIAL_BUFFERS);
  private bState: Uint8Array = new Uint8Array(INITIAL_BUFFERS);
  private bEnd: Float64Array = new Float64Array(INITIAL_BUFFERS);
  private bReason: Int32Array = new Int32Array(INITIAL_BUFFERS);
  /** Tries of each copy's flush still on their way to the store. */
  private bTries: Int32Array = new Int32Array(INITIAL_BUFFERS);
  private bLostAt: Int32Array = new Int32Array(INITIAL_BUFFERS);
  /** The cache stopped waiting for the copy, with tries still out. */
  private bGaveUp: Uint8Array = new Uint8Array(INITIAL_BUFFERS);

  private nAcc = 0;
  private aRid: Int32Array = new Int32Array(INITIAL_ACCESSES);
  private aNode: Int32Array = new Int32Array(INITIAL_ACCESSES);
  private aKey: Int32Array = new Int32Array(INITIAL_ACCESSES);
  private aWrite: Uint8Array = new Uint8Array(INITIAL_ACCESSES);
  private aT: Float64Array = new Float64Array(INITIAL_ACCESSES);

  private nEv = 0;
  private ev: EventColumns;

  constructor(opts: OpLogOptions, ridBase: number) {
    this.ridBase = ridBase;
    this.extraCharge = new Set(opts.chargeable ?? []);
    const follow = opts.follow ?? 'none';
    this.followAll = follow === 'all';
    this.followSet = typeof follow === 'string' ? null : new Set(follow);
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    const n = follow === 'none' ? 0 : INITIAL_EVENTS;
    this.ev = {
      t: new Float64Array(n),
      rid: new Int32Array(n),
      type: new Uint8Array(n),
      node: new Int32Array(n),
      peer: new Int32Array(n),
      edge: new Int32Array(n),
      attempt: new Int32Array(n),
      value: new Int32Array(n),
      flag: new Uint8Array(n),
      reason: new Int32Array(n),
    };
  }

  private name(id: string): number {
    let i = this.nameIndex.get(id);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(id);
      this.nameIndex.set(id, i);
    }
    return i;
  }

  private follows(rid: number): boolean {
    return this.followAll || (this.followSet !== null && this.followSet.has(rid));
  }

  private event(
    t: number,
    rid: number,
    type: number,
    node: string,
    peer: string | null,
    edge: string | null,
    attempt: number,
    value: number,
    flag: number,
    reason: FailureReason | null,
  ): void {
    if (this.nEv >= this.maxEvents) {
      this.truncated = true;
      return;
    }
    const i = this.nEv++;
    let e = this.ev;
    if (i >= e.t.length) {
      const need = i + 1;
      e = this.ev = {
        t: grownF64(e.t, need),
        rid: grownI32(e.rid, need),
        type: grownU8(e.type, need),
        node: grownI32(e.node, need),
        peer: grownI32(e.peer, need),
        edge: grownI32(e.edge, need),
        attempt: grownI32(e.attempt, need),
        value: grownI32(e.value, need),
        flag: grownU8(e.flag, need),
        reason: grownI32(e.reason, need),
      };
    }
    e.t[i] = t;
    e.rid[i] = rid;
    e.type[i] = type;
    e.node[i] = this.name(node);
    e.peer[i] = peer === null ? -1 : this.name(peer);
    e.edge[i] = edge === null ? -1 : this.name(edge);
    e.attempt[i] = attempt;
    e.value[i] = value;
    e.flag[i] = flag;
    e.reason[i] = reason === null ? -1 : this.name(reason);
  }

  /** Index of `rid` in the per-request columns, growing them, or -1 past the cap. */
  private slot(rid: number): number {
    const i = rid - this.ridBase;
    if (i < 0) return -1;
    if (i >= MAX_REQUESTS) {
      this.truncated = true;
      return -1;
    }
    if (i >= this.invokeMs.length) {
      this.invokeMs = grownF64(this.invokeMs, i + 1, Number.NaN);
      this.client = grownI32(this.client, i + 1, -1);
      this.key = grownU8(this.key, i + 1);
      this.outcome = grownU8(this.outcome, i + 1);
      this.answeredMs = grownF64(this.answeredMs, i + 1, Number.NaN);
    }
    if (i >= this.nReq) this.nReq = i + 1;
    return i;
  }

  /** A client sent a new request. */
  invoke(t: number, rid: number, clientId: string, key: number): void {
    const i = this.slot(rid);
    if (i >= 0) {
      this.invokeMs[i] = t;
      this.client[i] = this.name(clientId);
      this.key[i] = key;
    }
    if (this.follows(rid))
      this.event(t, rid, E_INVOKE, clientId, null, null, 0, 0, 0, null);
  }

  /** Something other than a client started a request of its own. */
  emit(rid: number): void {
    this.slot(rid);
  }

  send(
    t: number,
    rid: number,
    from: string,
    to: string,
    edge: string,
    attempt: number,
  ): void {
    if (this.follows(rid))
      this.event(t, rid, E_SEND, from, to, edge, attempt, 0, 0, null);
  }

  /** A call that never reached its target: a cut or lossy link. */
  lost(
    t: number,
    rid: number,
    from: string,
    to: string,
    edge: string,
    attempt: number,
    reason: FailureReason,
  ): void {
    if (this.follows(rid))
      this.event(t, rid, E_LOST, from, to, edge, attempt, 0, 0, reason);
  }

  /** `caller` stopped waiting for its call to `to`. The call keeps running. */
  timeout(t: number, rid: number, caller: string, to: string, attempt: number): void {
    if (this.follows(rid))
      this.event(t, rid, E_TIMEOUT, caller, to, null, attempt, 0, 0, null);
  }

  /** `caller` will send the call again as `attempt`. */
  retry(t: number, rid: number, caller: string, to: string, attempt: number): void {
    if (this.follows(rid))
      this.event(t, rid, E_RETRY, caller, to, null, attempt, 0, 0, null);
  }

  /** A part's own work took effect. `chargeable` is the part's own setting. */
  apply(
    t: number,
    rid: number,
    path: number,
    node: string,
    attempt: number,
    chargeable: boolean,
  ): void {
    const charge = chargeable || this.extraCharge.has(node);
    const r = rid - this.ridBase;
    // Past the request cap the checks could not read it, so it is not kept.
    if (charge && r >= 0 && r < this.nReq) {
      const i = this.nCharge++;
      if (i >= this.cRid.length) {
        this.cRid = grownI32(this.cRid, i + 1);
        this.cNode = grownI32(this.cNode, i + 1);
        this.cPath = grownI32(this.cPath, i + 1);
        this.cT = grownF64(this.cT, i + 1);
      }
      this.cRid[i] = rid;
      this.cNode[i] = this.name(node);
      this.cPath[i] = path;
      this.cT[i] = t;
    }
    if (this.follows(rid)) {
      this.event(
        t,
        rid,
        E_APPLY,
        node,
        null,
        null,
        attempt,
        path,
        charge ? 1 : 0,
        null,
      );
    }
  }

  /**
   * A part that keeps idempotency keys saw a call it already had: finished,
   * so it answered from the first result, or still running, so it refused.
   */
  dedupe(
    t: number,
    rid: number,
    node: string,
    attempt: number,
    inFlight: boolean,
  ): void {
    if (this.follows(rid)) {
      this.event(
        t,
        rid,
        E_DEDUPE,
        node,
        null,
        null,
        attempt,
        0,
        inFlight ? 1 : 0,
        null,
      );
    }
  }

  /** A call answered, and who was listening: its caller, the client, or nobody. */
  answer(
    t: number,
    rid: number,
    node: string,
    ok: boolean,
    reason: FailureReason,
    heard: 'caller' | 'client' | 'nobody',
  ): void {
    if (heard === 'client') {
      const i = rid - this.ridBase;
      if (i >= 0 && i < this.nReq) {
        this.outcome[i] = ok ? OUTCOME_OK : OUTCOME_FAILED;
        this.answeredMs[i] = t;
      }
    }
    if (this.follows(rid)) {
      const flag =
        heard === 'caller'
          ? HEARD_CALLER
          : heard === 'client'
            ? HEARD_CLIENT
            : HEARD_NOBODY;
      this.event(t, rid, E_ANSWER, node, null, null, 0, 0, flag, ok ? null : reason);
    }
  }

  /**
   * A write-behind cache told its caller this write was saved and kept a
   * copy to flush. Returns the copy's number for `settle`, or -1 when the
   * log is not keeping it.
   */
  buffer(t: number, rid: number, path: number, node: string): number {
    const r = rid - this.ridBase;
    if (r < 0 || r >= this.nReq) return -1;
    const i = this.nBuf++;
    if (i >= this.bRid.length) {
      this.bRid = grownI32(this.bRid, i + 1);
      this.bNode = grownI32(this.bNode, i + 1);
      this.bPath = grownI32(this.bPath, i + 1);
      this.bT = grownF64(this.bT, i + 1);
      this.bState = grownU8(this.bState, i + 1);
      this.bEnd = grownF64(this.bEnd, i + 1);
      this.bReason = grownI32(this.bReason, i + 1);
      this.bLostAt = grownI32(this.bLostAt, i + 1);
      this.bTries = grownI32(this.bTries, i + 1);
      this.bGaveUp = grownU8(this.bGaveUp, i + 1);
    }
    this.bRid[i] = rid;
    this.bNode[i] = this.name(node);
    this.bPath[i] = path;
    this.bT[i] = t;
    this.bState[i] = BUFFER_PENDING;
    this.bEnd[i] = Number.NaN;
    this.bReason[i] = -1;
    this.bLostAt[i] = -1;
    this.bTries[i] = 0;
    this.bGaveUp[i] = 0;
    if (this.follows(rid))
      this.event(t, rid, E_BUFFER, node, null, null, 0, path, 0, null);
    return i;
  }

  /** A copy from a log started over has a number that is not its own. */
  private ownCopy(i: number, rid: number): boolean {
    return i >= 0 && i < this.nBuf && this.bRid[i] === rid;
  }

  /** The cache sent a try of copy `i`'s flush to the store. */
  flushSent(i: number, rid: number): void {
    if (this.ownCopy(i, rid)) this.bTries[i]++;
  }

  /**
   * A try of copy `i`'s flush ended at `at`, the part it was sent to,
   * whether or not the cache was still waiting for it. One that succeeded
   * saved the write.
   */
  flushEnded(
    i: number,
    t: number,
    rid: number,
    at: string,
    ok: boolean,
    reason: FailureReason,
  ): void {
    if (!this.ownCopy(i, rid)) return;
    this.bTries[i]--;
    if (ok) {
      this.land(i, t);
    } else if (this.bState[i] === BUFFER_PENDING) {
      // Kept for `settle`: the cache hears this failure in the same instant
      // and passes it on as its own, but the part that failed is this one.
      this.bEnd[i] = t;
      this.bLostAt[i] = this.name(at);
      this.bReason[i] = this.name(reason);
      if (this.bGaveUp[i] === 1 && this.bTries[i] === 0) this.drop(i, t, at, reason);
    }
  }

  /**
   * The cache, `at`, is done with copy `i`: it heard the flush succeed, or
   * it gave up. A copy given up on while a try is still out waits for it.
   */
  settle(
    i: number,
    t: number,
    rid: number,
    at: string,
    ok: boolean,
    reason: FailureReason,
  ): void {
    if (!this.ownCopy(i, rid)) return;
    if (ok) this.land(i, t);
    else if (this.bTries[i] > 0) this.bGaveUp[i] = 1;
    else if (this.bEnd[i] === t && this.bLostAt[i] >= 0) {
      this.drop(
        i,
        t,
        this.names[this.bLostAt[i]],
        this.names[this.bReason[i]] as FailureReason,
      );
    } else this.drop(i, t, at, reason);
  }

  private land(i: number, t: number): void {
    if (this.bState[i] === BUFFER_LANDED) return;
    this.bState[i] = BUFFER_LANDED;
    this.bEnd[i] = t;
    this.bReason[i] = -1;
    this.copyEvent(i, t, E_LANDED, null, null);
  }

  private drop(i: number, t: number, at: string, reason: FailureReason): void {
    if (this.bState[i] !== BUFFER_PENDING) return;
    this.bState[i] = BUFFER_DROPPED;
    this.bEnd[i] = t;
    this.bReason[i] = this.name(reason);
    this.bLostAt[i] = this.name(at);
    this.copyEvent(i, t, E_DROPPED, at, reason);
  }

  private copyEvent(
    i: number,
    t: number,
    type: number,
    at: string | null,
    reason: FailureReason | null,
  ): void {
    const rid = this.bRid[i];
    if (!this.follows(rid)) return;
    const node = this.names[this.bNode[i]];
    this.event(t, rid, type, node, at, null, 0, this.bPath[i], 0, reason);
  }

  /**
   * A store whose reads trail its writes applied a read, served as of
   * `t`, or a write, visible to reads from `t`.
   */
  access(t: number, rid: number, node: string, key: number, write: boolean): void {
    const r = rid - this.ridBase;
    if (r < 0 || r >= this.nReq) return;
    const i = this.nAcc++;
    if (i >= this.aRid.length) {
      this.aRid = grownI32(this.aRid, i + 1);
      this.aNode = grownI32(this.aNode, i + 1);
      this.aKey = grownI32(this.aKey, i + 1);
      this.aWrite = grownU8(this.aWrite, i + 1);
      this.aT = grownF64(this.aT, i + 1);
    }
    this.aRid[i] = rid;
    this.aNode[i] = this.name(node);
    this.aKey[i] = key;
    this.aWrite[i] = write ? 1 : 0;
    this.aT[i] = t;
  }

  read(): OpLog {
    const n = this.nEv;
    const e = this.ev;
    return {
      ridBase: this.ridBase,
      names: this.names.slice(),
      invokeMs: this.invokeMs.slice(0, this.nReq),
      client: this.client.slice(0, this.nReq),
      key: this.key.slice(0, this.nReq),
      outcome: this.outcome.slice(0, this.nReq),
      answeredMs: this.answeredMs.slice(0, this.nReq),
      charges: {
        rid: this.cRid.slice(0, this.nCharge),
        node: this.cNode.slice(0, this.nCharge),
        path: this.cPath.slice(0, this.nCharge),
        t: this.cT.slice(0, this.nCharge),
      },
      buffers: {
        rid: this.bRid.slice(0, this.nBuf),
        node: this.bNode.slice(0, this.nBuf),
        path: this.bPath.slice(0, this.nBuf),
        t: this.bT.slice(0, this.nBuf),
        state: this.bState.slice(0, this.nBuf),
        endMs: this.bEnd.slice(0, this.nBuf),
        reason: this.bReason.slice(0, this.nBuf),
        lostAt: this.bLostAt.slice(0, this.nBuf),
      },
      accesses: {
        rid: this.aRid.slice(0, this.nAcc),
        node: this.aNode.slice(0, this.nAcc),
        key: this.aKey.slice(0, this.nAcc),
        write: this.aWrite.slice(0, this.nAcc),
        t: this.aT.slice(0, this.nAcc),
      },
      events: {
        t: e.t.slice(0, n),
        rid: e.rid.slice(0, n),
        type: e.type.slice(0, n),
        node: e.node.slice(0, n),
        peer: e.peer.slice(0, n),
        edge: e.edge.slice(0, n),
        attempt: e.attempt.slice(0, n),
        value: e.value.slice(0, n),
        flag: e.flag.slice(0, n),
        reason: e.reason.slice(0, n),
      },
      truncated: this.truncated,
    };
  }
}

/* ---------------- the at-most-once check ---------------- */

/** One call charged more than once. */
export interface DoubleCharge {
  check: 'atMostOnce';
  rid: number;
  clientId: string;
  key: number;
  invokedMs: number;
  /** The part that charged it again: where the second charge happened. */
  nodeId: string;
  /** When each charge happened, in order: two or more. */
  chargedMs: number[];
  /**
   * Where each charge happened, in the same order. Usually one part; two
   * when a retry was sent to another copy of the payment part.
   */
  nodeIds: string[];
  /** What the client was told in the end. */
  outcome: 'ok' | 'failed' | 'pending';
}

export interface AtMostOnceResult {
  /** The earliest violations by when the request was sent, at most `MAX_VIOLATIONS`. */
  violations: DoubleCharge[];
  /** Every call charged more than once. */
  count: number;
  /** Requests checked: ones a client sent in the window that were charged at all. */
  checked: number;
  /** The log hit its request cap, so requests after it were not checked. */
  truncated: boolean;
}

export const MAX_VIOLATIONS = 50;

function outcomeWord(o: number): DoubleCharge['outcome'] {
  return o === OUTCOME_OK ? 'ok' : o === OUTCOME_FAILED ? 'failed' : 'pending';
}

/**
 * Every payment charged at most once: count the calls, among requests a
 * client sent in `[fromMs, toMs)`, that charged more than once. A call is
 * one request down one path, so a design that calls a payment part twice on
 * purpose, down two paths, is not a violation. A retry a load balancer sent
 * to another copy of the payment part is the same call, so a charge at each
 * copy is two. Requests no client sent (a cron's batch) are not checked.
 */
export function checkAtMostOnce(
  log: OpLog,
  fromMs: number,
  toMs: number,
): AtMostOnceResult {
  const c = log.charges;
  const nReq = log.invokeMs.length;
  // Charges of each request, chained through `next` from `head`.
  const head = new Int32Array(nReq).fill(-1);
  const next = new Int32Array(c.rid.length).fill(-1);
  const tail = new Int32Array(nReq).fill(-1);
  for (let i = 0; i < c.rid.length; i++) {
    const r = c.rid[i] - log.ridBase;
    if (r < 0 || r >= nReq) continue;
    const at = log.invokeMs[r];
    if (!(at >= fromMs && at < toMs)) continue;
    if (head[r] < 0) head[r] = i;
    else next[tail[r]] = i;
    tail[r] = i;
  }
  const violations: DoubleCharge[] = [];
  let count = 0;
  let checked = 0;
  const seen: number[] = [];
  for (let r = 0; r < nReq; r++) {
    if (head[r] < 0) continue;
    checked++;
    seen.length = 0;
    for (let i = head[r]; i >= 0; i = next[i]) {
      if (seen.includes(i)) continue;
      const times = [c.t[i]];
      const nodes = [log.names[c.node[i]]];
      for (let j = next[i]; j >= 0; j = next[j]) {
        if (c.path[j] === c.path[i]) {
          times.push(c.t[j]);
          nodes.push(log.names[c.node[j]]);
          seen.push(j);
        }
      }
      if (times.length < 2) continue;
      count++;
      if (violations.length < MAX_VIOLATIONS) {
        violations.push({
          check: 'atMostOnce',
          rid: r + log.ridBase,
          clientId: log.names[log.client[r]] ?? '',
          key: log.key[r],
          invokedMs: log.invokeMs[r],
          nodeId: nodes[1],
          chargedMs: times,
          nodeIds: nodes,
          outcome: outcomeWord(log.outcome[r]),
        });
      }
    }
  }
  return { violations, count, checked, truncated: log.truncated };
}

/* ---------------- the lost acknowledged write check ---------------- */

/** A write the client was told was saved that never reached the store. */
export interface LostWrite {
  check: 'lostAckedWrite';
  rid: number;
  clientId: string;
  key: number;
  invokedMs: number;
  /** When the client heard it was saved. */
  ackedMs: number;
  /** The write-behind cache that held it. */
  nodeId: string;
  /** When the cache said it was saved. */
  bufferedMs: number;
  /** When its copy was lost. */
  lostMs: number;
  /** Why the copy was lost: the cache crashed, or the flush failed. */
  reason: FailureReason;
  /** The part whose failure lost it: the cache, or the store it flushes to. */
  lostAt: string;
}

export interface LostWritesResult {
  /** The earliest violations by when the request was sent, at most `MAX_VIOLATIONS`. */
  violations: LostWrite[];
  /** Acknowledged writes that were lost. */
  count: number;
  /** Writes checked: ones a client sent in the window and was told were saved. */
  checked: number;
  /** Of those, writes still on their way to the store when the run ended. Not counted as lost. */
  pending: number;
  /** The log hit its request cap, so requests after it were not checked. */
  truncated: boolean;
}

/**
 * No acknowledged write lost: among requests a client sent in
 * `[fromMs, toMs)` and was told succeeded, count the writes a write-behind
 * cache said were saved whose copy never landed and was lost. One write is
 * one request down one path, so when a retry was buffered again, even by
 * another copy of the cache, either copy landing saves it. A copy still waiting to flush when the run ended is
 * pending, not lost, so it is counted apart.
 */
export function checkLostAckedWrites(
  log: OpLog,
  fromMs: number,
  toMs: number,
): LostWritesResult {
  const b = log.buffers;
  const nReq = log.invokeMs.length;
  // The copies of one write, by request, node and path. `best` keeps the
  // first copy that settles the question: one that landed, else one still
  // pending, else the first one lost.
  const best = new Map<string, number>();
  const rank = (i: number) =>
    b.state[i] === BUFFER_LANDED ? 2 : b.state[i] === BUFFER_PENDING ? 1 : 0;
  for (let i = 0; i < b.rid.length; i++) {
    const r = b.rid[i] - log.ridBase;
    if (r < 0 || r >= nReq || log.outcome[r] !== OUTCOME_OK) continue;
    const at = log.invokeMs[r];
    if (!(at >= fromMs && at < toMs)) continue;
    const call = `${b.rid[i]}:${b.path[i]}`;
    const was = best.get(call);
    if (was === undefined || rank(i) > rank(was)) best.set(call, i);
  }
  const lost: number[] = [];
  let pending = 0;
  for (const i of best.values()) {
    if (b.state[i] === BUFFER_DROPPED) lost.push(i);
    else if (b.state[i] === BUFFER_PENDING) pending++;
  }
  lost.sort((x, y) => b.rid[x] - b.rid[y] || x - y);
  const violations: LostWrite[] = [];
  for (const i of lost.slice(0, MAX_VIOLATIONS)) {
    const r = b.rid[i] - log.ridBase;
    violations.push({
      check: 'lostAckedWrite',
      rid: b.rid[i],
      clientId: log.names[log.client[r]] ?? '',
      key: log.key[r],
      invokedMs: log.invokeMs[r],
      ackedMs: log.answeredMs[r],
      nodeId: log.names[b.node[i]],
      bufferedMs: b.t[i],
      lostMs: b.endMs[i],
      reason: log.names[b.reason[i]] as FailureReason,
      lostAt: log.names[b.lostAt[i]] ?? '',
    });
  }
  return {
    violations,
    count: lost.length,
    checked: best.size,
    pending,
    truncated: log.truncated,
  };
}

/* ---------------- the read-your-writes check ---------------- */

/** A read that did not see a write its own client had been told was saved. */
export interface StaleRead {
  check: 'readYourWrites';
  rid: number;
  clientId: string;
  key: number;
  invokedMs: number;
  /** The store that served the read. */
  nodeId: string;
  /** When the store served it. */
  readMs: number;
  /** The client's write it did not see. */
  wroteRid: number;
  /** When the client was told that write was saved. */
  savedMs: number;
  /** When that write showed up in reads. */
  visibleMs: number;
}

export interface ReadYourWritesResult {
  /** The earliest violations by when the read was sent, at most `MAX_VIOLATIONS`. */
  violations: StaleRead[];
  /** Reads that missed their own client's saved write. */
  count: number;
  /** Reads checked: ones a client sent in the window to a store whose reads trail its writes. */
  checked: number;
  /** The log hit its request cap, so requests after it were not checked. */
  truncated: boolean;
}

/**
 * Read your writes: among reads a client sent in `[fromMs, toMs)` to a
 * store whose reads trail its writes, count the ones served before a write
 * of the same key, from the same client, had become visible, when the
 * client had already been told that write was saved before it sent the
 * read. A client here is one client part, standing for its users.
 */
export function checkReadYourWrites(
  log: OpLog,
  fromMs: number,
  toMs: number,
): ReadYourWritesResult {
  const a = log.accesses;
  const nReq = log.invokeMs.length;
  // A client's saved writes, by when it heard they were saved, swept
  // against its reads by when it sent them. `latest` holds, per store, key
  // and client, the write visible last among those heard so far.
  const writes: number[] = [];
  const reads: number[] = [];
  for (let i = 0; i < a.rid.length; i++) {
    const r = a.rid[i] - log.ridBase;
    if (r < 0 || r >= nReq || log.client[r] < 0) continue;
    if (a.write[i] === 1) {
      if (log.outcome[r] === OUTCOME_OK) writes.push(i);
    } else {
      const at = log.invokeMs[r];
      if (at >= fromMs && at < toMs) reads.push(i);
    }
  }
  const ackOf = (i: number) => log.answeredMs[a.rid[i] - log.ridBase];
  const sentOf = (i: number) => log.invokeMs[a.rid[i] - log.ridBase];
  writes.sort((x, y) => ackOf(x) - ackOf(y) || x - y);
  reads.sort((x, y) => sentOf(x) - sentOf(y) || x - y);
  const latest = new Map<string, number>();
  const missed = new Set<number>();
  const violations: StaleRead[] = [];
  const readRids = new Set<number>();
  let w = 0;
  for (const i of reads) {
    const sent = sentOf(i);
    for (; w < writes.length && ackOf(writes[w]) <= sent; w++) {
      const j = writes[w];
      const k = `${a.node[j]}:${a.key[j]}:${log.client[a.rid[j] - log.ridBase]}`;
      const was = latest.get(k);
      if (was === undefined || a.t[j] > a.t[was]) latest.set(k, j);
    }
    const rid = a.rid[i];
    readRids.add(rid);
    if (missed.has(rid)) continue;
    const r = rid - log.ridBase;
    const j = latest.get(`${a.node[i]}:${a.key[i]}:${log.client[r]}`);
    if (j === undefined || !(a.t[i] < a.t[j])) continue;
    missed.add(rid);
    violations.push({
      check: 'readYourWrites',
      rid,
      clientId: log.names[log.client[r]] ?? '',
      key: a.key[i],
      invokedMs: sent,
      nodeId: log.names[a.node[i]],
      readMs: a.t[i],
      wroteRid: a.rid[j],
      savedMs: ackOf(j),
      visibleMs: a.t[j],
    });
  }
  violations.sort((x, y) => x.rid - y.rid);
  return {
    violations: violations.slice(0, MAX_VIOLATIONS),
    count: missed.size,
    checked: readRids.size,
    truncated: log.truncated,
  };
}

/** Anything a correctness check found. */
export type Violation = DoubleCharge | LostWrite | StaleRead;

/* ---------------- one request's story ---------------- */

export type TimelineEvent =
  | { t: number; type: 'invoke'; node: string }
  | { t: number; type: 'send'; from: string; to: string; edge: string; attempt: number }
  /** The call never arrived: the link was cut, or dropped it. */
  | {
      t: number;
      type: 'lost';
      from: string;
      to: string;
      edge: string;
      attempt: number;
      reason: FailureReason;
    }
  /** `node` stopped waiting for its call to `to`. That call keeps running. */
  | { t: number; type: 'timeout'; node: string; to: string; attempt: number }
  /** `node` will call `to` again; `attempt` is the try it is about to send. */
  | { t: number; type: 'retry'; node: string; to: string; attempt: number }
  /**
   * `node`'s own work took effect. `charge` when it charges money there, and
   * `repeat` when this call had already been charged there.
   */
  | {
      t: number;
      type: 'apply';
      node: string;
      attempt: number;
      charge: boolean;
      repeat: boolean;
    }
  /** `node`, a write-behind cache, told its caller the write was saved and kept a copy. */
  | { t: number; type: 'buffered'; node: string }
  /** The copy `node` kept reached the store. */
  | { t: number; type: 'landed'; node: string }
  /** The copy `node` kept was lost when `at` failed: the cache itself, or the store. */
  | { t: number; type: 'dropped'; node: string; at: string; reason: FailureReason }
  /** `node` had this call already: answered from it, or refused while it ran. */
  | { t: number; type: 'dedupe'; node: string; attempt: number; inFlight: boolean }
  /**
   * `node` answered. `heard` is who was listening: its caller, the client
   * itself for the request's own answer, or nobody, because the caller had
   * stopped waiting.
   */
  | {
      t: number;
      type: 'answer';
      node: string;
      ok: boolean;
      reason: FailureReason | null;
      heard: 'caller' | 'client' | 'nobody';
    };

export interface RequestTimeline {
  rid: number;
  /** The client that sent it, or null for a request no client sent. */
  clientId: string | null;
  key: number | null;
  events: TimelineEvent[];
  /** The log ran out of room, so events may be missing. */
  truncated: boolean;
}

/** Everything the log holds about one request, in the order it happened. */
export function timelineOf(log: OpLog, rid: number): RequestTimeline | null {
  const e = log.events;
  const name = (i: number) => log.names[i] ?? '';
  const reasonOf = (i: number) => (i < 0 ? null : (log.names[i] as FailureReason));
  const events: TimelineEvent[] = [];
  const charged = new Set<number>();
  for (let i = 0; i < e.t.length; i++) {
    if (e.rid[i] !== rid) continue;
    const t = e.t[i];
    const node = name(e.node[i]);
    const attempt = e.attempt[i];
    switch (e.type[i]) {
      case E_INVOKE:
        events.push({ t, type: 'invoke', node });
        break;
      case E_SEND:
        events.push({
          t,
          type: 'send',
          from: node,
          to: name(e.peer[i]),
          edge: name(e.edge[i]),
          attempt,
        });
        break;
      case E_LOST:
        events.push({
          t,
          type: 'lost',
          from: node,
          to: name(e.peer[i]),
          edge: name(e.edge[i]),
          attempt,
          reason: reasonOf(e.reason[i]) ?? 'error',
        });
        break;
      case E_TIMEOUT:
      case E_RETRY:
        events.push({
          t,
          type: e.type[i] === E_TIMEOUT ? 'timeout' : 'retry',
          node,
          to: name(e.peer[i]),
          attempt,
        });
        break;
      case E_APPLY: {
        // A charge on a path already charged is a repeat, at whichever copy
        // of the payment part it happened.
        const charge = e.flag[i] === 1;
        const call = e.value[i];
        const repeat = charge && charged.has(call);
        if (charge) charged.add(call);
        events.push({ t, type: 'apply', node, attempt, charge, repeat });
        break;
      }
      case E_DEDUPE:
        events.push({ t, type: 'dedupe', node, attempt, inFlight: e.flag[i] === 1 });
        break;
      case E_BUFFER:
        events.push({ t, type: 'buffered', node });
        break;
      case E_LANDED:
        events.push({ t, type: 'landed', node });
        break;
      case E_DROPPED:
        events.push({
          t,
          type: 'dropped',
          node,
          at: name(e.peer[i]),
          reason: reasonOf(e.reason[i]) ?? 'error',
        });
        break;
      case E_ANSWER: {
        const flag = e.flag[i];
        events.push({
          t,
          type: 'answer',
          node,
          ok: e.reason[i] < 0,
          reason: reasonOf(e.reason[i]),
          heard:
            flag === HEARD_CLIENT
              ? 'client'
              : flag === HEARD_NOBODY
                ? 'nobody'
                : 'caller',
        });
        break;
      }
      default:
        break;
    }
  }
  const r = rid - log.ridBase;
  const known = r >= 0 && r < log.invokeMs.length;
  if (events.length === 0 && !known) return null;
  const sent = known && !Number.isNaN(log.invokeMs[r]);
  return {
    rid,
    clientId: sent ? name(log.client[r]) : null,
    key: sent ? log.key[r] : null,
    events,
    truncated: log.truncated,
  };
}
