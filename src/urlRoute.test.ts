import { describe, expect, it } from 'vitest';
import { challengeLink, exampleParam, routedHref } from './urlRoute';

const BASE = 'https://breakscale.tech/';

describe('routedHref', () => {
  it('names the brief, and not its example, inside a brief', () => {
    expect(
      routedHref(`${BASE}?example=netflix`, {
        challengeId: 'hold-the-line',
        exampleId: 'single-server',
        dropShare: false,
      }),
    ).toBe(`${BASE}?challenge=hold-the-line`);
  });

  it('names an example outside a brief, and nothing for an own design', () => {
    const own = { challengeId: null, exampleId: null, dropShare: false };
    expect(routedHref(`${BASE}?challenge=x`, { ...own, exampleId: 'netflix' })).toBe(
      `${BASE}?example=netflix`,
    );
    expect(routedHref(`${BASE}?example=netflix`, own)).toBe(BASE);
  });

  it('keeps every other parameter, and the hash unless told to drop it', () => {
    const route = { challengeId: null, exampleId: 'netflix', dropShare: false };
    expect(routedHref(`${BASE}?utm=a#d2.x`, route)).toBe(
      `${BASE}?utm=a&example=netflix#d2.x`,
    );
    expect(routedHref(`${BASE}?s=abc&utm=a#k`, { ...route, dropShare: true })).toBe(
      `${BASE}?utm=a&example=netflix`,
    );
  });
});

describe('exampleParam', () => {
  it('reads the id, trimmed, or null', () => {
    expect(exampleParam('?example=netflix')).toBe('netflix');
    expect(exampleParam('?example=%20uber%20')).toBe('uber');
    expect(exampleParam('?example=')).toBeNull();
    expect(exampleParam('')).toBeNull();
  });
});

describe('challengeLink', () => {
  it('carries only the brief', () => {
    expect(challengeLink(`${BASE}?example=a&s=b#k`, 'keep-it-warm')).toBe(
      `${BASE}?challenge=keep-it-warm`,
    );
  });
});
