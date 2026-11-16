import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { SimNode, Topology } from '../sim/types';
import { ARROW_DIR, firstPick, stepPick } from './keyboardConnect';
import type { ConnectPoint } from './keyboardConnect';
import { revealPan } from './reveal';

interface View {
  x: number;
  y: number;
  k: number;
}

interface Options {
  hostRef: RefObject<HTMLElement | null>;
  topoRef: RefObject<Topology>;
  viewRef: RefObject<View>;
  setView: Dispatch<SetStateAction<View>>;
  visibleRect: () => { surface: DOMRect; view: DOMRect } | null;
  /** The parts as rendered, for naming the link being picked. */
  nodes: readonly SimNode[];
  selectedIds: ReadonlySet<string>;
  /** The armed click-link's source. Keyboard connect arms the same one. */
  pendingLink: string | null;
  setPendingLink: (id: string | null) => void;
  canLink: (from: string, to: string) => boolean;
  onConnect: (from: string, to: string) => void;
  /** Disarms the note and section tools, which would claim the next click. */
  clearTool: () => void;
  isTypingTarget: (t: EventTarget | null) => boolean;
  nodeW: number;
  nodeH: number;
  /** Filled with a way to start from a part without the L key (the menu). */
  beginRef?: MutableRefObject<((id: string) => void) | null>;
}

/** The link being picked: its source, and the part it would go to. */
export interface KeyboardLink {
  from: SimNode;
  to: SimNode | null;
}

function focusNode(host: HTMLElement | null, id: string): void {
  if (!host) return;
  for (const el of host.querySelectorAll<SVGGElement>('.cv-node')) {
    if (el.dataset.id === id) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * L with one part selected starts a link from it; the arrows pick the part
 * it goes to, Enter makes it through `onConnect` (the path a port drag
 * takes, so it is one undo step and the same checks), and Escape stops.
 *
 * It arms the canvas's click-link, so the picked part is drawn as the drop
 * target of a drag would be, and a click finishes or drops it the way it
 * always has. Anything that disarms that link ends this too.
 */
export function useKeyboardConnect({
  hostRef,
  topoRef,
  viewRef,
  setView,
  visibleRect,
  nodes,
  selectedIds,
  pendingLink,
  setPendingLink,
  canLink,
  onConnect,
  clearTool,
  isTypingTarget,
  nodeW,
  nodeH,
  beginRef,
}: Options): KeyboardLink | null {
  const [pick, setPick] = useState<{ from: string; to: string | null } | null>(null);
  const armed = pick !== null && pendingLink === pick.from ? pick : null;

  const points = useCallback(
    (from: string): ConnectPoint[] => {
      const out: ConnectPoint[] = [];
      for (const n of topoRef.current.nodes) {
        if (!canLink(from, n.id)) continue;
        out.push({ id: n.id, x: n.x + nodeW / 2, y: n.y + nodeH / 2 });
      }
      return out;
    },
    [topoRef, canLink, nodeW, nodeH],
  );

  /** Pan the least distance that brings the picked part into view. */
  const show = useCallback(
    (id: string) => {
      const n = topoRef.current.nodes.find((x) => x.id === id);
      const rects = visibleRect();
      if (!n || !rects) return;
      const v = viewRef.current;
      const { surface, view: room } = rects;
      const { dx, dy } = revealPan(
        {
          left: surface.left + n.x * v.k + v.x,
          top: surface.top + n.y * v.k + v.y,
          right: surface.left + (n.x + nodeW) * v.k + v.x,
          bottom: surface.top + (n.y + nodeH) * v.k + v.y,
        },
        room,
      );
      if (dx !== 0 || dy !== 0)
        setView((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
      focusNode(hostRef.current, id);
    },
    [topoRef, visibleRect, viewRef, setView, hostRef, nodeW, nodeH],
  );

  const begin = useCallback(
    (id: string) => {
      const from = topoRef.current.nodes.find((n) => n.id === id);
      if (!from) return;
      const to = firstPick(
        { x: from.x + nodeW / 2, y: from.y + nodeH / 2 },
        points(from.id),
      );
      clearTool();
      setPendingLink(from.id);
      setPick({ from: from.id, to });
      if (to) show(to);
    },
    [topoRef, points, show, clearTool, setPendingLink, nodeW, nodeH],
  );

  useEffect(() => {
    if (!beginRef) return;
    beginRef.current = begin;
    return () => {
      beginRef.current = null;
    };
  }, [beginRef, begin]);

  // L starts it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      const sel = topoRef.current.nodes.filter((n) => selectedIds.has(n.id));
      if (sel.length !== 1) return;
      e.preventDefault();
      begin(sel[0]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, topoRef, begin, isTypingTarget]);

  // While armed, the arrows, Enter and Escape are this mode's. Taken in the
  // capture phase, before a focused part's own keys (which nudge it) and
  // the canvas's (whose Escape also clears the selection).
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const dir = ARROW_DIR[e.key];
      if (dir) {
        e.preventDefault();
        e.stopPropagation();
        const next = stepPick(armed.to ?? armed.from, points(armed.from), dir);
        if (next && next !== armed.to) {
          setPick({ from: armed.from, to: next });
          show(next);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Enter' && armed.to && canLink(armed.from, armed.to)) {
          onConnect(armed.from, armed.to);
        }
        setPendingLink(null);
        setPick(null);
        focusNode(hostRef.current, armed.from);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    armed,
    points,
    show,
    canLink,
    onConnect,
    setPendingLink,
    hostRef,
    isTypingTarget,
  ]);

  if (!armed) return null;
  const from = nodes.find((n) => n.id === armed.from);
  if (!from) return null;
  const to = armed.to ? (nodes.find((n) => n.id === armed.to) ?? null) : null;
  return { from, to };
}
