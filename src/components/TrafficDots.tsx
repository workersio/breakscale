import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EDGE_OUTCOME_SLOTS } from '../sim/edgeOutcomes';
import { EDGE_RADIUS, type Pt } from './edgeRoute';
import {
  DOT_CUT,
  DOT_FAILED,
  DOT_KINDS,
  DOT_LOST,
  DOT_PENDING,
  DOT_REFUSED,
  DOT_SPEED_PX,
  distanceAlong,
  dotRate,
  flattenRoute,
  outcomeMix,
  pickOutcome,
  pointAt,
  type Track,
} from './dotFlow';

/* ==========================================================================
   Traffic dots: requests drawn moving along the wires.

   Drawn INSIDE the diagram's svg, between the wires and the nodes, so a dot
   is never painted over a card or a note and pans with the diagram for free.
   The rAF loop below writes seven `d` attributes per frame, one per colour
   and one for the retry rings, and nothing else; React renders this
   component at the snapshot rate, never per frame. All per-dot state lives
   in typed arrays allocated once.

   A dot wears its ending from the moment it leaves. Holding it neutral until
   near the end was tried, and on a wire turning most calls away half its dots
   then read as getting through.

   With reduced motion there is no loop at all. Each wire gets a still bar
   at its label point instead, split by the same shares the dots are drawn
   from, which reads the same facts without anything moving.
   ========================================================================== */

/** One request path the dots can travel. Control edges are never passed. */
export interface DotWire {
  id: string;
  /** The router's polyline, before fillets. */
  points: readonly Pt[];
  /** Where the label and break mark sit; a cut stops dots just short of it. */
  label: Pt;
}

interface ViewLike {
  x: number;
  y: number;
  k: number;
}

export interface TrafficDotsProps {
  wires: readonly DotWire[];
  /** Copies one edge's outcome rates; Engine.readEdgeOutcomes. */
  read: (edgeId: string, out: Float64Array) => boolean;
  /** Simulated time of the latest snapshot. A change means fresh rates. */
  clock: number;
  view: ViewLike;
  mode: 'moving' | 'still';
}

const MAX_DOTS = 900;
/** Dot radius in screen px; a pending dot is smaller as well as lighter. */
const R_PX = 2.5;
const R_PENDING_PX = 1.7;
/** A retry wears a ring this far out around its dot. */
const RING_PX = 4.2;
/** A refused dot bounces this far back off the target before it goes. */
const BOUNCE_PX = 14;
/** A lost dot shrinks away over this distance past the middle. */
const LOST_FADE_PX = 30;
/** How long a failed dot sits at the arrowhead before it goes. */
const FAIL_HOLD_S = 0.35;
/** How long a dot stopped by a cut stays piled at the break. */
const CUT_HOLD_S = 0.9;
/** How deep the pile at a cut gets, and the spacing within it. */
const CUT_STACK = 5;
const CUT_GAP_PX = 5;
/** No fresh snapshot for this long means the run is paused: freeze. */
const PAUSE_AFTER_MS = 400;
/** Colour classes, one fill path each. Retries add a ring on top. */
const COLOURS = ['ok', 'fail', 'refused', 'lost', 'pending', 'retry'] as const;
const C_OK = 0;
const C_FAIL = 1;
const C_REFUSED = 2;
const C_LOST = 3;
const C_PENDING = 4;
const C_RETRY = 5;

interface Lane {
  id: string;
  track: Track;
  label: Pt;
  /** Distance along the wire of the break mark. */
  cutS: number;
  /** Dots per second to emit, and the fraction of one already due. */
  emit: number;
  acc: number;
  retryShare: number;
  retryAcc: number;
  cutStack: number;
  visible: boolean;
}

interface LoopState {
  lanes: Lane[];
  /** DOT_KINDS per lane: the measured mix, and the largest-remainder state. */
  mix: Float64Array;
  mixAcc: Float64Array;
  s: Float32Array;
  stop: Float32Array;
  hold: Float32Array;
  kind: Uint8Array;
  ring: Uint8Array;
  lane: Uint16Array;
  count: number;
  view: ViewLike;
  width: number;
  height: number;
  clock: number;
  clockWall: number;
  drawnK: number;
  dirty: boolean;
}

function makeLoop(): LoopState {
  return {
    lanes: [],
    mix: new Float64Array(0),
    mixAcc: new Float64Array(0),
    s: new Float32Array(MAX_DOTS),
    stop: new Float32Array(MAX_DOTS),
    hold: new Float32Array(MAX_DOTS),
    kind: new Uint8Array(MAX_DOTS),
    ring: new Uint8Array(MAX_DOTS),
    lane: new Uint16Array(MAX_DOTS),
    count: 0,
    view: { x: 0, y: 0, k: 1 },
    width: 0,
    height: 0,
    clock: -1,
    clockWall: 0,
    drawnK: 0,
    dirty: true,
  };
}

/** Add one dot `s` world px along lane `li`. False when the pool is full. */
function spawn(L: LoopState, li: number, s: number, k: number): boolean {
  if (L.count >= MAX_DOTS) return false;
  const lane = L.lanes[li];
  const kind = pickOutcome(L.mixAcc, li * DOT_KINDS, L.mix);
  lane.retryAcc += lane.retryShare;
  let ring = 0;
  if (lane.retryAcc >= 1) {
    lane.retryAcc -= 1;
    ring = 1;
  }
  let stop = 0;
  if (kind === DOT_CUT) {
    // Each dot stopped by the cut queues behind the last, a few deep, so
    // the pile reads as calls backing up against the break.
    stop = Math.max(0, lane.cutS - 9 - (lane.cutStack % CUT_STACK) * (CUT_GAP_PX / k));
    lane.cutStack++;
  }
  const i = L.count++;
  L.s[i] = s;
  L.stop[i] = stop;
  L.hold[i] = 0;
  L.kind[i] = kind;
  L.ring[i] = ring;
  L.lane[i] = li;
  return true;
}

/** Fill a lane that just became visible or busy, so it does not start empty. */
function seed(L: LoopState, li: number, k: number): void {
  const lane = L.lanes[li];
  if (lane.emit <= 0) return;
  const gap = DOT_SPEED_PX / k / lane.emit;
  // Phase from the lane's own fractional emission, so seeding does not put
  // a dot exactly at the source every time.
  for (let s = lane.acc * gap; s < lane.track.length; s += gap) {
    if (!spawn(L, li, s, k)) return;
  }
}

function inView(L: LoopState, t: Track): boolean {
  const { x, y, k } = L.view;
  if (L.width <= 0 || L.height <= 0) return true;
  const m = 24 / k;
  const left = -x / k - m;
  const top = -y / k - m;
  const right = (L.width - x) / k + m;
  const bottom = (L.height - y) / k + m;
  return t.maxX >= left && t.minX <= right && t.maxY >= top && t.minY <= bottom;
}

/** Advance every dot by `dt` seconds and retire the ones that are done. */
function step(L: LoopState, dt: number, k: number): void {
  const v = DOT_SPEED_PX / k;
  for (let li = 0; li < L.lanes.length; li++) {
    const lane = L.lanes[li];
    const visible = inView(L, lane.track);
    if (visible && !lane.visible) seed(L, li, k);
    lane.visible = visible;
    if (!visible || lane.emit <= 0) continue;
    lane.acc += lane.emit * dt;
    while (lane.acc >= 1) {
      lane.acc -= 1;
      // Placed where it would be had it left exactly on time, so a long
      // frame does not bunch dots at the source.
      if (!spawn(L, li, (lane.acc / lane.emit) * v, k)) break;
    }
  }

  let i = 0;
  while (i < L.count) {
    const len = L.lanes[L.lane[i]].track.length;
    const kind = L.kind[i];
    let s = L.s[i] + v * dt;
    let dead = false;
    if (kind === DOT_FAILED || kind === DOT_CUT) {
      const end = kind === DOT_FAILED ? len : L.stop[i];
      if (s >= end) {
        s = end;
        L.hold[i] = L.hold[i] + dt;
        dead = L.hold[i] > (kind === DOT_FAILED ? FAIL_HOLD_S : CUT_HOLD_S);
      }
    } else if (kind === DOT_REFUSED) {
      dead = s >= len + BOUNCE_PX / k;
    } else if (kind === DOT_LOST) {
      dead = s >= len * 0.5 + LOST_FADE_PX / k;
    } else {
      dead = s >= len;
    }
    if (dead) {
      // Swap the last dot into this slot; do not advance i.
      const last = --L.count;
      L.s[i] = L.s[last];
      L.stop[i] = L.stop[last];
      L.hold[i] = L.hold[last];
      L.kind[i] = L.kind[last];
      L.ring[i] = L.ring[last];
      L.lane[i] = L.lane[last];
      continue;
    }
    L.s[i] = s;
    i++;
  }
}

const q = (n: number): number => Math.round(n * 10) / 10;

function circle(x: number, y: number, r: number): string {
  const d = q(r * 2);
  const rs = q(r);
  return `M${q(x - r)},${q(y)}a${rs},${rs} 0 1,0 ${d},0a${rs},${rs} 0 1,0 ${-d},0`;
}

const pt = { x: 0, y: 0 };
const fills: string[] = ['', '', '', '', '', ''];

function draw(L: LoopState, k: number, paths: (SVGPathElement | null)[]): void {
  for (let c = 0; c < COLOURS.length; c++) fills[c] = '';
  let rings = '';
  for (let i = 0; i < L.count; i++) {
    const lane = L.lanes[L.lane[i]];
    if (!lane.visible) continue;
    const len = lane.track.length;
    const kind = L.kind[i];
    let s = L.s[i];
    let scale = 1;
    let colour = C_OK;
    if (kind === DOT_REFUSED) {
      colour = C_REFUSED;
      if (s > len) {
        scale = 1 - (s - len) / (BOUNCE_PX / k);
        s = 2 * len - s;
      }
    } else if (kind === DOT_LOST) {
      colour = C_LOST;
      const where = len * 0.5;
      if (s > where) scale = 1 - (s - where) / (LOST_FADE_PX / k);
    } else if (kind === DOT_FAILED) {
      colour = C_FAIL;
    } else if (kind === DOT_CUT) {
      colour = C_FAIL;
    } else if (kind === DOT_PENDING) {
      colour = C_PENDING;
    }
    pointAt(lane.track, s, pt);
    const shrink = Math.max(0.15, scale);
    const r = ((kind === DOT_PENDING ? R_PENDING_PX : R_PX) / k) * shrink;
    fills[colour] += circle(pt.x, pt.y, r);
    if (L.ring[i] === 1) rings += circle(pt.x, pt.y, (RING_PX / k) * shrink);
  }
  for (let c = 0; c < COLOURS.length; c++) paths[c]?.setAttribute('d', fills[c]);
  paths[COLOURS.length]?.setAttribute('d', rings);
  L.drawnK = k;
  L.dirty = false;
}

/** Bar length in world px; the segments split it by share. */
const BAR_W = 28;

function rect(x: number, y: number, w: number, h: number): string {
  return `M${q(x)},${q(y)}h${q(w)}v${h}h${q(-w)}z`;
}

/**
 * The reduced-motion reading: a still bar under each wire's label point,
 * split by how its calls ended, with a thin second line for the share that
 * were retries. Written straight into the paths, like the dots.
 */
function drawBars(L: LoopState, paths: (SVGPathElement | null)[]): void {
  let back = '';
  for (let c = 0; c < COLOURS.length; c++) fills[c] = '';
  for (let li = 0; li < L.lanes.length; li++) {
    const lane = L.lanes[li];
    if (lane.emit <= 0) continue;
    const at = li * DOT_KINDS;
    let total = 0;
    for (let k = 0; k < DOT_KINDS; k++) total += L.mix[at + k];
    if (total <= 0) continue;
    const x0 = lane.label.x - BAR_W / 2;
    const y = lane.label.y + 5;
    const hasRetry = lane.retryShare * BAR_W > 0.5;
    back += rect(x0 - 1, y - 1, BAR_W + 2, hasRetry ? 9 : 6);
    let x = x0;
    for (let k = 0; k < DOT_KINDS; k++) {
      const w = (L.mix[at + k] / total) * BAR_W;
      if (w <= 0.25) {
        x += w;
        continue;
      }
      const colour = BAR_COLOUR[k];
      fills[colour] += rect(x, y, w, 4);
      x += w;
    }
    if (hasRetry)
      fills[C_RETRY] += rect(x0, y + 5, Math.min(BAR_W, lane.retryShare * BAR_W), 2);
  }
  paths[0]?.setAttribute('d', back);
  for (let c = 0; c < COLOURS.length; c++) paths[1 + c]?.setAttribute('d', fills[c]);
}

/** Colour class for each ending, in DOT_* order. A cut call failed. */
const BAR_COLOUR = [C_OK, C_FAIL, C_REFUSED, C_LOST, C_FAIL, C_PENDING];

export const TrafficDots = memo(function TrafficDots({
  wires,
  read,
  clock,
  view,
  mode,
}: TrafficDotsProps) {
  // Mutable loop state, created once and only touched from effects.
  const loopRef = useRef<LoopState | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);
  const pathsRef = useRef<(SVGPathElement | null)[]>([]);
  const ratesRef = useRef<Float64Array | null>(null);

  // The loop reads the camera from here; React owns the prop.
  useLayoutEffect(() => {
    const loop = (loopRef.current ??= makeLoop());
    if (loop.view.k !== view.k) loop.dirty = true;
    loop.view = view;
  }, [view]);

  // Wires changed (an edit, a drag, a preset): rebuild the lanes and keep
  // the dots of every wire that is still there.
  useLayoutEffect(() => {
    const loop = (loopRef.current ??= makeLoop());
    const old = loop.lanes;
    const oldById = new Map<string, number>();
    old.forEach((l, i) => oldById.set(l.id, i));
    const byId = new Map<string, number>();
    const mix = new Float64Array(wires.length * DOT_KINDS);
    const mixAcc = new Float64Array(wires.length * DOT_KINDS);
    const lanes: Lane[] = wires.map((w, i) => {
      byId.set(w.id, i);
      const track = flattenRoute(w.points, EDGE_RADIUS);
      const oi = oldById.get(w.id);
      const prev = oi === undefined ? undefined : old[oi];
      if (oi !== undefined) {
        const from = oi * DOT_KINDS;
        mix.set(loop.mix.subarray(from, from + DOT_KINDS), i * DOT_KINDS);
        mixAcc.set(loop.mixAcc.subarray(from, from + DOT_KINDS), i * DOT_KINDS);
      }
      return {
        id: w.id,
        track,
        label: w.label,
        cutS: distanceAlong(track, w.label),
        emit: prev?.emit ?? 0,
        acc: prev?.acc ?? 0.5,
        retryShare: prev?.retryShare ?? 0,
        retryAcc: prev?.retryAcc ?? 0.5,
        cutStack: 0,
        visible: prev?.visible ?? false,
      };
    });
    let n = 0;
    for (let i = 0; i < loop.count; i++) {
      const ni = byId.get(old[loop.lane[i]]?.id ?? '');
      if (ni === undefined) continue;
      loop.s[n] = loop.s[i];
      loop.stop[n] = loop.stop[i];
      loop.hold[n] = loop.hold[i];
      loop.kind[n] = loop.kind[i];
      loop.ring[n] = loop.ring[i];
      loop.lane[n] = ni;
      n++;
    }
    loop.count = n;
    loop.lanes = lanes;
    loop.mix = mix;
    loop.mixAcc = mixAcc;
    loop.dirty = true;
  }, [wires]);

  // Fresh rates, at the snapshot rate. This is the only place the engine is
  // read, and it is read through the caller's buffer-filling accessor.
  useEffect(() => {
    const loop = (loopRef.current ??= makeLoop());
    const rates = (ratesRef.current ??= new Float64Array(EDGE_OUTCOME_SLOTS));
    if (clock !== loop.clock) {
      loop.clock = clock;
      loop.clockWall = performance.now();
    }
    const svg = groupRef.current?.ownerSVGElement;
    if (svg) {
      loop.width = svg.clientWidth;
      loop.height = svg.clientHeight;
    }
    const k = loop.view.k;
    loop.lanes.forEach((lane, li) => {
      const mix = loop.mix.subarray(li * DOT_KINDS, li * DOT_KINDS + DOT_KINDS);
      if (!read(lane.id, rates)) {
        mix.fill(0);
        lane.retryShare = 0;
        lane.emit = 0;
        return;
      }
      const m = outcomeMix(rates, mix);
      lane.retryShare = m.retryShare;
      const emit = dotRate(m.sent);
      const wasIdle = lane.emit <= 0;
      lane.emit = emit;
      if (mode === 'moving' && wasIdle && emit > 0 && lane.visible) seed(loop, li, k);
    });
    if (mode === 'still') drawBars(loop, pathsRef.current);
  }, [clock, read, mode, wires]);

  // The frame loop, only while dots are moving. It stops by itself with the
  // tab hidden, because the browser stops calling rAF.
  useEffect(() => {
    if (mode !== 'moving') return;
    const loop = (loopRef.current ??= makeLoop());
    let raf = 0;
    let last = performance.now();
    const paths = pathsRef.current;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const k = loop.view.k;
      const paused = now - loop.clockWall > PAUSE_AFTER_MS;
      if (!paused) step(loop, dt, k);
      if (!paused || loop.dirty || k !== loop.drawnK) draw(loop, k, paths);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      loop.count = 0;
      for (const l of loop.lanes) l.visible = false;
      for (const p of paths) p?.setAttribute('d', '');
    };
  }, [mode]);

  const setPath = (i: number) => (el: SVGPathElement | null) => {
    pathsRef.current[i] = el;
  };

  if (mode === 'still') {
    return (
      <g ref={groupRef} className="cv-dots-still" aria-hidden="true">
        <path ref={setPath(0)} className="cv-dots-bar-back" />
        {COLOURS.map((c, i) => (
          <path key={c} ref={setPath(1 + i)} className={`cv-dots-bar is-${c}`} />
        ))}
      </g>
    );
  }

  return (
    <g ref={groupRef} className="cv-dots" aria-hidden="true">
      {COLOURS.map((c, i) => (
        <path key={`f-${c}`} ref={setPath(i)} className={`cv-dot is-${c}`} />
      ))}
      <path
        ref={setPath(COLOURS.length)}
        className="cv-dot-ring is-retry"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  );
});

/* ==========================================================================
   The key. What each colour means, and how many requests one dot stands for.
   ========================================================================== */

interface KeyRow {
  colour: (typeof COLOURS)[number];
  ring?: boolean;
  small?: boolean;
  text: string;
}

const KEY_ROWS: KeyRow[] = [
  { colour: 'ok', text: 'Got through' },
  { colour: 'fail', text: 'Failed' },
  { colour: 'retry', ring: true, text: 'Tried again' },
  { colour: 'lost', text: 'Lost on the wire' },
  { colour: 'refused', text: 'Turned away at the door' },
  { colour: 'pending', small: true, text: 'No answer yet' },
];

export interface TrafficKeyProps {
  mode: 'moving' | 'still';
}

const KEY_STORE = 'breakscale.trafficKey.open';

/**
 * Folded the first time, on every screen: open, it sat over the end of the
 * example's note, which is the lesson a first-time reader came for. After
 * that, however the reader last left it.
 */
function startsOpen(): boolean {
  try {
    return localStorage.getItem(KEY_STORE) === '1';
  } catch {
    // Storage blocked: start folded.
    return false;
  }
}

export function TrafficKey({ mode }: TrafficKeyProps) {
  const [open, setOpen] = useState(startsOpen);
  return (
    <div className={`cv-key${open ? ' is-open' : ''}`} data-chrome="traffic-key">
      <button
        type="button"
        className="btn btn-sm cv-key-toggle"
        aria-expanded={open}
        aria-controls="cv-key-body"
        onClick={() => {
          const next = !open;
          setOpen(next);
          try {
            localStorage.setItem(KEY_STORE, next ? '1' : '0');
          } catch {
            // Not remembered this time; the key still opens and closes.
          }
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle className="cv-key-dot is-ok" cx="3" cy="6" r="2.5" />
          <circle className="cv-key-dot is-fail" cx="9" cy="6" r="2.5" />
        </svg>
        <span>{open ? 'Hide key' : 'Key'}</span>
      </button>
      {open && (
        <div id="cv-key-body" className="cv-key-body">
          <ul className="cv-key-rows">
            {KEY_ROWS.map((row) => (
              <li key={row.text} className="cv-key-row">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  {mode === 'still' ? (
                    <rect
                      className={`cv-dots-bar is-${row.colour}`}
                      x="1"
                      y={row.ring ? 7 : 4}
                      width="10"
                      height={row.ring ? 2 : 4}
                    />
                  ) : row.ring ? (
                    // A ring round a dot, as on the wire: the ring is the
                    // retry, the dot inside still wears its ending.
                    <>
                      <circle className="cv-key-ring is-retry" cx="6" cy="6" r="4.4" />
                      <circle className="cv-key-dot is-ok" cx="6" cy="6" r="2" />
                    </>
                  ) : (
                    <circle
                      className={`cv-key-dot is-${row.colour}`}
                      cx="6"
                      cy="6"
                      r={row.small ? 2 : 3.4}
                    />
                  )}
                </svg>
                {row.text}
              </li>
            ))}
          </ul>
          <p className="cv-key-scale">
            {mode === 'still'
              ? 'Each bar shows how calls on that connection ended.'
              : 'Busier connections carry more dots. Zoom in for the exact rate.'}
          </p>
        </div>
      )}
    </div>
  );
}
