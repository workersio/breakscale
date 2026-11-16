import type { ActiveFailure, Topology } from '../sim/types';
import { shortcutLabel } from '../modKey';
import { DEFAULT_LOSS_RATE, DEFAULT_SLOW_FACTOR, formatFactor } from './faultWiring';
import type { CableState } from './faultWiring';
import { formatPct } from './format';

/* ------------------------------------------------------------------ *
 * The canvas context menu, as data.
 *
 * Right-click on a mouse, press and hold on a touch screen, or the menu key
 * on a focused part: each asks for the same menu, and this module decides
 * what is in it. The canvas reports what was pressed (a part, a connection,
 * or empty canvas); the shell gathers the facts and runs the action. Keeping
 * the list pure means every label is pinned by a unit test without mounting
 * anything.
 * ------------------------------------------------------------------ */

export type MenuTarget =
  { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'canvas' };

/** What the canvas sends when a menu is asked for. */
export interface CanvasMenuRequest {
  target: MenuTarget;
  /** Client coords the menu opens beside. */
  x: number;
  y: number;
  /** World point under the press: where Paste here and Add here land. */
  world: { x: number; y: number };
  /** How it was asked for, which decides where the menu sits. */
  via: MenuVia;
}

export type MenuVia = 'mouse' | 'touch' | 'keyboard';

export type MenuAction =
  | 'inspect'
  | 'duplicate'
  | 'copy'
  | 'connect'
  | 'crash'
  | 'slow'
  | 'fix'
  | 'cut'
  | 'restore'
  | 'loss-add'
  | 'loss-remove'
  | 'delete'
  | 'paste'
  | 'add'
  | 'fit';

export interface ContextMenuItem {
  action: MenuAction;
  label: string;
  /** The key that does the same thing, printed on the right. */
  hint?: string;
  danger?: boolean;
  /** Shown but inert, with the reason in `label`. */
  disabled?: boolean;
  /** Items with different groups get a rule between them. */
  group: number;
}

export interface MenuFacts {
  topology: Topology;
  selectedIds: ReadonlySet<string>;
  /** The fault in force on the pressed part, or null. */
  fault: ActiveFailure | null;
  /** False for a kind with no service time, where Slow changes nothing. */
  canSlow: boolean;
  /** The pressed connection's state, for an edge menu. */
  cable: CableState | null;
  lossRate: number;
  /** Whether Paste here has anything it can paste. */
  canPaste: boolean;
  mac: boolean;
  /** Touch screens have no keys to teach, so no hints. */
  coarse: boolean;
}

/**
 * The parts a node menu acts on. A part inside a multi-selection stands for
 * the whole selection, the way a drag of one member moves them all; any
 * other part acts alone, and the selection is left as it was.
 */
export function menuScope(
  target: MenuTarget,
  selectedIds: ReadonlySet<string>,
  topology: Topology,
): string[] {
  if (target.kind !== 'node') return [];
  if (!selectedIds.has(target.id)) return [target.id];
  const ids = topology.nodes.filter((n) => selectedIds.has(n.id)).map((n) => n.id);
  return ids.length > 1 ? ids : [target.id];
}

/** The line at the top of the menu naming what it is about. */
export function menuTitle(target: MenuTarget, facts: MenuFacts): string | null {
  const byId = new Map(facts.topology.nodes.map((n) => [n.id, n] as const));
  if (target.kind === 'node') {
    const scope = menuScope(target, facts.selectedIds, facts.topology);
    if (scope.length > 1) return `${scope.length} components`;
    return byId.get(target.id)?.label ?? null;
  }
  if (target.kind === 'edge') {
    const e = facts.topology.edges.find((x) => x.id === target.id);
    if (!e) return null;
    return `${byId.get(e.from)?.label ?? e.from} to ${byId.get(e.to)?.label ?? e.to}`;
  }
  return null;
}

export function menuItems(target: MenuTarget, facts: MenuFacts): ContextMenuItem[] {
  const key = (k: string): string | undefined =>
    facts.coarse ? undefined : shortcutLabel(k, facts.mac);
  const out: ContextMenuItem[] = [];
  const push = (item: ContextMenuItem) => out.push(item);

  if (target.kind === 'node') {
    if (!facts.topology.nodes.some((n) => n.id === target.id)) return [];
    const n = menuScope(target, facts.selectedIds, facts.topology).length;
    const many = n > 1;
    push({ action: 'inspect', label: 'Inspect', group: 0 });
    push({
      action: 'duplicate',
      label: many ? `Duplicate all ${n}` : 'Duplicate',
      hint: key('Ctrl+D'),
      group: 0,
    });
    push({
      action: 'copy',
      label: many ? `Copy all ${n}` : 'Copy',
      hint: key('Ctrl+C'),
      group: 0,
    });
    if (!many) {
      push({ action: 'connect', label: 'Connect to…', hint: key('L'), group: 0 });
      // The fault controls work on one part at a time, here as in the
      // inspector.
      const f = facts.fault;
      if (f?.kind !== 'crash') push({ action: 'crash', label: 'Crash', group: 1 });
      if (f === null && facts.canSlow) {
        push({
          action: 'slow',
          label: `Slow down ${formatFactor(DEFAULT_SLOW_FACTOR)}`,
          group: 1,
        });
      }
      if (f !== null) push({ action: 'fix', label: 'Fix', group: 1 });
    }
    push({
      action: 'delete',
      label: many ? `Delete all ${n}` : 'Delete',
      danger: true,
      group: 2,
    });
    return out;
  }

  if (target.kind === 'edge') {
    if (!facts.topology.edges.some((e) => e.id === target.id)) return [];
    push({ action: 'inspect', label: 'Inspect', group: 0 });
    // A cable cut by its node's own fault is healed by fixing that node, so
    // neither Cut nor Restore is offered for it.
    if (facts.cable === 'connected')
      push({ action: 'cut', label: 'Cut connection', group: 1 });
    if (facts.cable === 'cut') {
      push({ action: 'restore', label: 'Restore connection', group: 1 });
    }
    push(
      facts.lossRate > 0
        ? { action: 'loss-remove', label: 'Remove packet loss', group: 1 }
        : {
            action: 'loss-add',
            label: `Add ${formatPct(DEFAULT_LOSS_RATE)} packet loss`,
            group: 1,
          },
    );
    push({ action: 'delete', label: 'Delete connection', danger: true, group: 2 });
    return out;
  }

  push({
    action: 'paste',
    label: 'Paste here',
    hint: key('Ctrl+V'),
    disabled: !facts.canPaste,
    group: 0,
  });
  push({ action: 'add', label: 'Add component here', group: 0 });
  if (facts.topology.nodes.length > 0) {
    push({ action: 'fit', label: 'Fit diagram', hint: key('Shift+1'), group: 1 });
  }
  return out;
}

/** Gap between the menu and the window edge, and the finger, in px. */
const EDGE = 8;
const FINGER = 28;

/**
 * Where the menu goes, given its size. A mouse or the keyboard puts its
 * corner at the point and flips it to stay on screen. A finger would cover a
 * menu opened under it, so on touch it sits above the press, below it when
 * there is no room above, and beside it when there is room for neither.
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { w: number; h: number },
  win: { w: number; h: number },
  via: MenuVia,
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const maxLeft = Math.max(EDGE, win.w - size.w - EDGE);
  const maxTop = Math.max(EDGE, win.h - size.h - EDGE);
  if (via === 'touch') {
    const above = at.y - FINGER - size.h;
    const below = at.y + FINGER;
    if (above >= EDGE || below + size.h + EDGE <= win.h) {
      return {
        left: clamp(at.x - size.w / 2, EDGE, maxLeft),
        top: above >= EDGE ? above : below,
      };
    }
    // A phone on its side has no room above or below, so beside the finger,
    // on whichever side has more room.
    const left = at.x >= win.w / 2 ? at.x - FINGER - size.w : at.x + FINGER;
    return {
      left: clamp(left, EDGE, maxLeft),
      top: clamp(at.y - size.h / 2, EDGE, maxTop),
    };
  }
  const left = at.x + size.w + EDGE <= win.w ? at.x : at.x - size.w;
  const top = at.y + size.h + EDGE <= win.h ? at.y : at.y - size.h;
  return { left: clamp(left, EDGE, maxLeft), top: clamp(top, EDGE, maxTop) };
}
