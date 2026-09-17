# Visual regression tests

Screenshot comparison over the three examples whose layout keeps regressing,
in both themes. Catches the class of bug the 800-odd unit tests cannot see:
a panel rendering in the wrong place, annotation plates colliding in stacked
rows, a scrollbar squaring off a corner.

## What is covered

| Example       | Why this one                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| single-server | The three-node baseline: floating panels and the annotation note must clear the canvas islands.           |
| cache-aside   | Four nodes with side panels open: scrollbar corner geometry.                                              |
| multi-region  | The only example with stacked section frames: catches two label plates colliding (the lane-gap geometry). |

Each runs light and dark. The dark palette is generated and has its own
failure modes, so it is tested rather than assumed.

## Determinism

A pixel diff is only meaningful if the pixels would otherwise be identical.
Every test boots:

```
/?preset=<id>&theme=<light|dark>&paused=1&warmup=3000
```

which loads the example, advances the seeded engine exactly 3.0 simulated
seconds in fixed steps before first paint, and then leaves it paused. Same
URL, same rendered frame. The tests also assert before diffing: the on-canvas
ledger must show the expected component and connection counts, and the clock
must read exactly `3.0s`. If the preset did not load or the sim is running,
the test fails with a readable message instead of an opaque pixel diff.

## Running

```bash
bun test:visual            # run (starts the dev server itself)
bun test:visual:update     # refresh baselines
bun test:visual:ui         # interactive mode
```

On failure, `test-results/` holds the actual, expected and diff images plus a
Playwright trace; the HTML report is in `playwright-report/`. Both are
gitignored, and CI uploads them as artifacts when the job fails.

## Baselines are committed, per platform

Playwright suffixes snapshot names with the platform, so `light-single-server-chromium-win32.png`
and `light-single-server-chromium-linux.png` are two independent baselines in
one folder. Both sets are committed: a change only ever refreshes the
platform you ran it on, which keeps local runs honest and keeps the other
platform's reference stable.

### Refreshing baselines

```bash
bun test:visual:update
```

Then commit the changed PNGs. Refresh ONLY the platform you actually ran on,
and expect the other platform's CI leg to compare against its own unchanged
baselines. A baseline refresh should be its own commit, never mixed with a
code change: a reviewer must be able to tell a layout change from a rebase
of reference pixels.

### Adding a new platform leg (e.g. macOS)

Commit a set of `-darwin` baselines generated on that platform, then add the
Playwright project for it in CI. Linux is the leg CI runs; Windows baselines
exist because the primary maintainer develops there.

### Generating Linux baselines from Windows (WSL2)

The Linux baselines have to come from a Linux renderer. On a Windows machine
with WSL2, three things bite; all three were hit building the committed set.

1. WSL's PATH inherits Windows programs, so `bun` inside WSL resolves to the
   Windows bun.exe and any "Linux" run silently uses the Windows node
   modules. Pin the PATH:
   `export PATH=/usr/local/bin:/usr/bin:/bin`.
2. bun installs only the Windows native bindings, so vite cannot start in
   WSL (`Cannot find native binding ... @rolldown/binding-linux-x64-gnu`).
   Drop the missing binding in by hand:

   ```bash
   curl -fSL -o /tmp/binding.tgz \
     https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-<rolldown version>.tgz
   mkdir -p node_modules/@rolldown/binding-linux-x64-gnu
   tar xzf /tmp/binding.tgz -C node_modules/@rolldown/binding-linux-x64-gnu --strip-components=1
   ```

3. Without sudo, `playwright install` cannot apt-install chromium's runtime
   libraries. Download and unpack them as your user, then point
   `LD_LIBRARY_PATH` at them:

   ```bash
   mkdir -p ~/debs ~/libs && cd ~/debs
   apt-get download libnspr4 libnss3 libasound2t64
   for f in *.deb; do dpkg -x "$f" ~/libs; done
   ```

Then, in one WSL session (the server dies with it otherwise):

```bash
export PATH=/usr/local/bin:/usr/bin:/bin
export LD_LIBRARY_PATH=$HOME/libs/usr/lib/x86_64-linux-gnu
node node_modules/vite/bin/vite.js --port 5173 --strictPort &
node node_modules/@playwright/test/cli.js test
git add tests/visual/layout.test.ts-snapshots/*-linux.png
```
