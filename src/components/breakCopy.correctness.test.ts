import { describe, expect, it } from 'vitest';
import {
  checkedLine,
  clock,
  evidenceSentence,
  goneLine,
  nothingRetriesLine,
  timelineWords,
} from './breakCopy';
import type { Names } from './breakCopy';
import { PRESETS, defaultConfig } from '../sim/presets';
import type { NodeConfig, NodeKind, SimNode, Topology } from '../sim/types';
import { followRequest, verify } from '../sim/verify';

/**
 * The correctness evidence in words: the first violation as a sentence, and
 * the request's story, where the second charge and the lost copy say what
 * they are in a word as well as in a colour.
 */

function node(
  id: string,
  label: string,
  kind: NodeKind,
  patch: Partial<NodeConfig>,
): SimNode {
  return { id, kind, label, x: 0, y: 0, config: { ...defaultConfig(kind), ...patch } };
}

/** The smallest design that charges twice: a retry after a timeout. */
const CHECKOUT: Topology = {
  nodes: [
    node('client', 'Client', 'client', { rps: 100 }),
    node('checkout', 'Checkout', 'service', {
      capacity: 64,
      serviceMs: 5,
      timeoutMs: 300,
      retries: 2,
    }),
    node('pay', 'Payment Provider', 'service', {
      capacity: 64,
      serviceMs: 100,
      serviceCv: 0.3,
      chargeable: 1,
    }),
  ],
  edges: [
    { id: 'a', from: 'client', to: 'checkout', weight: 1 },
    { id: 'b', from: 'checkout', to: 'pay', weight: 1 },
  ],
};

function namesOf(t: Topology): Names {
  return {
    node: (id) => t.nodes.find((n) => n.id === id)?.label ?? id,
    edge: (id) => id,
  };
}

const NO_DASH = /—/;

describe('correctness evidence', () => {
  it('tells the double charge from the first request that broke it', () => {
    // Retries only: a cable delivering twice tells another story, below.
    const v = verify(
      CHECKOUT,
      { metric: 'doubleCharges', max: 0 },
      { kinds: ['crash', 'crash-instance', 'slow', 'errors', 'cut'] },
    );
    if (v.status !== 'broken' || v.first?.check !== 'atMostOnce') {
      throw new Error(`expected a double charge, got ${v.status}`);
    }
    const names = namesOf(CHECKOUT);
    const said = evidenceSentence(v.first, names);
    expect(said).toBe(
      `Request ${v.first.rid} was charged twice at Payment Provider, at ${clock(v.first.chargedMs[0])} and ${clock(v.first.chargedMs[1])}. The client was told it went through.`,
    );

    const tl = followRequest(v.replay, v.first.rid);
    if (tl === null) throw new Error('no story');
    const lines = timelineWords(tl, names);
    const again = lines.filter((l) => l.tag === 'charged-again');
    expect(again).toHaveLength(1);
    expect(again[0].t).toBe(v.first.chargedMs[1]);
    expect(again[0].text).toBe('Payment Provider charges the card again.');
    // The timeout comes first, then the retry, then both charges.
    const order = lines.map((l) => l.text);
    const timeout = order.indexOf(
      'Checkout stops waiting for Payment Provider. That try keeps running there.',
    );
    expect(timeout).toBeGreaterThan(0);
    expect(order.indexOf('Checkout will try Payment Provider again.')).toBeGreaterThan(
      timeout,
    );
    for (const l of lines) expect(l.text).not.toMatch(NO_DASH);
    expect(order[order.length - 1]).toBe('The client hears it worked.');
  }, 60_000);

  it('tells a lost write from saved to lost', () => {
    const p = PRESETS.find((x) => x.id === 'resilient-delivery');
    if (!p) throw new Error('resilient-delivery');
    const v = verify(p.topology, { metric: 'lostAckedWrites', max: 0 });
    if (v.status !== 'broken' || v.first?.check !== 'lostAckedWrite') {
      throw new Error(`expected a lost write, got ${v.status}`);
    }
    const names = namesOf(p.topology);
    expect(evidenceSentence(v.first, names)).toContain(
      `was held in ${names.node(v.first.nodeId)}`,
    );
    expect(evidenceSentence(v.first, names)).toContain(
      `It was lost when ${names.node(v.first.lostAt)}`,
    );
    const tl = followRequest(v.replay, v.first.rid);
    if (tl === null) throw new Error('no story');
    const lines = timelineWords(tl, names);
    const lost = lines.filter((l) => l.tag === 'lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].t).toBe(v.first.lostMs);
    expect(lines.some((l) => l.text === 'The client hears it worked.')).toBe(true);
  }, 60_000);

  it('says what was checked when it held', () => {
    expect(checkedLine({ metric: 'doubleCharges', max: 0 }, 2983)).toBe(
      'Every fault schedule was checked; with no faults that is 2983 payments. Not checked: a payment the client was told failed that was charged anyway.',
    );
    expect(checkedLine({ metric: 'lostAckedWrites', max: 0 }, 1)).toBe(
      'Every fault schedule was checked; with no faults that is 1 write the client was told was saved.',
    );
  });

  it('numbers the tries from one', () => {
    const send = (attempt: number) =>
      timelineWords(
        {
          rid: 1,
          clientId: 'client',
          key: 0,
          truncated: false,
          events: [
            { t: 0, type: 'send', from: 'checkout', to: 'pay', edge: 'b', attempt },
          ],
        },
        namesOf(CHECKOUT),
      )[0].text;
    expect(send(0)).toBe('Checkout calls Payment Provider.');
    expect(send(1)).toBe('Checkout calls Payment Provider again, try 2.');
    expect(send(2)).toBe('Checkout calls Payment Provider again, try 3.');
  });

  it('names where each charge happened when a retry reached another copy', () => {
    const names: Names = { node: (id) => id.toUpperCase(), edge: (id) => id };
    expect(
      evidenceSentence(
        {
          check: 'atMostOnce',
          rid: 7,
          clientId: 'client',
          key: 0,
          invokedMs: 10_000,
          nodeId: 'pay2',
          chargedMs: [10_100, 10_500],
          nodeIds: ['pay1', 'pay2'],
          outcome: 'ok',
        },
        names,
      ),
    ).toBe(
      'Request 7 was charged twice, at PAY1 at 10.10s and at PAY2 at 10.50s. The client was told it went through.',
    );
  });

  it('says the cache held the write and names the part that failed', () => {
    const names: Names = {
      node: (id) => (id === 'buf' ? 'Cache' : 'Database'),
      edge: (id) => id,
    };
    expect(
      evidenceSentence(
        {
          check: 'lostAckedWrite',
          copy: 'cache',
          rid: 3,
          clientId: 'client',
          key: 0,
          invokedMs: 9000,
          ackedMs: 9010,
          nodeId: 'buf',
          bufferedMs: 9005,
          lostMs: 10_010,
          reason: 'crashed',
          lostAt: 'db',
        },
        names,
      ),
    ).toBe(
      'Request 3 was held in Cache at 9.01s, and the client was told it was saved. It was lost when Database crashed at 10.01s, before it reached storage.',
    );
  });

  it('says the store answered before its disk had the write', () => {
    const names: Names = { node: () => 'Orders DB', edge: (id) => id };
    expect(
      evidenceSentence(
        {
          check: 'lostAckedWrite',
          copy: 'disk',
          rid: 9,
          clientId: 'client',
          key: 0,
          invokedMs: 9000,
          ackedMs: 9010,
          nodeId: 'db',
          bufferedMs: 9005,
          lostMs: 9500,
          reason: 'crashed',
          lostAt: 'db',
        },
        names,
      ),
    ).toBe(
      'Request 9 was saved by Orders DB at 9.01s, and the client was told so, but it was still in memory. It was lost when Orders DB went down at 9.50s, before it reached disk.',
    );
  });

  it('tells a stale read, and tags the read in its story', () => {
    const p = PRESETS.find((x) => x.id === 'read-replicas');
    if (!p) throw new Error('read-replicas');
    const v = verify(p.topology, { metric: 'staleReads', max: 0 });
    if (
      v.status !== 'alreadyBroken' ||
      v.first?.check !== 'readYourWrites' ||
      !v.replay
    ) {
      throw new Error(`expected a stale read, got ${v.status}`);
    }
    const names = namesOf(p.topology);
    const said = evidenceSentence(v.first, names);
    expect(said).toContain(`request ${v.first.wroteRid} saved a change to it`);
    expect(said).not.toMatch(NO_DASH);
    const tl = followRequest(v.replay, v.first.rid);
    if (tl === null) throw new Error('no story');
    expect(
      timelineWords(tl, names, v.first).filter((l) => l.tag === 'stale'),
    ).toHaveLength(1);
  }, 60_000);

  it('says why a goal is no longer offered', () => {
    expect(goneLine('saved')).toMatch(/no saved write can be lost/);
    expect(goneLine('up:checkout')).toBe('That traffic source is gone.');
    expect(nothingRetriesLine(['pay'], namesOf(CHECKOUT))).toBe(
      'Nothing on the way to Payment Provider sends a call again, and no cable was tried delivering a call twice, so nothing tried could charge twice. Turn on retries before it, or let the search deliver requests twice, to test it.',
    );
  });
});
