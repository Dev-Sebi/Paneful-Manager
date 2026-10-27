# Changelog

All notable changes to the Agent Hub design system. Format: newest first, one section per version.

## 0.1.0 - 2026-10-27

### Added

- `tokens.json` in W3C DTCG format: neutral (0..1000), accent and hue palettes; themed semantic colors (`bg`, `fg`, `accent`, `secondary`, `danger`, `border`, `status`, `terminal`) with `dark` / `light` values; `space`, `radius`, `font`, `shadow`, `motion`, `z`.
- Vuetify theme mapping in `color.$extensions["dev.agenthub.vuetify"]`.
- WCAG AA contrast table for both themes in `README.md`.
- `Motion.md` with principles, the allowed animate.css set and per-use-case timing.
- Component specs with `index.d.ts`, `README.md` and `preview.html`: `AhButton`, `AhTabs` / `AhTab`, `AhStatusBadge`, `AhDialog`, `AhTerminalPane` (spec only).
