import { useEffect, useState } from 'react';

/**
 * The repo's star count, read from GitHub's public API and cached in
 * localStorage so a reload does not spend the request's share of the
 * unauthenticated rate limit (60/hour, shared across everyone behind the
 * same IP) on a number that has not moved.
 *
 * Fetched after mount, never during it: the source link renders instantly
 * with no count, and the digits fade in whenever the request resolves,
 * seconds later or not at all. Nothing about the page's first paint waits
 * on GitHub.
 */

const REPO = 'workersio/breakscale';
const STORAGE_KEY = 'bs-stars';
/* Five minutes. Long enough that a reader clicking around the app is not
   spending requests against the unauthenticated rate limit, short enough
   that a count climbing during a launch is right by the next page load. */
const STALE_MS = 5 * 60 * 1000;

interface Cached {
  count: number;
  fetchedAt: number;
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cached;
    return typeof parsed.count === 'number' && typeof parsed.fetchedAt === 'number'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCache(count: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ count, fetchedAt: Date.now() }));
  } catch {
    // Storage full or disabled: the count still renders this session, it
    // just refetches next time. Not worth surfacing.
  }
}

/** 1,247 -> "1.2k". Under 1000 stays exact: the round number is the lie, not the rounding. */
export function formatStars(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/**
 * Counts from zero up to `target` once, over roughly a second, and returns
 * the value to render. Null passes straight through, so the button shows
 * nothing at all until the fetch lands.
 *
 * A plain rAF tween rather than a spring library: this is one number on one
 * button, and the project carries no animation dependency worth adding for
 * it. Eased out so the count decelerates into its final value instead of
 * stopping dead, and skipped entirely under prefers-reduced-motion.
 */
export function useCountUp(target: number | null, durationMs = 900): number | null {
  /* Progress of the tween, 0 to 1. Kept as progress rather than as the
     number itself so the effect never has to write a value it could have
     derived: the count below is computed during render from whatever
     progress the last frame left behind. */
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (target === null) return;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    let raf = 0;
    let start = 0;
    const tick = (now: number): void => {
      // First frame sets the clock, so the tween measures from when it
      // actually began rather than from a timestamp taken before the count
      // existed.
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / durationMs);
      setProgress(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  if (target === null) return null;
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return target;
  // Cubic ease-out: fast at first, settling into the real number.
  const value = Math.round(target * (1 - Math.pow(1 - progress, 3)));

  return value;
}

export function useGithubStars(): number | null {
  const [count, setCount] = useState<number | null>(() => readCache()?.count ?? null);

  useEffect(() => {
    // Stale-while-revalidate: the cached count above already rendered, and
    // this refetches anyway unless one just happened. A count that is
    // climbing while people are arriving should correct itself within a
    // page load, not sit on yesterday's number for an hour.
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < STALE_MS) return;

    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stargazers_count?: unknown } | null) => {
        if (cancelled || typeof data?.stargazers_count !== 'number') return;
        setCount(data.stargazers_count);
        writeCache(data.stargazers_count);
      })
      // Offline, rate-limited, blocked by an extension: the button already
      // works with no count, so there is nothing to recover and nothing to
      // show the reader.
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  return count;
}
