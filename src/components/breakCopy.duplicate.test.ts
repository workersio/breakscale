import { describe, expect, it } from 'vitest';
import { attackPhrase, timelineWords } from './breakCopy';
import type { Names } from './breakCopy';

/* The words for a cable delivering a request twice, in the verdict and in
   a request's story. */

const NAMES: Names = {
  node: (id) => ({ api: 'Checkout API', pay: 'Payments' })[id] ?? id,
  edge: () => 'the cable from Checkout API to Payments',
};

describe('duplicate delivery in words', () => {
  it('names the fault with its share and timing', () => {
    expect(
      attackPhrase(
        { kind: 'duplicate', target: 'api->pay', rate: 0.05, atMs: 10_000, forMs: 500 },
        NAMES,
      ),
    ).toBe(
      'make the cable from Checkout API to Payments deliver 5% of requests twice at 10s for 0.5s',
    );
  });

  it('tells the second delivery as its own line', () => {
    const lines = timelineWords(
      {
        rid: 7,
        clientId: 'shop',
        key: 0,
        truncated: false,
        events: [
          {
            t: 10_300,
            type: 'duplicate',
            from: 'api',
            to: 'pay',
            edge: 'api->pay',
            attempt: 0,
          },
        ],
      },
      NAMES,
    );
    expect(lines).toEqual([
      {
        t: 10_300,
        text: "The cable delivers Checkout API's call to Payments a second time.",
        tag: null,
      },
    ]);
  });
});
