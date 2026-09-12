/**
 * Script to generate baseline screenshots for visual regression.
 *
 * Usage:
 * bun tests/visual/generate-baselines.ts
 *
 * This will run the examples and capture their screen as baselines,
 * which become the reference images for future regression tests.
 */

import { chromium, Browser, Page } from '@playwright/test';

/**
 * Examples to capture for baseline. Currently using the 3 layout-related examples.
 */
const EXAMPLES = [
  { name: 'Single Server', slug: 'Single Server' },
  { name: 'Load Balanced', slug: 'Load Balanced' },
  { name: 'Cache Aside', slug: 'Cache Aside' },
];

/**
 * Capture baseline screenshots for all examples.
 */
async function generateBaselines() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'light', // Baseline with light theme
    ignoreHTTPSErrors: true,
  });

  for (const example of EXAMPLES) {
    console.log(`\n📸 Capturing baseline for example: "${example.name}"`);

    const page = await context.newPage();
    try {
      // Navigate to the example
      const url = `/?preset=${example.slug}`;
      console.log(`  → Loading ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for canvas to settle
      await page.waitForTimeout(2000);

      // Take screenshot
      const outputPath = `playwright-baselines/${example.slug}.png`;
      await page.screenshot({
        path: outputPath,
        fullPage: true,
        animations: 'disabled',
      });

      console.log(`  ✓ Saved to ${outputPath}`);
    } catch (error) {
      console.error(`  ✗ Failed for "${example.name}":`, error);
    } finally {
      await page.close();
    }
  }

  await context.close();
  await browser.close();
  console.log('\n✅ Baseline screenshots generated successfully!');
}

// Run when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateBaselines().catch(console.error);
}
