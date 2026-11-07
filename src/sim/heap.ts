/** Min-heap keyed by `time`, ties broken by insertion sequence for determinism. */
export interface Timed {
  time: number;
  seq: number;
}

export class MinHeap<T extends Timed> {
  private items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(a[i], a[parent])) {
        swap(a, i, parent);
        i = parent;
      } else break;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && less(a[l], a[smallest])) smallest = l;
        if (r < a.length && less(a[r], a[smallest])) smallest = r;
        if (smallest === i) break;
        swap(a, i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  /**
   * Visit every item, in storage order rather than time order. The heap must
   * not be changed while this runs, so a caller that acts on what it finds
   * collects first and acts after.
   */
  each(visit: (item: T) => void): void {
    const a = this.items;
    for (let i = 0; i < a.length; i++) visit(a[i]);
  }
}

function less(a: Timed, b: Timed): boolean {
  return a.time !== b.time ? a.time < b.time : a.seq < b.seq;
}

function swap(a: unknown[], i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}
