import { describe, expect, it } from 'vitest';
import { COST_NOTE, HOURS_PER_MONTH, costDesign, fleetSize, formatMoney } from './cost';
import { AWS } from './aws';
import { GCP } from './gcp';
import { sizesFor } from './lookup';
import type { VendorSize } from './types';
import type { NodeConfig, SimNode } from '../../sim/types';
import { defaultConfig } from '../../sim/presets';

/**
 * The cost model turns cited hourly rates into a monthly figure. The
 * arithmetic is trivial; what these check is the honesty around it, which
 * is where a cost estimate normally goes wrong: quietly guessing a rate for
 * something it has no price for, or presenting compute as a bill.
 */

const size = (over: Partial<VendorSize> = {}): VendorSize => ({
  name: 'test.large',
  vcpu: 4,
  memory: 16,
  memoryUnit: 'GiB',
  pricePerHour: 1,
  source: 'https://example.invalid/spec',
  ...over,
});

const node = (over: Partial<SimNode> = {}): SimNode => ({
  id: 'n1',
  kind: 'service',
  label: 'API',
  x: 0,
  y: 0,
  config: defaultConfig('service'),
  ...over,
});

describe('fleet size', () => {
  it('counts instances for an ordinary component', () => {
    const c: NodeConfig = { ...defaultConfig('service'), instances: 3 };
    expect(fleetSize('service', c)).toBe(3);
  });

  it('counts partitions for a shard, which is its real fleet', () => {
    const c: NodeConfig = { ...defaultConfig('shard'), shardCount: 8 };
    expect(fleetSize('shard', c)).toBe(8);
  });

  it('counts the primary as well as the replicas', () => {
    // You pay for the primary too. Billing only the replicas would
    // understate a read-replica design by exactly one box, which is the
    // shape of error nobody notices.
    const c: NodeConfig = { ...defaultConfig('replica'), replicaCount: 3 };
    expect(fleetSize('replica', c)).toBe(4);
  });

  it('never bills for less than one', () => {
    const c: NodeConfig = { ...defaultConfig('service'), instances: 0 };
    expect(fleetSize('service', c)).toBe(1);
  });
});

describe('costing a design', () => {
  it('multiplies the rate by the fleet and by a 730 hour month', () => {
    // 730, not 720: vendors quote monthly figures on 365/12 hours, and a
    // 30-day month would sit 1.4 percent below their own calculator.
    expect(HOURS_PER_MONTH).toBe(730);
    const cost = costDesign([node()], AWS, () => size({ pricePerHour: 2 }));
    expect(cost.nodes[0]!.perHour).toBe(2);
    expect(cost.perMonth).toBe(2 * 730);
  });

  it('bills every box in a fleet', () => {
    const n = node({ config: { ...defaultConfig('service'), instances: 4 } });
    const cost = costDesign([n], AWS, () => size({ pricePerHour: 0.5 }));
    expect(cost.nodes[0]!.fleet).toBe(4);
    expect(cost.nodes[0]!.perHour).toBe(2);
  });

  it('lists what it could not price rather than guessing a rate', () => {
    // The whole discipline. A total that silently omits a component looks
    // complete and is wrong by an unknown amount.
    const cost = costDesign([node({ label: 'Unsized API' })], AWS, () => null);
    expect(cost.perMonth).toBe(0);
    expect(cost.unpriced).toEqual(['Unsized API']);
  });

  it('does not call a client unpriced, since nobody rents one', () => {
    const c = node({ kind: 'client', label: 'Browsers' });
    const cost = costDesign([c], AWS, () => null);
    expect(cost.unpriced).toEqual([]);
  });

  it('costs nothing at all on generic, where there are no prices', () => {
    const cost = costDesign([node()], null, () => size());
    expect(cost.perMonth).toBe(0);
    expect(cost.nodes).toEqual([]);
  });

  it('puts the most expensive component first', () => {
    // The reading a student wants is "what is costing me the money", so the
    // order is the answer rather than the input order.
    const nodes = [node({ id: 'a', label: 'cheap' }), node({ id: 'b', label: 'dear' })];
    const cost = costDesign(nodes, AWS, (n) =>
      size({ pricePerHour: n.id === 'b' ? 10 : 1 }),
    );
    expect(cost.nodes.map((n) => n.label)).toEqual(['dear', 'cheap']);
  });

  it('works against a real cited price', () => {
    const rds = AWS.kinds.db?.sizes?.find((s) => s.name === 'db.r6g.xlarge');
    expect(rds?.pricePerHour).toBeGreaterThan(0);
    const cost = costDesign([node({ kind: 'db' })], AWS, () => rds!);
    expect(cost.perMonth).toBeCloseTo(rds!.pricePerHour! * 730, 5);
  });
});

describe('presentation', () => {
  it.each([
    [12345, '$12,345'],
    [250, '$250'],
    [12.5, '$12.50'],
    [0.016, '$0.016'],
  ])('formats %i as %s', (usd, expected) => {
    expect(formatMoney(usd)).toBe(expected);
  });

  it('does not round a small real price down to nothing', () => {
    // $0.016/h is a real rate for a micro instance. Showing "$0" would tell
    // a student the thing is free.
    expect(formatMoney(0.016)).not.toBe('$0');
  });

  it('says the figure is compute only', () => {
    expect(COST_NOTE).toMatch(/compute only/i);
    expect(COST_NOTE).toMatch(/storage/i);
  });
});

describe("a kind that shares another kind's sizes", () => {
  // The AWS file says a worker is the same EC2 hardware as a service and
  // shares its sizes. Nothing read that, so a worker had no size picker and
  // every design with one reported a monthly total that left the workers out.
  const m6i = AWS.kinds.service!.sizes!.find((s) => s.name === 'm6i.large')!;
  const fleetOf4 = (id: string, kind: SimNode['kind'], label: string) =>
    node({ id, kind, label, config: { ...defaultConfig(kind), instances: 4 } });

  it('offers a worker on AWS the service sizes', () => {
    expect(sizesFor('worker', AWS)).toBe(AWS.kinds.service!.sizes);
  });

  it('prices a worker on AWS into the monthly total', () => {
    const nodes = [
      fleetOf4('api', 'service', 'API'),
      fleetOf4('w', 'worker', 'Worker'),
    ];
    const cost = costDesign(
      nodes,
      AWS,
      (n) => sizesFor(n.kind, AWS).find((s) => s.name === m6i.name) ?? null,
    );
    expect(cost.unpriced).toEqual([]);
    expect(cost.nodes.map((n) => n.label).sort()).toEqual(['API', 'Worker']);
    expect(cost.perMonth).toBeCloseTo(2 * 4 * m6i.pricePerHour! * HOURS_PER_MONTH);
  });

  it('leaves a kind with no sizes of its own and nothing to share unsized', () => {
    // GCP runs a worker as Cloud Run jobs, which are not sold as machine
    // sizes, so there is nothing honest to offer and it stays unpriced.
    expect(GCP.kinds.worker?.sizesFrom).toBeUndefined();
    expect(sizesFor('worker', GCP)).toEqual([]);
  });
});
