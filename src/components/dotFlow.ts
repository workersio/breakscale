/**
 * Traffic dots: the pure half. Geometry, the dot rate, and the mix of
 * outcomes, with no React and no DOM so node tests can load it.
 *
 * WHAT A DOT MEANS. A busier wire carries more dots (see dotRate), so wires
 * can be ranked by eye; the exact rate is the wire's label. Dots move at one fixed on-screen speed; speed says
 * nothing about latency, because drawing latency as speed would invent a
 * picture the engine never measured. Colour and the way a dot ends its trip
 * are the measured part: they come from the engine's per-edge outcome tally.
 */

import {
  EO_CUT,
  EO_FAILED,
  EO_FIRST,
  EO_LOST,
  EO_OK,
  EO_REFUSED,
  EO_RETRY,
} from '../sim/edgeOutcomes';
import type { Pt } from './edgeRoute';

/** How a dot ends its trip. Indexes the colour classes and the mix. */
export const DOT_OK = 0;
export const DOT_FAILED = 1;
export const DOT_REFUSED = 2;
export const DOT_LOST = 3;
export const DOT_CUT = 4;
/** Sent, and nothing has come back yet. */
export const DOT_PENDING = 5;
export const DOT_KINDS = 6;

/** On-screen travel speed, px per second. The same on every wire. */
export const DOT_SPEED_PX = 110;

/**
 * Each ending's share of the calls sent across one edge, written into `mix`,
 * plus the share of sends that were retries. Returns the send rate.
 *
 * Shares are of whichever is larger, sends or endings. Both are rates over
 * the same trailing window, so in steady state they match; while a line is
 * growing more is sent than comes back, and that gap is shown as calls with
 * no answer yet rather than spread over the outcomes that did arrive.
 */
export function outcomeMix(
  r: ArrayLike<number>,
  mix: Float64Array,
): { sent: number; retryShare: number } {
  const sent = r[EO_FIRST] + r[EO_RETRY];
  const ended = r[EO_OK] + r[EO_FAILED] + r[EO_REFUSED] + r[EO_LOST] + r[EO_CUT];
  const denom = Math.max(sent, ended);
  if (denom <= 0) {
    mix.fill(0);
    return { sent: 0, retryShare: 0 };
  }
  mix[DOT_OK] = r[EO_OK] / denom;
  mix[DOT_FAILED] = r[EO_FAILED] / denom;
  mix[DOT_REFUSED] = r[EO_REFUSED] / denom;
  mix[DOT_LOST] = r[EO_LOST] / denom;
  mix[DOT_CUT] = r[EO_CUT] / denom;
  mix[DOT_PENDING] = Math.max(0, sent - ended) / denom;
  return { sent, retryShare: sent > 0 ? r[EO_RETRY] / sent : 0 };
}

/**
 * Pick the next dot's ending so the running mix matches `mix` exactly.
 *
 * Largest remainder, not a random draw: every kind accrues its share per
 * dot, the furthest-behind kind is emitted and pays one back. Over any run of
 * dots each kind's count is within one of its share, so a 3 percent failure
 * rate reads as 3 dots in 100, steadily, instead of a flickering guess. `acc`
 * is the caller's per-edge state and `mix` the edge's shares, both DOT_KINDS
 * long starting at `at`, so a caller holding every edge in one array passes it
 * whole instead of slicing a view per dot.
 */
export function pickOutcome(acc: Float64Array, at: number, mix: Float64Array): number {
  let best = 0;
  let bestV = -Infinity;
  for (let k = 0; k < DOT_KINDS; k++) {
    const v = acc[at + k] + mix[at + k];
    acc[at + k] = v;
    if (v > bestV) {
      bestV = v;
      best = k;
    }
  }
  acc[at + best] -= 1;
  return best;
}

/**
 * Dots per second on a wire carrying `sent` requests per second.
 *
 * Logarithmic, the same family as the wire's stroke width: every doubling of
 * the rate adds one more dot a second. A linear scale was tried first, with
 * one requests-per-dot figure shared by every wire, and it could not show a
 * real diagram: on the Netflix example the busiest wire carries 2,000 a
 * second, which set the scale to 200 per dot and left every wire under 100 a
 * second with no dot at all. Here a busier wire always carries more dots, a
 * quiet one still shows how its calls end, and the exact rate stays in the
 * wire's label.
 */
export function dotRate(sent: number): number {
  return sent > 0 ? DOTS_PER_DOUBLING * Math.log2(1 + sent) : 0;
}

/** At 5,000 a second this is 15.4 dots a second, about 7px apart. */
export const DOTS_PER_DOUBLING = 1.25;

/** A wire flattened for travel: points, and the distance to each. */
export interface Track {
  /** x0, y0, x1, y1, ... in world px. */
  readonly xy: Float32Array;
  /** Distance along the wire to each point; the last is the length. */
  readonly cum: Float32Array;
  readonly length: number;
  /** World bounding box, for skipping wires off screen. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Segments per rounded corner. Four keeps a 12px fillet within 0.1px. */
const ARC_STEPS = 4;

/**
 * Flatten the router's polyline with the same fillets roundedPath draws, so a
 * dot rides the visible curve instead of cutting the corner beside it.
 */
export function flattenRoute(points: readonly Pt[], radius: number): Track {
  const p: Pt[] = [];
  for (const q of points) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 0.01 || Math.abs(last.y - q.y) > 0.01) {
      p.push(q);
    }
  }
  const out: number[] = [];
  if (p.length > 0) out.push(p[0].x, p[0].y);
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const c = p[i];
    const b = p[i + 1];
    const l1 = Math.hypot(c.x - a.x, c.y - a.y);
    const l2 = Math.hypot(b.x - c.x, b.y - c.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const u1x = (c.x - a.x) / l1;
    const u1y = (c.y - a.y) / l1;
    const u2x = (b.x - c.x) / l2;
    const u2y = (b.y - c.y) / l2;
    // The same fallbacks roundedPath takes: no arc for a tiny radius or for
    // legs that do not turn.
    if (r < 0.5 || Math.abs(u1x * u2y - u1y * u2x) < 0.5) {
      out.push(c.x, c.y);
      continue;
    }
    // Quarter circle from c - u1*r to c + u2*r about o = c - u1*r + u2*r.
    const ox = c.x - u1x * r + u2x * r;
    const oy = c.y - u1y * r + u2y * r;
    for (let s = 0; s <= ARC_STEPS; s++) {
      const th = (s / ARC_STEPS) * (Math.PI / 2);
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      out.push(ox - u2x * r * cs + u1x * r * sn, oy - u2y * r * cs + u1y * r * sn);
    }
  }
  if (p.length > 1) out.push(p[p.length - 1].x, p[p.length - 1].y);

  const n = out.length / 2;
  const xy = new Float32Array(out);
  const cum = new Float32Array(Math.max(1, n));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = out[i * 2];
    const y = out[i * 2 + 1];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(x - out[i * 2 - 2], y - out[i * 2 - 1]);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { xy, cum, length: n > 0 ? cum[n - 1] : 0, minX, minY, maxX, maxY };
}

/** Write the point `s` world px along `t` into `out`. Clamped to the ends. */
export function pointAt(t: Track, s: number, out: { x: number; y: number }): void {
  const { xy, cum } = t;
  const n = cum.length;
  if (n < 2 || s <= 0) {
    out.x = xy[0] ?? 0;
    out.y = xy[1] ?? 0;
    return;
  }
  for (let i = 1; i < n; i++) {
    if (cum[i] >= s) {
      const seg = cum[i] - cum[i - 1];
      const f = seg > 0 ? (s - cum[i - 1]) / seg : 0;
      out.x = xy[i * 2 - 2] + (xy[i * 2] - xy[i * 2 - 2]) * f;
      out.y = xy[i * 2 - 1] + (xy[i * 2 + 1] - xy[i * 2 - 1]) * f;
      return;
    }
  }
  out.x = xy[n * 2 - 2];
  out.y = xy[n * 2 - 1];
}

/** Distance along `t` of the point on it nearest `p`. */
export function distanceAlong(t: Track, p: Pt): number {
  const { xy, cum } = t;
  let best = 0;
  let bestD = Infinity;
  for (let i = 1; i < cum.length; i++) {
    const ax = xy[i * 2 - 2];
    const ay = xy[i * 2 - 1];
    const dx = xy[i * 2] - ax;
    const dy = xy[i * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    const f =
      len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2))
        : 0;
    const qx = ax + dx * f - p.x;
    const qy = ay + dy * f - p.y;
    const d = qx * qx + qy * qy;
    if (d < bestD) {
      bestD = d;
      best = cum[i - 1] + (cum[i] - cum[i - 1]) * f;
    }
  }
  return best;
}
