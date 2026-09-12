# Visual Regression Tests

This directory contains visual regression tests using Playwright to ensure UI elements render correctly on the canvas.

## Tests focused on layout geometry bugs:

- **Floating panels clearing islands** - panels shouldn't overlap canvas islands
- **Annotation plates in stacked rows** - plates should stack without overlapping
- **Scrollbar corner geometry** - scrollbars shouldn't break panel corners

## Running the tests

### Run all visual regression tests

```bash
bun test:visual
```

### Update baseline screenshots

If you've made intentional visual changes or need to refresh baselines:

```bash
bun test:visual:update
```

This will capture new screenshots and save them as baselines. The next run will compare against these new baselines.

### UI mode (interactive view)

Run tests with a visual interface to see exactly what's failing:

```bash
bun test:visual:ui
```

### Bisect failed tests

Use Playwright's built-in bisect to find which commit broke the visual test:

```bash
bun test:visual:bisect
```

### Generate initial baselines

Capture screenshots from scratch for a clean baseline:

```bash
bun generate-baselines
```

This runs directly against the dev server at http://localhost:5173 and saves screenshots to `playwright-baselines/`.

## What are baselines?

**Baseline images** are the reference screenshots stored in `playwright-baselines/`. They represent what "correct" rendering looks like.

On each test run play:

1. The test opens the page at the defined viewport (1920×1080)
2. Takes a screenshot
3. Compares it pixel-by-pixel to the corresponding baseline
4. If the difference exceeds `threshold` (currently 15%), the test FAILS

## Threshold and tolerance

The visual regression uses:

- **Threshold**: 15% maximum pixel difference
- **Max diff pixels**: 5000 (arbitrary soft cap for noise)
- **Animations disabled**: Screenshots are captured with CSS animations turned off

This handles:

- Subtle animation micro-adjustments
- Antialiasing differences between platforms
- Small lighting changes in dark mode shaders

## CI integration

These tests run on PRs. If any visual regression fails:

1. The test suite fails
2. GitHub Actions shows the visual comparison
3. Developers must approve the visual change or fix the rendering bug

To disable the automated failure:

```bash
# In a PR, comment "visual regression tests" to skip
```
