import { test, expect } from '@playwright/test';

/**
 * Visual regression tests for layout components.
 *
 * These tests verify that UI elements render in the correct positions:
 * - Floating panels clear the islands (don't overlap)
 * - Annotation plates stack properly in multi-row sections
 * - Scrollbars render cleanly without breaking geometry
 *
 * To update baselines:
 * - Light theme: bunx playwright test -g "Layout" --update-snapshots
 * - Dark theme: bunx playwright test -g "Layout" -g "Dark" --update-snapshots
 */

test.describe.configure({ mode: 'parallel' });

test.describe('Layout - Light Theme', () => {
  /**
   * Test that floating panels don't overlap the canvas area on light theme.
   */
  test('Floating Panels Clear Islands (Light)', async ({ page }) => {
    await page.goto('/?preset=single-server');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('light/single-server.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });

  /**
   * Test that annotation plates stack correctly on light theme.
   */
  test('Annotation Plates Stack Correctly (Light)', async ({ page }) => {
    await page.goto('/?preset=load-balanced');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('light/load-balanced.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });

  /**
   * Test that scrollbars render correctly on light theme.
   */
  test('Scrollbar Corner Geometry (Light)', async ({ page }) => {
    await page.goto('/?preset=cache-aside');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('light/cache-side.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });
});

test.describe('Layout - Dark Theme', () => {
  /**
   * Test that dark mode palette rendering is correct.
   * Dark mode has its own failure modes due to generated colors.
   */
  test('Floating Panels Clear Islands (Dark)', async ({ page }) => {
    // Switch to dark theme via UI (using settings toggle)
    await page.goto('/?preset=single-server#theme=dark');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('dark/single-server.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });

  /**
   * Test annotation plates in dark mode.
   */
  test('Annotation Plates Stack Correctly (Dark)', async ({ page }) => {
    await page.goto('/?preset=load-balanced#theme=dark');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('dark/load-balanced.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });

  /**
   * Test scrollbars in dark mode.
   */
  test('Scrollbar Corner Geometry (Dark)', async ({ page }) => {
    await page.goto('/?preset=cache-aside#theme=dark');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('dark/cache-side.png', {
      threshold: 0.15,
      maxDiffPixels: 5000,
      animations: 'disabled',
      fullPage: true,
    });
  });
});
