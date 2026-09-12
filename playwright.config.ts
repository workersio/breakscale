import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright visual regression tests
 *
 * Run tests:
 * - Test only: bunx playwright test
 * - With screenshot comparison: bunx playwright test --update-snapshots
 * - UI mode: bunx playwright test --ui
 *
 * Visual regression is measured by pixel differences. We'll configure it
 * to pass if the visual change is subtle (handles rendering tweaks).
 */
export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false, // Tests are independent of each other
  retries: 0,
  workers: 1,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry', // Show full trace only on first retry
    // Fixed viewport to ensure consistent rendering across runs
    viewport: { width: 1920, height: 1080 },
    // Fixed theme for visual regression: we test both light and dark modes
    ignoresNotFoundErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // WebServer configuration to run the dev server during tests
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: process.env.CI !== 'true',
    timeout: 120000,
  },
});
