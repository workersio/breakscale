import { describe, expect, it } from 'vitest';
import { GLOSSARY_BY_ID } from './glossary';
import { KIND_TERM } from '../components/nodeVisuals';

/**
 * Guards the JOIN between the interface and the glossary.
 *
 * `Term` renders its children unchanged when handed an id the glossary does
 * not know. That is the right runtime behaviour — a typo must never blank out
 * a number a student is reading — but it makes a broken wiring completely
 * silent: the label simply stops being explainable, and nothing in a
 * typecheck, a build or a screenshot says so.
 *
 * This is not hypothetical. These assertions were written after eight
 * glossary entries were lost to a concurrent edit. The app still compiled,
 * still built, still rendered, and five labels had quietly lost their
 * explanations. Only reading the live DOM caught it.
 *
 * Vite's glob import is used rather than `node:fs` so the test runs under the
 * browser-targeted tsconfig without pulling in Node type definitions, which
 * would mean a new dependency.
 */

/** Every component source, as raw text. */
const SOURCES = import.meta.glob('../components/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Literal ids handed to a <Term>, a `term=` prop, or a `term:` field. */
function referencedIds(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const patterns = [
    /<Term\s+id="([a-z0-9-]+)"/g,
    /\bterm="([a-z0-9-]+)"/g,
    /\bterm:\s*'([a-z0-9-]+)'/g,
    /\bcaptionTerm="([a-z0-9-]+)"/g,
    /\bunitTerm="([a-z0-9-]+)"/g,
  ];

  for (const [path, src] of Object.entries(SOURCES)) {
    if (path.includes('.test.')) continue;
    const name = path.split('/').pop() ?? path;
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        const id = m[1]!;
        const where = found.get(id);
        if (where) where.add(name);
        else found.set(id, new Set([name]));
      }
    }
  }
  return found;
}

describe('glossary wiring', () => {
  it('resolves every term id the interface references', () => {
    const broken: string[] = [];
    for (const [id, files] of referencedIds()) {
      if (!GLOSSARY_BY_ID.has(id)) {
        broken.push(`${id} (used in ${[...files].join(', ')})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('scans a meaningful number of references', () => {
    // A guard on the guard: if a refactor changed the shape of the call
    // sites, the scan above would find nothing and pass vacuously.
    expect(referencedIds().size).toBeGreaterThan(30);
  });

  it('gives every component kind an explanation', () => {
    const broken = Object.entries(KIND_TERM).filter(
      ([, id]) => !GLOSSARY_BY_ID.has(id),
    );
    expect(broken).toEqual([]);
  });

  it('gives every component kind a beginner card', () => {
    // The palette card and the inspector line read these. A kind without
    // one would show a bare name to the student who most needs the words.
    const missing: string[] = [];
    for (const [kind, id] of Object.entries(KIND_TERM)) {
      const intro = GLOSSARY_BY_ID.get(id)?.intro;
      if (!intro) {
        missing.push(kind);
        continue;
      }
      for (const [field, text] of Object.entries(intro)) {
        expect(text.length, `${kind} ${field}`).toBeGreaterThan(10);
        expect(text.length, `${kind} ${field}`).toBeLessThanOrEqual(160);
        expect(text.endsWith('.'), `${kind} ${field} is a sentence`).toBe(true);
        expect(text.includes('\u2014'), `${kind} ${field} has an em dash`).toBe(false);
      }
    }
    expect(missing).toEqual([]);
  });

  it('states independent hit-rate rolls on the cache and CDN inspector copy', () => {
    // Issue #31: the engine is a per-hop coin flip. The inspector blurbs
    // and the hit-rate hint have to say so, or stacking caches reads as a
    // hierarchy the numbers do not model.
    const inspector = Object.entries(SOURCES).find(([path]) =>
      path.endsWith('/Inspector.tsx'),
    )?.[1];
    expect(inspector, 'Inspector.tsx not in the glob').toBeTruthy();
    expect(inspector).toMatch(
      /Each cache rolls its own hit chance, independently of the others/,
    );
    expect(inspector).toMatch(/treating later caches as filters on earlier misses/);
    expect(inspector).toMatch(/rolled independently of every other cache on the path/);
    expect(inspector).toMatch(/Each cache or CDN rolls this chance on its own/);
    expect(inspector).toMatch(
      /Two at 80% leave about 4% of traffic for whatever is behind them/,
    );
  });
});
