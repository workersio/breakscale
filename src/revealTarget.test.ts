import { describe, expect, it } from 'vitest';
import { namedBy, revealTarget } from './revealTarget';
import type { Verdict } from './sim/judge';

const none = { inspecting: null, broke: null, verdict: null, incident: null };

describe('revealTarget', () => {
  it('asks for nothing when no panel is about a part', () => {
    expect(revealTarget(none)).toBeNull();
  });

  it('follows the inspector first, keyed on what it shows', () => {
    const r = revealTarget({ ...none, inspecting: ['db'], broke: ['api'] });
    expect(r).toEqual({ ids: ['db'], key: 'inspect:db' });
  });

  it('keeps the whole diagram while a task card is open', () => {
    const r = revealTarget({ ...none, inspecting: ['db'], guided: true });
    expect(r).toEqual({ ids: ['db'], key: 'inspect:db', whole: true });
  });

  it('names the parts a break hit', () => {
    expect(revealTarget({ ...none, broke: ['db', 'e1'] })?.ids).toEqual(['db', 'e1']);
  });

  it('keeps the design in view while "Can you break it?" is open', () => {
    const r = revealTarget({ ...none, breaking: ['client', 'api', 'db'] });
    expect(r).toEqual({ ids: ['client', 'api', 'db'], key: 'breaking', fit: true });
    expect(revealTarget({ ...none, broke: ['db'], breaking: ['db'] })?.key).toBe(
      'break:db',
    );
  });

  it('names the parts a "Cannot check yet" is about', () => {
    const verdict = {
      status: 'unjudgeable',
      designKey: 'k1',
      why: { reason: 'connection-cut', from: 'api', to: 'db' },
    } as unknown as Verdict;
    expect(revealTarget({ ...none, verdict })).toEqual({
      ids: ['api', 'db'],
      key: 'verdict:k1:api,db',
    });
  });

  it('names what an incident breaks', () => {
    const r = revealTarget({
      ...none,
      incident: {
        id: 's3',
        faults: [
          { atMs: 20000, action: 'inject', nodeId: 'store', kind: 'crash' },
          { atMs: 25000, action: 'cut', edgeId: 'e2' },
        ],
      },
    });
    expect(r).toEqual({ ids: ['store', 'e2'], key: 'incident:s3' });
  });

  it('keeps the whole diagram in when the charts rise, and only then', () => {
    expect(revealTarget({ ...none, charts: true })).toEqual({
      ids: [],
      key: 'charts',
      content: true,
    });
    // Anything a panel is about comes first.
    expect(revealTarget({ ...none, charts: true, inspecting: ['api'] })?.key).toBe(
      'inspect:api',
    );
  });
});

describe('namedBy', () => {
  it('names nothing for a reason about the whole design', () => {
    expect(namedBy({ reason: 'no-traffic' })).toEqual([]);
  });
});
