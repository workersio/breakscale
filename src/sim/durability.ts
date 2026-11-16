/* ------------------------------------------------------------------ *
 * Writes a store has said are saved that are not on its disk yet.
 *
 * A database or replica set with `flushEveryMs` above 0 answers once a
 * write applies and has it on disk `flushEveryMs` later. That is the
 * longest a periodic flush (Redis's appendfsync everysec, Postgres with
 * synchronous_commit off) can leave a write in memory, so a crash at any
 * moment loses the most the setting can, and the loss does not depend on
 * where a round-numbered crash happens to fall against a flush clock.
 *
 * Nothing here draws a random number or schedules an event. A write is on
 * disk once the clock has passed its time, and that is settled whenever
 * the engine next looks: at the store's next write, when it goes down, and
 * when a tally or a log is read. So a run with the setting plays exactly as
 * one without it, apart from what a crash then loses.
 * ------------------------------------------------------------------ */

const INITIAL = 64;

/**
 * The writes one store holds in memory, oldest first. `T` is whatever the
 * engine needs back when a write lands or is lost: the tally that counted it.
 */
export class UnflushedWrites<T> {
  private due: Float64Array = new Float64Array(INITIAL);
  private rid: Int32Array = new Int32Array(INITIAL);
  /** The op log's number for the write, or -1. */
  private copy: Int32Array = new Int32Array(INITIAL);
  private tag: (T | null)[] = [];
  private head = 0;
  private tail = 0;

  /** Writes held, the ones already due included until the next settle. */
  get size(): number {
    return this.tail - this.head;
  }

  /** A write applied now and on disk at `dueMs`. */
  push(dueMs: number, rid: number, copy: number, tag: T | null): void {
    if (this.tail === this.due.length) this.makeRoom();
    const i = this.tail++;
    this.due[i] = dueMs;
    this.rid[i] = rid;
    this.copy[i] = copy;
    this.tag[i] = tag;
  }

  /**
   * Hand every write due by `now` to `land`, oldest first, and forget it.
   * A setting changed mid-run can leave a later write due before an older
   * one; it waits behind that one, and `pending` still counts it as on disk.
   */
  settle(
    now: number,
    land: (dueMs: number, rid: number, copy: number, tag: T | null) => void,
  ): void {
    while (this.head < this.tail && this.due[this.head] <= now) {
      const i = this.head++;
      land(this.due[i], this.rid[i], this.copy[i], this.tag[i]);
      this.tag[i] = null;
    }
    if (this.head === this.tail) this.head = this.tail = 0;
  }

  /** Writes not on disk at `now`. */
  pending(now: number): number {
    let n = 0;
    for (let i = this.head; i < this.tail; i++) if (this.due[i] > now) n++;
    return n;
  }

  /**
   * The store went down at `now`: what was due lands, the rest is lost.
   * Returns how many were lost. Empties the list.
   */
  crash(
    now: number,
    land: (dueMs: number, rid: number, copy: number, tag: T | null) => void,
    lose: (rid: number, copy: number, tag: T | null) => void,
  ): number {
    let lost = 0;
    for (let i = this.head; i < this.tail; i++) {
      if (this.due[i] <= now) {
        land(this.due[i], this.rid[i], this.copy[i], this.tag[i]);
      } else {
        lose(this.rid[i], this.copy[i], this.tag[i]);
        lost++;
      }
      this.tag[i] = null;
    }
    this.head = this.tail = 0;
    return lost;
  }

  /** Slide what is held to the front, or double the columns when full. */
  private makeRoom(): void {
    const n = this.tail - this.head;
    if (this.head > 0 && n * 2 <= this.due.length) {
      this.due.copyWithin(0, this.head, this.tail);
      this.rid.copyWithin(0, this.head, this.tail);
      this.copy.copyWithin(0, this.head, this.tail);
      for (let i = 0; i < n; i++) this.tag[i] = this.tag[this.head + i];
      this.tag.length = n;
    } else {
      const size = this.due.length * 2;
      const due = new Float64Array(size);
      const rid = new Int32Array(size);
      const copy = new Int32Array(size);
      due.set(this.due.subarray(this.head, this.tail));
      rid.set(this.rid.subarray(this.head, this.tail));
      copy.set(this.copy.subarray(this.head, this.tail));
      this.due = due;
      this.rid = rid;
      this.copy = copy;
      this.tag = this.tag.slice(this.head, this.tail);
    }
    this.head = 0;
    this.tail = n;
  }
}
