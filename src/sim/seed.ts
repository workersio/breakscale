/* ------------------------------------------------------------------ *
 * Run seeds crossing a trust boundary.
 *
 * A seed travels with a design so a shared run replays the same way, which
 * means it arrives from links, files and saved designs like everything else
 * in a topology. The engine reads it as an unsigned 32-bit integer, so that
 * is the only thing accepted: a seed of 1.5 or -1 would be folded into some
 * other seed by the engine, and the run would quietly not be the one that was
 * shared.
 * ------------------------------------------------------------------ */

/** The seed every run used before seeds were saved, and still the default. */
export const DEFAULT_SEED = 1;

/** Largest seed the engine can take without folding it into another one. */
export const MAX_SEED = 0xffffffff;

/** A seed the engine will use exactly as given, or undefined. */
export function sanitizeSeed(input: unknown): number | undefined {
  return typeof input === 'number' &&
    Number.isInteger(input) &&
    input >= 0 &&
    input <= MAX_SEED
    ? input
    : undefined;
}
