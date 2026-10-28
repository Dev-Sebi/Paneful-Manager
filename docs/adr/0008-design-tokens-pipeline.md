# ADR 0008: Design tokens pipeline

- Status: accepted
- Date: 2026-10-27

## Context

The Vue components, the Vuetify theme and the xterm.js terminals must share one visual language in dark and light themes, with checked contrast. Hand-copied colors drift.

## Decision

- `docs/design-system/tokens.json` in DTCG format is the only hand-edited source of colors, spacing, radius, typography, shadow, opacity, motion and z-index.
- A build script resolves aliases and generates a Vuetify theme (`dark` default, `light`), `tokens.css` with `--pm-*` variables per theme, and an xterm.js theme from `color.terminal.*`. Generated files carry a header and are never edited.
- Components use tokens only; motion follows `Motion.md`. Token changes get a `CHANGELOG.md` entry.

## Consequences

- One change in `tokens.json` updates UI, Vuetify and terminals together.
- Unresolvable aliases fail the build.
- Contributors need the generator to see token changes.

## Alternatives considered

- Vuetify theme as source of truth: does not cover CSS variables and the xterm theme.
- Style Dictionary: capable, but a heavy dependency for one small token set; the custom script stays small.
- Hard-coded SCSS variables: no theme switching at runtime, no machine-readable source.
