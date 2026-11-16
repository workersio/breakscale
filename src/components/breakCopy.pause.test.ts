import { describe, expect, it } from 'vitest';
import { attackPhrase, timelineWords } from './breakCopy';
import type { Names } from './breakCopy';

/* The words for a pause and for a cable that loses its answers, in the
   verdict and in a request's story. */

const NAMES: Names = {
  node: (id) => ({ api: 'Checkout API', pay: 'Payments' })[id] ?? id,
  edge: () => 'the cable from Checkout API to Payments',
};

describe('a pause and lost answers in words', () => {
  it('names a pause with its moment and its length', () => {
    expect(
      attackPhrase({ kind: 'pause', target: 'pay', atMs: 10_000, forMs: 2000 }, NAMES),
    ).toBe('stall Payments at 10s for 2s');
  });

  it('names a cable that loses its answers', () => {
    expect(
      attackPhrase(
        { kind: 'cut-replies', target: 'api->pay', atMs: 12_000, forMs: 500 },
        NAMES,
      ),
    ).toBe(
      'make the cable from Checkout API to Payments lose its answers at 12s for 0.5s',
    );
  });

  it('tells a lost answer as its own line', () => {
    const lost = (ok: boolean) =>
      timelineWords(
        {
          rid: 7,
          clientId: 'shop',
          key: 0,
          truncated: false,
          events: [
            {
              t: 10_040,
              type: 'reply-lost',
              node: 'pay',
              to: 'api',
              edge: 'api->pay',
              attempt: 0,
              ok,
            },
          ],
        },
        NAMES,
      );
    expect(lost(true)).toEqual([
      {
        t: 10_040,
        text: 'Payments answers, but the answer is lost on the way back to Checkout API.',
        tag: 'lost',
      },
    ]);
    expect(lost(false)[0]?.text).toBe(
      'Payments answers that it failed, but the answer is lost on the way back to Checkout API.',
    );
  });

  it('does not say a try whose answer was lost is still running', () => {
    const lines = timelineWords(
      {
        rid: 7,
        clientId: 'shop',
        key: 0,
        truncated: false,
        events: [
          {
            t: 10_040,
            type: 'reply-lost',
            node: 'pay',
            to: 'api',
            edge: 'api->pay',
            attempt: 0,
            ok: true,
          },
          { t: 10_300, type: 'timeout', node: 'api', to: 'pay', attempt: 0 },
          { t: 10_900, type: 'timeout', node: 'api', to: 'pay', attempt: 1 },
        ],
      },
      NAMES,
    );
    expect(lines.map((l) => l.text).slice(1)).toEqual([
      'Checkout API stops waiting for Payments, never having heard back.',
      'Checkout API stops waiting for Payments. That try keeps running there.',
    ]);
  });
});
