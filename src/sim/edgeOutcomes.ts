/**
 * Slots of the per-edge outcome tally the canvas draws its traffic dots from.
 *
 * The tally is opt-in and lives beside the snapshot, never in it: replays and
 * share links pin snapshot bytes, and a renderer's appetite for detail must
 * not move them. Every slot is a per-second rate over the same trailing window
 * as `edgeFlow`, so slots compare with each other and with the wire's label.
 *
 * Attempts are booked when a call is sent; outcomes when the caller hears
 * back. Both are counted per crossing of the edge, so a call retried twice is
 * three attempts and three outcomes.
 */

/** First attempts sent across the edge, including ones a cut or loss stops. */
export const EO_FIRST = 0;
/** Retries sent across the edge: the same call sent again after a failure. */
export const EO_RETRY = 1;
/** Calls the caller heard back from with a success. */
export const EO_OK = 2;
/** Calls that failed at or below the target, timeouts included. */
export const EO_FAILED = 3;
/** Calls the target turned away at the door: a full line, a full pool, a limit. */
export const EO_REFUSED = 4;
/** Calls dropped crossing a lossy link. The target never saw them. */
export const EO_LOST = 5;
/** Calls that could not cross a cut link. The target never saw them. */
export const EO_CUT = 6;

export const EDGE_OUTCOME_SLOTS = 7;
