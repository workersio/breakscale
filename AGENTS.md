# Project coding standards

Breakscale is a discrete-event system design simulator for CS students. `src/sim` is a pure
simulation engine with no React, no DOM and no I/O; everything else is the interface around it.

## Communication

- Be succinct. Prefer code over prose.
- Do not explain or teach unless asked.
- Do not summarise your changes afterwards unless asked.
- Do not apologise when corrected; give the correct answer.
- State what you did not verify. An honest gap costs less than a confident wrong claim.

## Correctness

- The numbers the simulator shows must be measured, never approximated. Percentiles come from a
  ring buffer of real request latencies, not from a mean times a constant.
- A component with no meaningful value for a metric shows something else, or nothing. Never a
  plausible-looking number.
- A behaviour is not finished until a script has printed its real output. Paste the numbers.
- Determinism is a contract: same seed and topology means byte-identical snapshots.
- Never modify `src/sim` to make a UI problem go away.

## TypeScript

- Strict mode. No `any`, no non-null assertions without a comment saying why.
- Prefer `const` and `readonly`. Prefer optional chaining and nullish coalescing.
- Avoid allocation on hot paths: `advance()` runs per frame, `snapshot()` at 10Hz.
- Discriminated unions over boolean flags for state that has more than two cases.

## React

- Function components and hooks only. No conditional hooks.
- The engine is mutable state outside React. Hold it in a ref or lazy `useState`, never in a
  dependency array.
- The rAF loop advances every frame; React re-renders at 10Hz. Never `setState` per frame.
- `React.memo` on anything the canvas renders per node or per edge.
- Effects synchronise with external systems. Deriving state in an effect is a bug.

## Naming

- PascalCase for components, interfaces and type aliases.
- camelCase for variables, functions and methods.
- ALL_CAPS for module constants.
- Component kinds are lowercase string literals: `'ratelimiter'`, not `'rateLimiter'`.

## Styling

- All colour comes from tokens in `src/index.css`. No hardcoded hex anywhere else.
- No emoji, glassmorphism, gradient text or glowing shadows.
- Numbers render in the mono stack with tabular figures.
- Transitions are interactive only, 120-200ms, and `prefers-reduced-motion` disables them.
- Text meets WCAG AA. Compute the ratio; do not estimate it.

## Canvas

The pointer layer was rebuilt after capture-on-pointerdown suppressed the browser's synthesized
click and made every overlay button inert. When touching it, preserve:

- `.cv-surface` owns the handlers.
- Hit routing is `data-hit` + `data-id` resolved in one `hitTest`.
- `setPointerCapture` happens only at gesture promotion, wrapped in try/catch.
- Chrome is excluded via `closest('button, input, select, textarea, a, [data-chrome]')`.
- Any floating overlay carries `[data-chrome]` or it will swallow gestures.

Per-kind colours are a specificity trap: `.cv-node` and `[data-kind='cache']` are both 0-1-0, so
source order wins. Never declare `--k-*` in a class rule; fallbacks belong inside `var()`.

## Testing

- Run `bun run test` after every change and fix what breaks. Not `bun test`:
  that runs bun's own runner, which skips the vitest config and its jsdom
  environment, and reports dozens of failures that are not real.
- Test interaction with real `PointerEvent` sequences. `.click()` bypasses the layer that breaks.
- Paced moves are not enough. A three-event flick found a race a 16ms-paced drag did not.
- A backgrounded tab suspends `requestAnimationFrame`; the simulation reads zero and looks broken.
  Check `document.visibilityState` before diagnosing.
- Hard-reload before concluding anything is broken. Stale HMR has caused false diagnoses here.

## Adding a component

1. `NodeKind` in `src/sim/types.ts`
2. Config fields, each with meaning and units in a doc comment
3. A behaviour object in the matching `src/sim/behaviour-*.ts`, including `blocksOnDownstream`: does
   a slot stay held while the node waits on the calls it made?
4. `defaultConfig` entry and label
5. A readout in `readoutFor`, showing what an engineer would watch. Never a field that is
   structurally always zero for that kind.
6. A glossary entry in `src/content/glossary.ts`
7. A test proving it behaves differently from every existing kind

Step 7 is the bar. A kind that is another kind with different defaults does not get added.

## Adding an example

One lesson each. Stable at its default load, under 2 percent errors. Visibly degrades at 2-4x with
the bottleneck being the lesson. No overlapping nodes. A node's ceiling is
`capacity * instances * (1000 / serviceMs)` rps; do that arithmetic before tuning.

Annotate it. Sections mark real architectural tiers and are named for what the tier does, never
for what is inside it ("Starting a stream", not "Services"). One note must name the failure mode
in terms the reader can act on: what to drag, and what happens. A three-box chain gets one note
and no sections. Stacked tiers need `LROW(row, lane)`, because a section's label plate needs 28px
of a 42px row gutter and two padded frames will not both fit. `presets.annotations.test.ts`
asserts the geometry; run it rather than checking by eye, then load the example and look at it.

## Copy

The reader is a first-year student who has not taken a queueing theory course.

- Plain language: "requests waiting in line", not `queueLimit`.
- Sentence case. No unexplained abbreviations.
- Say why a number matters, not only what it is.
- No em dashes. Use a comma, a semicolon, or a second sentence.

## Commands

```bash
bun dev            # dev server on :5173
bun run build      # typecheck + build
bun run test       # vitest. NOT `bun test`, which bypasses the jsdom setup
bun run lint
bun run format
```

A pre-push hook runs all of it. Do not commit; leave that to the maintainer.
