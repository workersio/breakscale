import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from 'react';
import type { SimNode } from '../sim/types';
import { cuePan, overflowOf } from './fit';
import type { FitView, ScreenBox } from './fit';
import './EdgeCues.css';

type Side = 'left' | 'right';

/** Where the cues go, and which of them are needed. */
interface CueLayout {
  left: boolean;
  right: boolean;
  /** Any box is outside the visible rect, on any side. */
  off: boolean;
  /** The visible rect's vertical middle, from the host's top. */
  mid: number;
  /** The visible rect's edges, from the host's matching edges. */
  insetLeft: number;
  insetRight: number;
  insetBottom: number;
}

function sameLayout(a: CueLayout | null, b: CueLayout | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.left === b.left &&
    a.right === b.right &&
    a.off === b.off &&
    a.mid === b.mid &&
    a.insetLeft === b.insetLeft &&
    a.insetRight === b.insetRight &&
    a.insetBottom === b.insetBottom
  );
}

/** The nodes' bounding box in client px under view `v`, or null for none. */
function screenBox(
  nodes: readonly SimNode[],
  v: FitView,
  surface: DOMRect,
  w: number,
  h: number,
): ScreenBox | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  return {
    left: surface.left + v.x + minX * v.k,
    right: surface.left + v.x + maxX * v.k,
    top: surface.top + v.y + minY * v.k,
    bottom: surface.top + v.y + maxY * v.k,
  };
}

const LABEL: Record<Side, string> = {
  left: 'Show more of the diagram on the left',
  right: 'Show more of the diagram on the right',
};

const OTHER: Record<Side, Side> = { left: 'right', right: 'left' };

/** How long after a press its cue going away still counts as the press's. */
const HANDOFF_MS = 1000;

function Chevron({ side }: { side: Side }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={side === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

interface EdgeCuesProps {
  hostRef: RefObject<HTMLElement | null>;
  /** The .stage-safe sentinel, watched so a panel or sheet moving re-measures. */
  visibleRef: RefObject<HTMLElement | null> | undefined;
  visibleRect: () => { surface: DOMRect; view: DOMRect } | null;
  view: FitView;
  nodes: readonly SimNode[];
  nodeW: number;
  nodeH: number;
  setView: Dispatch<SetStateAction<FitView>>;
  onFit: () => void;
}

/**
 * The canvas's edge cues, and the phone's fit button.
 *
 * A wide diagram on a narrow screen starts at its left end and runs off the
 * right one (see fitViewport). Where the minimap and the zoom cluster are
 * hidden, nothing said so: the student saw four boxes and had no reason to
 * think there were twenty. A cue sits on each side that still has boxes past
 * it and pans most of a screen toward them. The stylesheet hides the cues
 * wherever the minimap is shown, since that already says the same thing.
 *
 * Rendered by Canvas as siblings of .cv-surface, never inside it, and each
 * carries [data-chrome], so a press here is never a canvas gesture.
 */
export function EdgeCues({
  hostRef,
  visibleRef,
  visibleRect,
  view,
  nodes,
  nodeW,
  nodeH,
  setView,
  onFit,
}: EdgeCuesProps) {
  const [cues, setCues] = useState<CueLayout | null>(null);
  const viewRef = useRef(view);
  const nodesRef = useRef(nodes);
  useLayoutEffect(() => {
    viewRef.current = view;
    nodesRef.current = nodes;
  }, [view, nodes]);

  const measure = useCallback(() => {
    const rects = visibleRect();
    const host = hostRef.current?.getBoundingClientRect();
    let next: CueLayout | null = null;
    const box =
      rects &&
      screenBox(nodesRef.current, viewRef.current, rects.surface, nodeW, nodeH);
    if (rects && host && box) {
      const vis = rects.view;
      const over = overflowOf(box, vis);
      next = {
        left: over.left,
        right: over.right,
        off: over.any,
        mid: Math.round(vis.top - host.top + vis.height / 2),
        insetLeft: Math.round(vis.left - host.left),
        insetRight: Math.round(host.right - vis.right),
        insetBottom: Math.round(host.bottom - vis.bottom),
      };
    }
    setCues((prev) => (sameLayout(prev, next) ? prev : next));
  }, [visibleRect, hostRef, nodeW, nodeH]);

  // The camera moved or the diagram changed. Measured on the next frame,
  // which is also when a pan or a fit has been painted.
  useEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, view, nodes]);

  // A panel opening, a sheet growing or the window resizing moves the
  // visible rect without moving the camera.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    const host = hostRef.current;
    const vis = visibleRef?.current;
    if (host) ro.observe(host);
    if (vis) ro.observe(vis);
    return () => ro.disconnect();
  }, [measure, hostRef, visibleRef]);

  /* A press that brings that side's last box in also takes its cue away,
     and the focus with it, which drops a keyboard user back at the top of
     the page. The pan that spends one side always pushes boxes past the
     other, so focus moves to that side's cue; failing that, the fit button
     on a phone, then the first box, which is where the canvas's own tab
     order starts. A fit that brings everything in takes the fit button
     away the same way. */
  const buttons = useRef<Partial<Record<Side | 'fit', HTMLButtonElement | null>>>({});
  const handoff = useRef<{ from: Side | 'fit'; at: number } | null>(null);
  useLayoutEffect(() => {
    const press = handoff.current;
    if (!press) return;
    handoff.current = null;
    // Only the press's own result, never a pan made long after it.
    if (performance.now() - press.at > HANDOFF_MS) return;
    const { from } = press;
    if (from === 'fit' ? cues?.off : cues?.[from]) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const fit = buttons.current.fit;
    const target =
      (from === 'fit' ? null : buttons.current[OTHER[from]]) ??
      (fit && fit.offsetParent !== null ? fit : null) ??
      hostRef.current?.querySelector<HTMLElement>('.cv-node[tabindex="0"]');
    target?.focus();
  }, [cues, hostRef]);

  const pan = (side: Side) => {
    const rects = visibleRect();
    if (!rects) return;
    const box = screenBox(
      nodesRef.current,
      viewRef.current,
      rects.surface,
      nodeW,
      nodeH,
    );
    if (!box) return;
    const dx = cuePan(side, box, rects.view);
    if (dx === 0) return;
    handoff.current = { from: side, at: performance.now() };
    setView((v) => ({ ...v, x: v.x + dx }));
  };

  if (!cues) return null;
  const style = {
    '--cue-mid': `${cues.mid}px`,
    '--cue-left': `${cues.insetLeft}px`,
    '--cue-right': `${cues.insetRight}px`,
    '--cue-bottom': `${cues.insetBottom}px`,
  } as CSSProperties;
  return (
    <>
      {(['left', 'right'] as const).map((side) =>
        cues[side] ? (
          <button
            key={side}
            ref={(el) => {
              buttons.current[side] = el;
            }}
            type="button"
            className={`btn btn-sm btn-icon cv-cue is-${side}`}
            data-chrome="cue"
            style={style}
            aria-label={LABEL[side]}
            title={LABEL[side]}
            onClick={() => pan(side)}
          >
            <Chevron side={side} />
          </button>
        ) : null,
      )}
      {cues.off ? (
        <button
          ref={(el) => {
            buttons.current.fit = el;
          }}
          type="button"
          className="btn btn-sm btn-icon cv-cue-fit"
          data-chrome="cue"
          style={style}
          aria-label="Fit the diagram on screen"
          title="Fit the diagram on screen"
          onClick={() => {
            handoff.current = { from: 'fit', at: performance.now() };
            onFit();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
          </svg>
        </button>
      ) : null}
    </>
  );
}
