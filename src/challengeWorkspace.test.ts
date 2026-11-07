// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHALLENGES_KEY,
  EMPTY_STORE,
  attemptFor,
  badgeFor,
  challengeParam,
  conform,
  freshStart,
  inPickerOrder,
  loadChallengeStore,
  nextChallenge,
  saveChallengeStore,
  withActive,
  withAttempt,
  withHints,
  withPass,
} from './challengeWorkspace';
import { BACKED_UP_KEYS } from './backup';
import type { Challenge } from './sim/challenge';
import { CHALLENGES } from './sim/challenges';
import { designKey, judgedTopology } from './sim/judge';
import { makeNode, PRESETS } from './sim/presets';
import type { FaultEvent } from './sim/types';

/**
 * The challenge workspace: what a brief starts from, and what survives a
 * reload. The App test drives the same functions through the interface; this
 * pins the rules they rest on.
 */

const brief = CHALLENGES[0]!;

beforeEach(() => localStorage.clear());

describe('a fresh attempt', () => {
  it('starts from the preset at the brief load, with its notes taken off', () => {
    const t = freshStart(brief);
    const preset = PRESETS.find((p) => p.id === brief.presetId)!;
    const load = t.nodes
      .filter((n) => n.kind === 'client')
      .reduce((sum, n) => sum + n.config.rps, 0);
    expect(load).toBe(brief.loadRps);
    expect(t.nodes.map((n) => n.id)).toEqual(preset.topology.nodes.map((n) => n.id));
    expect((t.annotations ?? []).some((a) => a.kind === 'note')).toBe(false);
  });

  it('carries the brief faults so Reset replays them', () => {
    const preset = PRESETS.find((p) => p.id === brief.presetId)!;
    const target = preset.topology.nodes.find((n) => n.kind !== 'client')!;
    const fault: FaultEvent = {
      atMs: 10_000,
      action: 'inject',
      nodeId: target.id,
      kind: 'crash',
    };
    const withFault: Challenge = { ...brief, faults: [fault] };
    expect(freshStart(withFault).faults).toEqual([fault]);
  });

  it('is what the check judges, so the live run and the check agree', () => {
    const t = freshStart(brief);
    const judged = judgedTopology(brief, t).topology;
    expect(t.nodes.map((n) => n.config)).toEqual(judged.nodes.map((n) => n.config));
  });
});

describe('conform', () => {
  it('runs a database added inside a brief at the brief service time', () => {
    const start = freshStart(brief);
    const db = start.nodes.find((n) => n.kind === 'db')!;
    const added = { ...makeNode('db', 0, 0, undefined, new Set(['db'])) };
    added.config = { ...added.config, serviceMs: 1 };
    const t = conform(brief, { ...start, nodes: [...start.nodes, added] });
    expect(t.nodes.at(-1)!.config.serviceMs).toBe(db.config.serviceMs);
  });

  it('shares the brief load across a second client rather than adding to it', () => {
    const start = freshStart(brief);
    const extra = makeNode('client', 0, 0, undefined, new Set(['client']));
    const t = conform(brief, { ...start, nodes: [...start.nodes, extra] });
    const load = t.nodes
      .filter((n) => n.kind === 'client')
      .reduce((sum, n) => sum + n.config.rps, 0);
    expect(load).toBe(brief.loadRps);
  });

  it('leaves the reader decisions, positions and notes alone', () => {
    const start = freshStart(brief);
    const db = start.nodes.find((n) => n.kind === 'db')!;
    const edited = {
      ...start,
      nodes: start.nodes.map((n) =>
        n.id === db.id
          ? { ...n, x: n.x + 40, config: { ...n.config, capacity: 31 } }
          : n,
      ),
    };
    const t = conform(brief, edited);
    const out = t.nodes.find((n) => n.id === db.id)!;
    expect(out.config.capacity).toBe(31);
    expect(out.x).toBe(db.x + 40);
    expect(designKey(brief, judgedTopology(brief, t).topology)).toBe(
      designKey(brief, judgedTopology(brief, edited).topology),
    );
  });
});

describe('the store', () => {
  it('is backed up with everything else', () => {
    expect(BACKED_UP_KEYS).toContain(CHALLENGES_KEY);
  });

  it('round-trips an attempt, its hints, a pass and the active brief', () => {
    let s = withAttempt(EMPTY_STORE, brief, freshStart(brief));
    s = withHints(s, brief, 2, freshStart(brief));
    s = withPass(s, brief, 2, new Date('2026-01-02T03:04:05Z'));
    s = withActive(s, brief.id);
    saveChallengeStore(s);
    const back = loadChallengeStore(CHALLENGES);
    expect(back).toEqual(s);
    expect(attemptFor(back, brief)?.hintsShown).toBe(2);
    expect(badgeFor(back, brief)).toBe('passed');
  });

  it('says In progress for an attempt that has not passed', () => {
    const s = withAttempt(EMPTY_STORE, brief, freshStart(brief));
    expect(badgeFor(s, brief)).toBe('in-progress');
    expect(badgeFor(EMPTY_STORE, brief)).toBeNull();
  });

  it('keeps the first pass of a version', () => {
    const first = withPass(EMPTY_STORE, brief, 0, new Date('2026-01-01T00:00:00Z'));
    const again = withPass(first, brief, 3, new Date('2026-02-01T00:00:00Z'));
    expect(again).toBe(first);
  });

  it('forgets the attempt and the badge of a brief whose version moved on', () => {
    let s = withAttempt(EMPTY_STORE, brief, freshStart(brief));
    s = withPass(withActive(s, brief.id), brief, 0, new Date());
    saveChallengeStore(s);
    const bumped = CHALLENGES.map((c) =>
      c.id === brief.id ? { ...c, version: c.version + 1 } : c,
    );
    const back = loadChallengeStore(bumped);
    expect(back.attempts[brief.id]).toBeUndefined();
    expect(back.progress[brief.id]).toBeUndefined();
    // Nothing to come back to, so no brief opens on boot.
    expect(back.active).toBeNull();
  });

  it('drops a broken attempt without losing the rest', () => {
    const other = CHALLENGES[1]!;
    const s = withAttempt(EMPTY_STORE, other, freshStart(other));
    const raw = JSON.parse(JSON.stringify(s));
    raw.attempts[brief.id] = { version: brief.version, topology: { nodes: 'no' } };
    raw.progress[brief.id] = { version: brief.version };
    localStorage.setItem(CHALLENGES_KEY, JSON.stringify(raw));
    const back = loadChallengeStore(CHALLENGES);
    expect(Object.keys(back.attempts)).toEqual([other.id]);
    expect(back.progress).toEqual({});
  });

  it('boots empty from corrupt storage', () => {
    localStorage.setItem(CHALLENGES_KEY, '{not json');
    expect(loadChallengeStore(CHALLENGES)).toEqual(EMPTY_STORE);
    localStorage.setItem(CHALLENGES_KEY, '[]');
    expect(loadChallengeStore(CHALLENGES)).toEqual(EMPTY_STORE);
  });
});

describe('the picker order', () => {
  it('groups by tier, easiest first, keeping the listed order inside one', () => {
    const list = [
      { ...CHALLENGES[0]!, id: 'a', tier: 2 },
      { ...CHALLENGES[0]!, id: 'b' },
      { ...CHALLENGES[0]!, id: 'c', tier: 1 },
      { ...CHALLENGES[0]!, id: 'd', tier: 2 },
    ];
    expect(inPickerOrder(list).map((c) => c.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(nextChallenge(list, 'c')?.id).toBe('a');
    expect(nextChallenge(list, 'd')).toBeNull();
  });

  it('reads a challenge link', () => {
    expect(challengeParam('?challenge=hold-the-line')).toBe('hold-the-line');
    expect(challengeParam('?x=1')).toBeNull();
    expect(challengeParam('')).toBeNull();
  });
});
