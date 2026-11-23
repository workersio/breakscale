import type { NodeKind } from '../../sim/types';
import { KIND_NAME } from '../../components/nodeVisuals';
import type { Vendor, VendorId, VendorMapping, VendorSize } from './types';

/* ------------------------------------------------------------------ *
 * Reading the vendor registry.
 *
 * Every lookup here falls back to the generic name rather than to nothing.
 * A vendor file that has no entry for a kind is the normal case, not an
 * error: Google has no managed equivalent of some things, and a student
 * who switched to GCP should see "Bulkhead" rather than a blank box.
 * ------------------------------------------------------------------ */

/** Loaded lazily, so a reader who never picks a vendor never fetches one. */
const LOADERS: Record<Exclude<VendorId, 'generic'>, () => Promise<Vendor>> = {
  aws: () => import('./aws').then((m) => m.AWS),
  gcp: () => import('./gcp').then((m) => m.GCP),
  azure: () => import('./azure').then((m) => m.AZURE),
};

const cache = new Map<VendorId, Vendor>();

export async function loadVendor(id: VendorId): Promise<Vendor | null> {
  if (id === 'generic') return null;
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const v = await LOADERS[id]();
    cache.set(id, v);
    return v;
  } catch {
    // A vendor file that fails to load leaves the app on generic names
    // rather than breaking the canvas. The data is a labelling convenience,
    // never something the simulation depends on.
    return null;
  }
}

/** Synchronous read of an already-loaded vendor, for render paths. */
export function peekVendor(id: VendorId): Vendor | null {
  return id === 'generic' ? null : (cache.get(id) ?? null);
}

/** What this kind is called, at this vendor, falling back to the plain name. */
export function nameFor(kind: NodeKind, vendor: Vendor | null): string {
  return vendor?.kinds[kind]?.product ?? KIND_NAME[kind];
}

/**
 * The sizes on offer for a kind: its own, or the ones it shares through
 * `sizesFrom`. The size picker and the cost total both read this, so a kind
 * that can be sized is also a kind that can be priced.
 */
export function sizesFor(kind: NodeKind, vendor: Vendor | null): VendorSize[] {
  const mapping = vendor?.kinds[kind];
  if (!mapping) return [];
  if (mapping.sizes) return mapping.sizes;
  return mapping.sizesFrom ? (vendor?.kinds[mapping.sizesFrom]?.sizes ?? []) : [];
}

/** The mapping for a kind, if the vendor has one. */
export function mappingFor(
  kind: NodeKind,
  vendor: Vendor | null,
): VendorMapping | null {
  return vendor?.kinds[kind] ?? null;
}
