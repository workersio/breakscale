import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression tests over the canvas layout.
 *
 * Run with `bun test:visual`; refresh baselines with `bun test:visual:update`
 * on YOUR platform, per tests/visual/README.md. The determinism contract
 * that makes pixel diffs meaningful lives in tests/visual/layout.test.ts.
 */
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    // Fixed viewport so a layout change, not a resize, is what a diff shows.
    viewport: { width: 1920, height: 1080 },
    // Each test forces its theme with a `theme` boot parameter; this only
    // pins what `system` resolves to, so the default palette is identical
    // on every machine that runs the suite.
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      // The device profile is spread FIRST and the viewport restated after
      // it: Desktop Chrome carries its own 1280x720 viewport, which would
      // otherwise silently override the one above, since project settings
      // win over top-level ones.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
  ],

  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
