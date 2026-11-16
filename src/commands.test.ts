import { describe, expect, it } from 'vitest';
import {
  fuzzyScore,
  pushRecent,
  rankCommands,
  RECENT_MAX,
  type Command,
} from './commands';

const cmd = (id: string, label: string, extra: Partial<Command> = {}): Command => ({
  id,
  label,
  group: 'View',
  run: () => {},
  ...extra,
});

describe('fuzzyScore', () => {
  it('matches a scattered subsequence and refuses a missing letter', () => {
    expect(fuzzyScore('netf', 'Netflix: streaming at scale')).not.toBeNull();
    expect(fuzzyScore('lb', 'Add load balancer')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Add load balancer')).toBeNull();
  });

  it('ranks a word start above the same letters mid-word', () => {
    const start = fuzzyScore('ser', 'User service') ?? 0;
    const mid = fuzzyScore('ser', 'Userland') ?? 0;
    expect(start).toBeGreaterThan(mid);
  });

  it('ranks a substring above a scattered match', () => {
    expect(fuzzyScore('cache', 'Add cache') ?? 0).toBeGreaterThan(
      fuzzyScore('cache', 'Crash a cool hen') ?? 0,
    );
  });

  it('takes the words of the query in any order, against label or keywords', () => {
    expect(fuzzyScore('db crash', 'Crash Database')).not.toBeNull();
    expect(fuzzyScore('speed', 'Play at 2×', ['speed'])).not.toBeNull();
    expect(fuzzyScore('db missing', 'Crash Database')).toBeNull();
  });

  it('scores an empty query as a match', () => {
    expect(fuzzyScore('  ', 'Anything')).toBe(0);
  });
});

describe('rankCommands', () => {
  const list = [
    cmd('a', 'Pause'),
    cmd('b', 'Netflix: streaming at scale', { group: 'Example' }),
    cmd('c', 'Discord: real-time chat', { group: 'Example' }),
    cmd('g', 'What is p99?', { group: 'Glossary', searchOnly: true }),
    cmd('d', 'Can you break it?', { disabled: 'Off during a challenge.' }),
  ];

  it('with nothing typed: recent first, then the rest, search-only rows held back', () => {
    const ids = rankCommands(list, '', ['c']).map((c) => c.id);
    expect(ids).toEqual(['c', 'a', 'b', 'd']);
  });

  it('leaves a disabled command out of the recent head', () => {
    expect(rankCommands(list, '', ['d'])[0]?.id).toBe('a');
  });

  it('"netf" puts Netflix first', () => {
    expect(rankCommands(list, 'netf')[0]?.id).toBe('b');
  });

  it('finds search-only rows once something is typed', () => {
    expect(rankCommands(list, 'p99').map((c) => c.id)).toContain('g');
  });

  it('keeps the given order between equal scores', () => {
    const twins = [cmd('x', 'Open one'), cmd('y', 'Open one')];
    expect(rankCommands(twins, 'open').map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('caps a query at the limit', () => {
    const many = Array.from({ length: 100 }, (_, i) => cmd(`n${i}`, `Node ${i}`));
    expect(rankCommands(many, 'node', [], 10)).toHaveLength(10);
    expect(rankCommands(many, '')).toHaveLength(100);
  });
});

describe('pushRecent', () => {
  it('moves to the front, drops the duplicate and caps', () => {
    let r: string[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) r = pushRecent(r, id);
    expect(r).toEqual(['b', 'f', 'e', 'd', 'c']);
    expect(r).toHaveLength(RECENT_MAX);
  });
});
