import type { Topology } from '../sim/types';

/**
 * The loops in a design: each group of parts that work can travel round,
 * by node id, in the order the nodes are listed. A part with an edge to
 * itself is a loop of one. Every edge counts, through queues and topics too,
 * which is what the engine follows when it charges a request for going round
 * (markLoops in sim/engine.ts).
 */
export function loopsOf(topology: Topology): readonly (readonly string[])[] {
  const out = new Map<string, string[]>();
  for (const n of topology.nodes) out.set(n.id, []);
  const self = new Set<string>();
  for (const e of topology.edges) {
    const list = out.get(e.from);
    if (list === undefined || !out.has(e.to)) continue;
    list.push(e.to);
    if (e.from === e.to) self.add(e.from);
  }

  // Tarjan's strongly connected components, iterative so a long chain from
  // a shared link cannot overflow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let counter = 0;
  for (const root of out.keys()) {
    if (index.has(root)) continue;
    const work: { id: string; next: number }[] = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1] as { id: string; next: number };
      const targets = out.get(top.id) ?? [];
      if (top.next < targets.length) {
        const w = targets[top.next++] as string;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(top.id, Math.min(low.get(top.id) as number, index.get(w) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(
          parent.id,
          Math.min(low.get(parent.id) as number, low.get(top.id) as number),
        );
      }
      if (low.get(top.id) !== index.get(top.id)) continue;
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        members.push(w);
      } while (w !== top.id);
      if (members.length > 1 || self.has(top.id)) found.push(members);
    }
  }

  const order = new Map(topology.nodes.map((n, i) => [n.id, i]));
  for (const m of found) m.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  found.sort((a, b) => (order.get(a[0] ?? '') ?? 0) - (order.get(b[0] ?? '') ?? 0));
  return found;
}

/** "Client", "Client and Topic", "Client, Topic and Cache", "Client, Topic and 3 more parts". */
export function listParts(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length > 3) {
    return `${labels.slice(0, 2).join(', ')} and ${labels.length - 2} more parts`;
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
