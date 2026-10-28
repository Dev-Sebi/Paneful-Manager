# Changelog

All notable changes to the Paneful Manager design system. Format: newest first, one section per version.

## Unreleased

### Added

- Generator added: `apps/web/scripts/generate-tokens.ts` emits `tokens.css`, `theme.ts` (Vuetify + xterm themes) and `tokens.ts` from `tokens.json`; `tokens:check` fails on stale output.

## 0.2.0 - 2026-10-27

### Added

- Tokens `color.border.strong` (3:1 boundaries), `color.secondary.hover`, `color.shadow`, `opacity.disabled`, `opacity.scrim`, `motion.duration.spinner`.
- `PmTabPanel` contract and the `pm-tab-<value>` / `pm-tabpanel-<value>` id convention.
- `PmDialog` `blockedMessage` helper line for blocked closes.

### Changed

- Vuetify mapping moved to the root `$extensions`, split into `colors` and `variables`; now covers `surface-bright`, `surface-light`, `primary-darken-1`, `secondary-darken-1`, `border-color`, `shadow-color`, `disabled-opacity`.
- Generator contract: `defaultTheme: 'dark'`, `dark: true/false` per theme.
- `color.border.default` is decorative only; 3:1 applies to `border.strong` and `border.focus`.
- `color.bg.selected` aliases palette steps directly.
- Motion: `headShake` keyframes overridden to translateX only; spinner exempt from reduced motion.
- `PmTabs`: close button is a sibling of the `role="tab"` element, last in the `li`; `Delete` or `Backspace` closes.
- `PmDialog`: close (x) last in DOM; scrim uses `opacity.scrim`.
- `PmTerminalPane`: browser-safe, configurable shortcuts; split direction defined; maximized pane on `z.overlay`; `fontSize` is a px number.
- `PmButton`: disabled uses `opacity.disabled` only; spinner duration from `motion.duration.spinner`.
- Previews: per-state status marker shapes.

## 0.1.0 - 2026-10-27

### Added

- `tokens.json` in W3C DTCG format: neutral (0..1000), accent and hue palettes; themed semantic colors (`bg`, `fg`, `accent`, `secondary`, `danger`, `border`, `status`, `terminal`) with `dark` / `light` values; `space`, `radius`, `font`, `shadow`, `motion`, `z`.
- Vuetify theme mapping in `$extensions["dev.paneful-manager.vuetify"]`.
- WCAG AA contrast table for both themes in `README.md`.
- `Motion.md` with principles, the allowed animate.css set and per-use-case timing.
- Component specs with `index.d.ts`, `README.md` and `preview.html`: `PmButton`, `PmTabs` / `PmTab`, `PmStatusBadge`, `PmDialog`, `PmTerminalPane` (spec only).
