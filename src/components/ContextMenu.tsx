import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { placeMenu } from './contextMenuItems';
import type { ContextMenuItem, MenuAction, MenuVia } from './contextMenuItems';
import './MainMenu.css';
import './ContextMenu.css';

/* ==========================================================================
   The canvas context menu.

   Opened by a right-click, a press and hold on a touch screen, or the menu
   key on a focused part. The rows are the main menu's rows (MainMenu.css),
   so the two menus look and behave alike; this file adds only where it
   sits and how it closes.

   [data-chrome] keeps the canvas's pointer router from treating a press on
   it as a canvas gesture.
   ========================================================================== */

export interface ContextMenuProps {
  x: number;
  y: number;
  via: MenuVia;
  title: string | null;
  items: readonly ContextMenuItem[];
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  via,
  title,
  items,
  onAction,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * Whether a press has started on the menu since it opened. The finger
   * that held the canvas lifts after the menu appears, and Chrome sends
   * that lift's click to whatever row is under it now, which ran a row the
   * reader never chose. Measured at 844x390 before this guard. A keyboard
   * click (detail 0) needs no press.
   */
  const pressedRef = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measured before paint, so the menu never flashes at the raw point.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(
      placeMenu(
        { x, y },
        { w: el.offsetWidth, h: el.offsetHeight },
        { w: window.innerWidth, h: window.innerHeight },
        via,
      ),
    );
  }, [x, y, via]);

  /* Focus the first live row, and hand focus back on close: to the part the
     menu key was pressed on, or wherever it was before. */
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ||
      document.activeElement instanceof SVGElement
        ? document.activeElement
        : null;
    const el = ref.current;
    el?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    )?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || el?.contains(active)) {
        opener?.focus({ preventScroll: true });
      }
    };
  }, []);

  /* A press anywhere else, a wheel, a resize or leaving the window closes
     it. Pointerdown, not click, so the menu is gone before whatever was
     pressed reacts. Bound a tick late so the press that opened it does not
     close it. */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    const t = window.setTimeout(() => {
      document.addEventListener('pointerdown', onDown, true);
    }, 0);
    window.addEventListener('wheel', onClose, { passive: true });
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onClose);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  /* Escape is taken in the capture phase: the canvas's own Escape also
     clears the selection, which closing a menu should not do. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /** Arrows, Home and End walk the rows; Tab leaves, which closes it. */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        onClose();
        return;
      }
      const rows = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
      );
      if (rows.length === 0) return;
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | null = null;
      if (e.key === 'ArrowDown') next = (i + 1) % rows.length;
      else if (e.key === 'ArrowUp') next = (i - 1 + rows.length) % rows.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = rows.length - 1;
      if (next === null) return;
      e.preventDefault();
      rows[next]?.focus();
    },
    [onClose],
  );

  return (
    <div
      ref={ref}
      className="cm"
      role="menu"
      aria-label={title ?? 'Canvas'}
      data-chrome="context-menu"
      data-via={via}
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: x, top: y, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        pressedRef.current = true;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {title ? (
        <p className="cm-title" aria-hidden="true">
          {title}
        </p>
      ) : null}
      {items.map((item, i) => (
        <Fragment key={item.action}>
          {i > 0 && items[i - 1]!.group !== item.group ? (
            <div className="mn-sep" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`mn-item cm-item${item.danger ? ' is-danger' : ''}`}
            aria-disabled={item.disabled ? true : undefined}
            onClick={(e) => {
              if (item.disabled) return;
              if (!pressedRef.current && e.detail !== 0) return;
              // Closed first, so a panel the action opens is not competing
              // with a menu still on screen.
              onClose();
              onAction(item.action);
            }}
          >
            <span className="mn-label">{item.label}</span>
            {item.hint ? (
              <kbd className="mn-hint" aria-hidden="true">
                {item.hint}
              </kbd>
            ) : null}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
