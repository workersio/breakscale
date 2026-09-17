import { expect, test, type Page } from '@playwright/test';

/**
 * Screenshot comparison over the examples whose geometry keeps regressing.
 *
 * What each example pins down:
 * - single-server: the three-node baseline. Floating panels and the
 *   annotation note must clear the canvas islands.
 * - cache-aside: four nodes with the side panels open. Scrollbar corners
 *   stay square to the panel they belong to.
 * - multi-region: the only example with stacked section frames, so it is
 *   the one that catches the label plates of two sections colliding (the
 *   lane-gap geometry the preset tests assert numerically).
 *
 * Determinism contract. Every test boots `?preset=<id>&theme=<t>&paused=1
 * &warmup=3000`: the preset loads, the engine advances exactly 3.0
 * simulated seconds from its own seed in fixed steps, and then stays
 * paused. Two runs of the same test on the same platform render the same
 * frame, which is what makes a pixel diff mean "the layout moved" instead
 * of "the simulation moved". See tests/visual/README.md for how baselines
 * are generated and committed per platform.
 */

/** The dev server base URL; every off-origin request (stars, analytics) is aborted. */
const BASE = 'http://localhost:5173';

/** Component and connection counts, straight from each preset's topology. */
const EXAMPLES = {
  'single-server': { components: 3, connections: 2 },
  'cache-aside': { components: 4, connections: 3 },
  'multi-region': { components: 6, connections: 5 },
} as const;

type ExampleId = keyof typeof EXAMPLES;

/**
 * Boot one example and wait until it has settled into the exact state the
 * baselines were captured in.
 *
 * The assertions before the screenshot carry as much of the suite's value
 * as the pixels do: they prove the preset actually loaded (the failure this
 * branch started from was six tests photographing the same page) and that
 * the simulation clock stopped at exactly the warmup mark.
 */
async function bootExample(
  page: Page,
  id: ExampleId,
  theme: 'light' | 'dark',
): Promise<void> {
  await page.route('**/*', (route) =>
    route.request().url().startsWith(BASE) ? route.continue() : route.abort(),
  );

  await page.goto(`/?preset=${id}&theme=${theme}&paused=1&warmup=3000`, {
    waitUntil: 'domcontentloaded',
  });

  await expect(page.locator('.cv-surface')).toBeVisible();

  // The right example is on the canvas: the on-canvas ledger counts exactly
  // the loaded topology, so a wrong or unhandled preset fails here with a
  // readable message instead of as an opaque pixel diff.
  const { components, connections } = EXAMPLES[id];
  const ledger = page.locator('.cv-ledger');
  await expect(ledger).toContainText(`${components} components`);
  await expect(ledger).toContainText(`${connections} connections`);

  // Paused at exactly the warmup mark. If the boot-pause wiring ever breaks,
  // the clock drifts and this is the assertion that says so.
  const clock = page.locator('.cv-ledger-time');
  await expect(clock).toHaveText('3.0s');

  // Fonts are bundled, but their load is asynchronous; capturing before they
  // land would diff every glyph on the page.
  await page.evaluate(() => document.fonts.ready);
  // One 10Hz React render tick, so any post-boot state swap has landed.
  await page.waitForTimeout(250);
  await expect(clock).toHaveText('3.0s');
}

for (const id of Object.keys(EXAMPLES) as ExampleId[]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${id} (${theme})`, async ({ page }) => {
      await bootExample(page, id, theme);
      await expect(page).toHaveScreenshot(`${theme}-${id}.png`, {
        animations: 'disabled',
        caret: 'hide',
        // The frames are deterministic, so only antialiasing dust should
        // differ: a misplaced panel is thousands of pixels, and these
        // ceilings are not what absorbs it.
        maxDiffPixels: 64,
        threshold: 0.2,
      });
    });
  }
}
