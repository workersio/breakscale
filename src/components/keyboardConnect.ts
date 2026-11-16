/**
 * Keyboard connect: with one part selected, L starts a link from it, the
 * arrow keys pick the part it goes to and Enter makes it. The picking is
 * here, pure; Canvas owns the keys and makes the edge through the same
 * checked path as a port drag.
 */

export interface ConnectPoint {
  readonly id: string;
  /** The part's centre, in world units. */
  readonly x: number;
  readonly y: number;
}

export type ConnectDir = 'left' | 'right' | 'up' | 'down';

const DIR: Record<ConnectDir, readonly [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

export const ARROW_DIR: Readonly<Record<string, ConnectDir>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * The parts a link may go to, in the order a diagram is read: left to
 * right, then top to bottom within a column. That order is the fallback
 * when no part lies in the direction pressed, so every one can be reached.
 */
export function connectOrder(points: readonly ConnectPoint[]): ConnectPoint[] {
  return [...points].sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1));
}

/**
 * The nearest part in direction `dir` from `at`, weighting sideways distance
 * double so a part straight ahead wins over a closer one off to the side.
 * Null when nothing lies that way.
 */
export function nearestToward(
  at: { x: number; y: number },
  points: readonly ConnectPoint[],
  dir: ConnectDir,
  skip?: string,
): ConnectPoint | null {
  const [dx, dy] = DIR[dir];
  let best: ConnectPoint | null = null;
  let bestScore = Infinity;
  for (const p of points) {
    if (p.id === skip) continue;
    const vx = p.x - at.x;
    const vy = p.y - at.y;
    const along = vx * dx + vy * dy;
    if (along <= 0) continue;
    const side = Math.abs(vx * dy - vy * dx);
    const score = along + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * The first part to offer: downstream (to the right) of the source if there
 * is one, since that is where a link usually goes, else the nearest.
 */
export function firstPick(
  from: { x: number; y: number },
  points: readonly ConnectPoint[],
): string | null {
  const right = nearestToward(from, points, 'right');
  if (right) return right.id;
  let best: ConnectPoint | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = Math.hypot(p.x - from.x, p.y - from.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best?.id ?? null;
}

/**
 * The part an arrow moves the pick to from `current`: the nearest that way,
 * or failing that the next in reading order (right and down) or the one
 * before (left and up), wrapping round.
 */
export function stepPick(
  current: string,
  points: readonly ConnectPoint[],
  dir: ConnectDir,
): string | null {
  if (points.length === 0) return null;
  const at = points.find((p) => p.id === current);
  if (!at) return connectOrder(points)[0]!.id;
  const near = nearestToward(at, points, dir, current);
  if (near) return near.id;
  const order = connectOrder(points);
  const i = order.findIndex((p) => p.id === current);
  const step = dir === 'right' || dir === 'down' ? 1 : -1;
  return order[(i + step + order.length) % order.length]!.id;
}
