import type { NodeKind } from '../../sim/types';

/* ------------------------------------------------------------------ *
 * Cloud vendor mode.
 *
 * A student learning system design meets "load balancer" first and "ALB"
 * second, which is the right order: the concept survives a decade, the
 * product name does not. Generic therefore stays the default, and a vendor
 * is something you switch on once the idea has landed.
 *
 * WHAT THIS DATA IS, AND IS NOT.
 *
 * Everything in the vendor files beside this one is PUBLISHED SPEC: a vCPU
 * count, a memory figure, a price, each with the URL it came from and the
 * date it was read. Those are facts, and AGENTS.md requires them to be
 * true.
 *
 * What is NOT a fact is how a vCPU count becomes the engine's `capacity`
 * and `serviceMs`. No vendor publishes "this instance serves N concurrent
 * requests at M milliseconds", because the answer depends entirely on what
 * the software is doing. Any mapping is a MODEL, and this project's whole
 * point is to not dress a model up as a measurement.
 *
 * So the two are kept apart on purpose. Specs are cited. The derivation
 * lives in one documented function, is labelled as derived wherever it is
 * shown, and a reader who wants the real behaviour is told to set the
 * knobs themselves.
 * ------------------------------------------------------------------ */

export type VendorId = 'generic' | 'aws' | 'gcp' | 'azure';

/** A published hardware size. Every field here is quotable. */
export interface VendorSize {
  /** Exactly as the vendor writes it, e.g. `db.r6g.large`. */
  name: string;
  /**
   * Absent where the vendor does not publish one in readable text. Azure
   * Managed Redis states its per-SKU vCPU counts only inside an image, so
   * those sizes omit this rather than carry a guessed number. `derive.ts`
   * already treats a missing count as "nothing honest to say".
   */
  vcpu?: number;
  /** In the vendor's OWN unit. AWS and Azure publish GiB, GCP publishes GB. */
  memory: number;
  memoryUnit: 'GiB' | 'GB';
  /**
   * Network as PUBLISHED, kept as text.
   *
   * AWS says "Up to 10 Gigabit" for burstable classes and Azure publishes an
   * "expected" figure. Turning either into a number would quietly convert a
   * ceiling or an estimate into a promise.
   */
  network?: string;
  maxIops?: number;
  maxConnections?: number;
  /** On-demand, in the region named by the vendor file. */
  pricePerHour?: number;
  /** ISO date the price was read. Prices change; a stale one should show it. */
  pricedOn?: string;
  /** Where every number above came from. */
  source: string;
}

/** What one component kind is called at this vendor, and how it can be sized. */
export interface VendorMapping {
  /** The product name a student would see in the console. */
  product: string;
  /**
   * Why this product and not the vendor's other one. Present only where the
   * choice is genuinely arguable, so its presence means something.
   */
  note?: string;
  /** Sizes worth offering. Absent where the vendor does not expose sizing. */
  sizes?: VendorSize[];
  /**
   * Another kind whose `sizes` this one sells, for a product that is the same
   * hardware in a different role: an AWS worker is an EC2 instance, exactly
   * like a service. Pointing at the list instead of copying it keeps the two
   * from drifting. Read sizes through `sizesFor`, which follows this.
   */
  sizesFrom?: NodeKind;
}

export interface Vendor {
  id: VendorId;
  /** How the vendor writes its own name. */
  label: string;
  /** The region every price in this file is quoted in. */
  region?: string;
  kinds: Partial<Record<NodeKind, VendorMapping>>;
}
