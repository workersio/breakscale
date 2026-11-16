import { useCallback, useMemo } from 'react';
import type { SimSnapshot, Topology } from '../sim/types';
import { isMac } from '../modKey';
import { ContextMenu } from './ContextMenu';
import { menuItems, menuScope, menuTitle } from './contextMenuItems';
import type { CanvasMenuRequest, MenuAction, MenuFacts } from './contextMenuItems';
import { DEFAULT_LOSS_RATE, DEFAULT_SLOW_FACTOR, faultViewFor } from './faultWiring';
import type { FaultActions, FaultEngine } from './faultWiring';
import { slowable } from './Inspector';

/**
 * What the menu's rows do, each through the path the same action takes
 * elsewhere (the inspector, a key, the rail), so a row is never a second
 * implementation with its own undo story.
 */
export interface CanvasMenuActions {
  /** Select what the menu is about, when it is not already, and show it. */
  inspect: (ids: readonly string[]) => void;
  duplicate: (ids: readonly string[]) => void;
  copy: (ids: readonly string[]) => void;
  connect: (id: string, keyboard: boolean) => void;
  remove: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
  setLoss: (edgeId: string, rate: number) => void;
  paste: (at: { x: number; y: number }) => void;
  add: (at: { x: number; y: number }) => void;
  fit: () => void;
}

export interface CanvasMenuProps {
  request: CanvasMenuRequest;
  topology: Topology;
  snapshot: SimSnapshot | null;
  selectedIds: ReadonlySet<string>;
  engine: FaultEngine;
  faults: FaultActions;
  canPaste: boolean;
  coarse: boolean;
  actions: CanvasMenuActions;
  onClose: () => void;
}

export function CanvasMenu({
  request,
  topology,
  snapshot,
  selectedIds,
  engine,
  faults,
  canPaste,
  coarse,
  actions,
  onClose,
}: CanvasMenuProps) {
  const { target } = request;

  const facts = useMemo<MenuFacts>(() => {
    const node =
      target.kind === 'node'
        ? (topology.nodes.find((n) => n.id === target.id) ?? null)
        : null;
    const view = faultViewFor(engine, topology, snapshot, {
      node,
      nodeCount: node ? 1 : 0,
      edgeCount: target.kind === 'edge' ? 1 : 0,
      ids: new Set(target.kind === 'canvas' ? [] : [target.id]),
    });
    return {
      topology,
      selectedIds,
      fault: view.fault,
      canSlow: node ? slowable(node.kind) : false,
      cable: view.edge?.state ?? null,
      lossRate: view.edge?.lossRate ?? 0,
      canPaste,
      mac: isMac(),
      coarse,
    };
  }, [target, topology, snapshot, selectedIds, engine, canPaste, coarse]);

  const items = useMemo(() => menuItems(target, facts), [target, facts]);
  const title = useMemo(() => menuTitle(target, facts), [target, facts]);

  const run = useCallback(
    (action: MenuAction) => {
      if (target.kind === 'canvas') {
        if (action === 'paste') actions.paste(request.world);
        else if (action === 'add') actions.add(request.world);
        else if (action === 'fit') actions.fit();
        return;
      }
      if (target.kind === 'edge') {
        const id = target.id;
        if (action === 'inspect') actions.inspect([id]);
        else if (action === 'cut') faults.onCut(id);
        else if (action === 'restore') faults.onRestore(id);
        else if (action === 'loss-add') actions.setLoss(id, DEFAULT_LOSS_RATE);
        else if (action === 'loss-remove') actions.setLoss(id, 0);
        else if (action === 'delete') actions.remove([], [id]);
        return;
      }
      const id = target.id;
      const scope = menuScope(target, selectedIds, topology);
      switch (action) {
        case 'inspect':
          actions.inspect(scope);
          break;
        case 'duplicate':
          actions.duplicate(scope);
          break;
        case 'copy':
          actions.copy(scope);
          break;
        case 'connect':
          actions.connect(id, request.via === 'keyboard');
          break;
        case 'crash':
          faults.onInject(id, 'crash');
          break;
        case 'slow':
          faults.onInject(id, 'slow', { factor: DEFAULT_SLOW_FACTOR });
          break;
        case 'fix':
          faults.onFix(id);
          break;
        case 'delete':
          actions.remove(scope, []);
          break;
        default:
          break;
      }
    },
    [target, request, selectedIds, topology, actions, faults],
  );

  // The part or cable it was about is gone (an undo, say): nothing to offer.
  if (items.length === 0) return null;

  return (
    <ContextMenu
      x={request.x}
      y={request.y}
      via={request.via}
      title={title}
      items={items}
      onAction={run}
      onClose={onClose}
    />
  );
}
