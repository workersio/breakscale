import { describe, expect, it } from 'vitest';
import { REVEAL_PAD, revealPan } from './reveal';
import type { RevealBox } from './reveal';

const box = (left: number, top: number, w: number, h: number): RevealBox => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

/* 1280x800 with the rail and the inspector open: the uncovered canvas. */
const room = box(236, 104, 712, 696);

describe('revealPan', () => {
  it('leaves a box that is already in view where it is', () => {
    expect(revealPan(box(400, 300, 184, 88), room)).toEqual({ dx: 0, dy: 0 });
  });

  it('pans a box under the inspector back in by the least it takes', () => {
    // Database, under a 320px inspector from x=948.
    const db = box(900, 300, 184, 88);
    const p = revealPan(db, room);
    expect(p.dy).toBe(0);
    expect(db.right + p.dx).toBe(room.right - REVEAL_PAD);
  });

  it('pans the other way for a box under the components rail', () => {
    const client = box(150, 300, 184, 88);
    const p = revealPan(client, room);
    expect(client.left + p.dx).toBe(room.left + REVEAL_PAD);
  });

  it('pans up into the strip above a phone sheet', () => {
    // 390x844, header to y=110, inspector sheet from y=410.
    const strip = box(0, 110, 390, 300);
    const node = box(120, 500, 70, 33);
    const p = revealPan(node, strip);
    expect(p.dx).toBe(0);
    expect(node.bottom + p.dy).toBe(strip.bottom - REVEAL_PAD);
  });

  it('lines up the start of a box too big for the room', () => {
    const wide = box(100, 200, 1000, 88);
    const p = revealPan(wide, room);
    expect(wide.left + p.dx).toBe(room.left + REVEAL_PAD);
  });

  it('steps past a floating card by the shortest way out', () => {
    // A card over the lower middle of the room; the box sits half under it.
    const card = box(400, 500, 300, 200);
    const node = box(450, 460, 184, 88);
    const p = revealPan(node, room, [card]);
    const moved = box(node.left + p.dx, node.top + p.dy, 184, 88);
    expect(moved.bottom).toBeLessThanOrEqual(card.top);
    expect(p.dx).toBe(0);
  });

  it('still brings the box into the room when no pan clears the cards', () => {
    const everywhere = box(0, 0, 2000, 2000);
    const db = box(900, 300, 184, 88);
    const p = revealPan(db, room, [everywhere]);
    expect(db.right + p.dx).toBe(room.right - REVEAL_PAD);
  });

  it('does nothing in a room with no space', () => {
    expect(revealPan(box(0, 0, 10, 10), box(0, 0, 20, 20))).toEqual({ dx: 0, dy: 0 });
  });
});
