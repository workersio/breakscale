import { useSyncExternalStore } from 'react';
import type { VendorId } from './vendors/types';

/**
 * User preferences.
 *
 * A tiny external store rather than React context, for the same reason the
 * tooltip controller is one: a preference is read inside components that
 * re-render ten times a second while the simulation runs, and a context
 * provider would re-render every consumer on any change. `useSyncExternalStore`
 * lets a component subscribe to exactly the value it reads.
 *
 * Everything here is a per-person choice about how much interface to show. It
 * is deliberately small. A settings screen with twenty switches is how an app
 * stops having opinions, and this one should have opinions.
 */

export interface Preferences {
  /**
   * Explain metric terms on hover, focus and tap.
   *
   * ON by default. It shipped off because forty dotted underlines made the
   * first screen look busy, and the cost was that a student who did not know
   * what p99 meant never found out the answer was one hover away. Terms are
   * now unmarked at rest (Tooltip.css), so the default can be the useful one.
   * Turning it off also drops the forty tab stops, for anyone who would
   * rather keyboard past them; the glossary panel stays available either way.
   */
  tooltips: boolean;
  /** Draw the small trend line on each node. */
  sparklines: boolean;
  /** Snap node positions to the 8px grid while dragging. */
  snapToGrid: boolean;
  /**
   * Show the minimap over the canvas.
   *
   * OFF by default. A minimap earns its space on a twenty-node company
   * reconstruction and costs it on the three-node examples most people open
   * first, so it is offered rather than assumed.
   */
  minimap: boolean;
  /**
   * Name components after a cloud vendor's products.
   *
   * `generic` by default and deliberately so: a student meets "load
   * balancer" first and "ALB" second, and the concept outlives the product
   * name. A vendor is something to switch on once the idea has landed.
   */
  vendor: VendorId;
  /**
   * Colour theme.
   *
   * Three states rather than a boolean, because "follow the system" is a real
   * choice and not the absence of one: a student on a machine that switches
   * to dark at sunset should switch with it unless they have said otherwise.
   * A boolean would have to encode that as null, which is how a toggle ends
   * up with three meanings and no name for the third.
   */
  theme: ThemeChoice;
}

/** What the reader picked. `system` defers to the OS. */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

export const DEFAULT_PREFERENCES: Preferences = {
  tooltips: true,
  sparklines: true,
  snapToGrid: true,
  minimap: false,
  vendor: 'generic',
  // Follow the OS until told otherwise. Picking light as the default would
  // flash a bright page at someone whose machine is set to dark.
  theme: 'system',
};

const STORAGE_KEY = 'breakscale.preferences.v1';

const listeners = new Set<() => void>();
let current: Preferences = load();

/**
 * Read once at startup. Anything malformed falls back to the defaults rather
 * than throwing: a corrupt value in storage must never stop the app booting,
 * and a preference is not worth a blank screen.
 */
function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PREFERENCES;
    const p = parsed as Record<string, unknown>;
    // Each key is validated on its own, so an unknown or corrupt field costs
    // only that one preference rather than the whole set.
    return {
      tooltips: bool(p.tooltips, DEFAULT_PREFERENCES.tooltips),
      sparklines: bool(p.sparklines, DEFAULT_PREFERENCES.sparklines),
      snapToGrid: bool(p.snapToGrid, DEFAULT_PREFERENCES.snapToGrid),
      minimap: bool(p.minimap, DEFAULT_PREFERENCES.minimap),
      vendor: vendor(p.vendor),
      theme: theme(p.theme),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function vendor(v: unknown): VendorId {
  return v === 'aws' || v === 'gcp' || v === 'azure' || v === 'generic'
    ? v
    : DEFAULT_PREFERENCES.vendor;
}

function theme(v: unknown): ThemeChoice {
  return v === 'light' || v === 'dark' || v === 'system'
    ? v
    : DEFAULT_PREFERENCES.theme;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private browsing, a full quota, or storage disabled by policy. The
    // preference still applies for this session; it simply will not be
    // remembered, which is a far better outcome than throwing.
  }
}

export function getPreferences(): Preferences {
  return current;
}

export function setPreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  persist();
  for (const l of listeners) l();
}

export function togglePreference(key: keyof Preferences): void {
  setPreference(key, !current[key]);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Subscribe to the whole set. Re-renders only when something actually changes. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, getPreferences);
}

/**
 * Subscribe to ONE preference.
 *
 * Components that read a single flag should use this: the snapshot is a
 * primitive, so `useSyncExternalStore` bails out of the re-render when an
 * unrelated preference changes.
 */
export function usePreference<K extends keyof Preferences>(key: K): Preferences[K] {
  return useSyncExternalStore(
    subscribe,
    () => current[key],
    () => DEFAULT_PREFERENCES[key],
  );
}

/** Test seam. Resets to defaults and clears storage. */
export function __resetPreferences(): void {
  current = DEFAULT_PREFERENCES;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
  for (const l of listeners) l();
}
