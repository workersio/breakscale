// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_NAME,
  MAX_SAVED,
  deleteDesign,
  getDesign,
  listDesigns,
  loadDesigns,
  renameDesign,
  saveDesign,
  savedAgo,
} from './savedDesigns';
import { PRESETS } from './sim/presets';
import type { Topology } from './sim/types';

/**
 * Named saves live in localStorage, which is a shelf anyone can reach into:
 * a half-written entry from a killed tab, a hand-edited value, or a design
 * from a format that no longer exists. Most of what follows is about
 * surviving that, because the happy path is one setItem call.
 */

const topo = (): Topology => structuredClone(PRESETS[0]!.topology);
const netflix = (): Topology =>
  structuredClone(PRESETS.find((p) => p.id === 'netflix')!.topology);

beforeEach(() => localStorage.clear());

describe('saving', () => {
  it('keeps a design and gives it back unchanged', () => {
    const r = saveDesign('My first system', topo());
    expect(r.ok).toBe(true);
    const list = listDesigns();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('My first system');
    expect(list[0]!.nodeCount).toBe(topo().nodes.length);
  });

  it('carries annotations through, since they are half the design', () => {
    saveDesign('netflix', netflix());
    const back = getDesign(listDesigns()[0]!.id);
    expect(back!.topology.annotations?.length).toBeGreaterThan(0);
  });

  it('carries the fault schedule and the seed, so a saved run replays', () => {
    const t = topo();
    const [first] = t.nodes;
    const faults = [
      {
        atMs: 2000,
        action: 'inject' as const,
        nodeId: first!.id,
        kind: 'crash' as const,
      },
      { atMs: 4000, action: 'clear' as const, nodeId: first!.id },
    ];
    saveDesign('broken', { ...t, faults, seed: 77 });
    const back = getDesign(listDesigns()[0]!.id)!.topology;
    expect(back.faults).toEqual(faults);
    expect(back.seed).toBe(77);
  });

  it('does not alias the live topology', () => {
    // Saving must take a copy: editing the canvas afterwards has to leave
    // the saved version alone, which is the whole point of saving it.
    const live = topo();
    saveDesign('snapshot', live);
    live.nodes[0]!.label = 'CHANGED AFTER SAVING';
    expect(getDesign(listDesigns()[0]!.id)!.topology.nodes[0]!.label).not.toBe(
      'CHANGED AFTER SAVING',
    );
  });

  it('replaces rather than duplicates when the name is reused', () => {
    // Pressing save twice with the same name means "update this", not
    // "keep two things called the same".
    saveDesign('Draft', topo());
    saveDesign('Draft', netflix());
    const list = listDesigns();
    expect(list).toHaveLength(1);
    expect(list[0]!.nodeCount).toBe(netflix().nodes.length);
  });

  it('matches an existing name regardless of case', () => {
    saveDesign('Draft', topo());
    saveDesign('draft', topo());
    expect(listDesigns()).toHaveLength(1);
  });

  it('refuses a name that is only whitespace', () => {
    const r = saveDesign('   ', topo());
    expect(r.ok).toBe(false);
    expect(listDesigns()).toHaveLength(0);
  });

  it('trims a name that would be a paragraph', () => {
    saveDesign('x'.repeat(MAX_NAME + 40), topo());
    expect(listDesigns()[0]!.name).toHaveLength(MAX_NAME);
  });

  it('lists the newest first', () => {
    saveDesign('older', topo());
    // savedAt is a millisecond clock, so two saves in the same tick would
    // tie. Nudge the first one back to make the ordering observable.
    const raw = JSON.parse(localStorage.getItem('breakscale.designs.v1')!);
    raw[0].savedAt -= 10_000;
    localStorage.setItem('breakscale.designs.v1', JSON.stringify(raw));
    saveDesign('newer', topo());
    expect(listDesigns().map((d) => d.name)).toEqual(['newer', 'older']);
  });
});

describe('the shelf is finite', () => {
  it('drops the oldest and says which, rather than losing it quietly', () => {
    for (let i = 0; i < MAX_SAVED; i += 1) {
      saveDesign(`design ${i}`, topo());
      const raw = JSON.parse(localStorage.getItem('breakscale.designs.v1')!);
      // Age every existing entry, so the ordering is deterministic.
      for (const e of raw) e.savedAt -= 1000;
      localStorage.setItem('breakscale.designs.v1', JSON.stringify(raw));
    }
    expect(listDesigns()).toHaveLength(MAX_SAVED);

    const r = saveDesign('one too many', topo());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.evicted).toBe('design 0');
    expect(listDesigns()).toHaveLength(MAX_SAVED);
    expect(listDesigns().some((d) => d.name === 'one too many')).toBe(true);
    expect(listDesigns().some((d) => d.name === 'design 0')).toBe(false);
  });
});

describe('reading a shelf that cannot be trusted', () => {
  it.each([
    ['not json at all', '{{{'],
    ['a bare string', '"hello"'],
    ['an object where a list belongs', '{"a":1}'],
    ['null', 'null'],
  ])('survives %s', (_label, stored) => {
    localStorage.setItem('breakscale.designs.v1', stored);
    expect(loadDesigns()).toEqual([]);
  });

  it('drops one corrupt entry without losing the rest', () => {
    saveDesign('good', topo());
    const raw = JSON.parse(localStorage.getItem('breakscale.designs.v1')!);
    raw.push({ id: 'broken', name: 'broken', savedAt: 1, topology: { nodes: 'no' } });
    localStorage.setItem('breakscale.designs.v1', JSON.stringify(raw));
    const list = listDesigns();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('good');
  });

  it('rejects a topology whose edge points at a component that is gone', () => {
    // isTopology's job, relied on here rather than restated: an edge into
    // nothing would route traffic into nothing.
    const bad = topo();
    bad.edges[0]!.to = 'does-not-exist';
    localStorage.setItem(
      'breakscale.designs.v1',
      JSON.stringify([{ id: 'x', name: 'x', savedAt: 1, topology: bad }]),
    );
    expect(loadDesigns()).toEqual([]);
  });

  it('strips a hostile annotation colour instead of storing it', () => {
    const t = topo();
    (t as unknown as { annotations: unknown[] }).annotations = [
      { id: 'n', kind: 'note', text: 'hi', x: 0, y: 0, width: 200, color: 'red;evil' },
    ];
    localStorage.setItem(
      'breakscale.designs.v1',
      JSON.stringify([{ id: 'x', name: 'x', savedAt: 1, topology: t }]),
    );
    const back = loadDesigns()[0]!;
    expect(back.topology.annotations?.[0]).not.toHaveProperty('color');
  });

  it('names an entry that lost its name rather than showing a blank row', () => {
    localStorage.setItem(
      'breakscale.designs.v1',
      JSON.stringify([{ id: 'x', name: '   ', savedAt: 1, topology: topo() }]),
    );
    expect(loadDesigns()[0]!.name).toBe('Untitled');
  });
});

describe('renaming and deleting', () => {
  it('renames in place, keeping the id', () => {
    saveDesign('before', topo());
    const id = listDesigns()[0]!.id;
    expect(renameDesign(id, 'after')).toBe(true);
    expect(listDesigns()[0]!.id).toBe(id);
    expect(listDesigns()[0]!.name).toBe('after');
  });

  it('refuses a rename that would collide with another design', () => {
    saveDesign('one', topo());
    saveDesign('two', topo());
    const id = listDesigns().find((d) => d.name === 'two')!.id;
    expect(renameDesign(id, 'one')).toBe(false);
    expect(listDesigns().filter((d) => d.name === 'one')).toHaveLength(1);
  });

  it('lets a design keep its own name', () => {
    saveDesign('same', topo());
    const id = listDesigns()[0]!.id;
    expect(renameDesign(id, 'same')).toBe(true);
  });

  it('deletes one without touching the others', () => {
    saveDesign('keep', topo());
    saveDesign('drop', topo());
    deleteDesign(listDesigns().find((d) => d.name === 'drop')!.id);
    expect(listDesigns().map((d) => d.name)).toEqual(['keep']);
  });

  it('ignores a delete for something already gone', () => {
    saveDesign('keep', topo());
    deleteDesign('no-such-id');
    expect(listDesigns()).toHaveLength(1);
  });
});

describe('savedAgo', () => {
  const now = 1_700_000_000_000;
  it.each([
    [0, 'just now'],
    [30_000, 'just now'],
    [60_000, '1 minute ago'],
    [180_000, '3 minutes ago'],
    [3_600_000, '1 hour ago'],
    [7_200_000, '2 hours ago'],
    [86_400_000, '1 day ago'],
    [259_200_000, '3 days ago'],
  ])('reads %i ms as %s', (ago, expected) => {
    expect(savedAgo(now - ago, now)).toBe(expected);
  });

  it('does not report the future as a negative age', () => {
    // A clock change, or a design synced from a machine running fast.
    expect(savedAgo(now + 60_000, now)).toBe('just now');
  });
});
