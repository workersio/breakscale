import { ID_PARAM } from './share/store';

/**
 * What the address bar says is open: a challenge, or an example nobody has
 * changed yet. Nothing here is stored; the URL is only ever a description
 * of what is on screen, so a copied address opens the same thing.
 */

export const CHALLENGE_PARAM = 'challenge';
export const EXAMPLE_PARAM = 'example';

/** The example an `?example=<id>` link names, if the URL carries one. */
export function exampleParam(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get(EXAMPLE_PARAM);
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

export interface Route {
  /** The brief that has the canvas, or null for the reader's own design. */
  challengeId: string | null;
  /** The example on the canvas, untouched, or null. Ignored inside a brief. */
  exampleId: string | null;
  /**
   * The canvas no longer shows the share link on the URL, so the link goes:
   * boot puts a link first, and a reload would open it over the example.
   */
  dropShare: boolean;
}

/**
 * `href` with its query saying `route`, every other parameter kept. The
 * challenge wins over the example: a brief's canvas carries its example's
 * id, but it is the brief that is open.
 */
export function routedHref(href: string, route: Route): string {
  const url = new URL(href);
  const q = url.searchParams;
  if (route.challengeId) q.set(CHALLENGE_PARAM, route.challengeId);
  else q.delete(CHALLENGE_PARAM);
  const example = route.challengeId ? null : route.exampleId;
  if (example) q.set(EXAMPLE_PARAM, example);
  else q.delete(EXAMPLE_PARAM);
  if (route.dropShare) {
    url.hash = '';
    q.delete(ID_PARAM);
  }
  return url.toString();
}

/** A link that opens this brief, and nothing else, on this site. */
export function challengeLink(href: string, id: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(CHALLENGE_PARAM, id);
  return url.toString();
}
