import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The engine is pure TypeScript with no DOM, so most tests need no
    // environment at all. Component tests opt into jsdom per file with a
    // // @vitest-environment jsdom pragma.
    environment: 'node',
    // Repairs localStorage for the files that opt into jsdom. See the
    // comment in vitest.setup.ts for what Node broke and why.
    setupFiles: ['./vitest.setup.ts'],
    // mcp/src too: its tests import only the engine and this repo's own
    // modules, so they run on a clean checkout without mcp's dependencies.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'mcp/src/**/*.test.ts'],
    // Many component tests mount the whole App and run the engine for
    // simulated seconds; on a busy machine or runner that passes 5s.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/sim/**', 'src/content/**', 'src/components/format.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
