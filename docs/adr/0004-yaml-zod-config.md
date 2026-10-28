# ADR 0004: YAML config validated with zod

- Status: accepted
- Date: 2026-10-27

## Context

Users edit the app config and workspace presets by hand and through the UI. The files must be readable, accept comments, and fail loudly on mistakes. Server and client must agree on the shape.

## Decision

- App config at `$XDG_CONFIG_HOME/paneful-manager/config.yaml` (default `~/.config/paneful-manager/config.yaml`), presets at `.../workspaces/<name>.yaml`, one preset per file named after `name`.
- All shapes are zod schemas in `packages/shared`, shared by server and web. User files use loose objects so unknown keys survive a load/save cycle; API bodies and WS frames are strict.
- `PANEFUL_MANAGER_PORT` overrides `port`; invalid values fail startup.
- The server writes YAML through the `yaml` Document API to keep comments and key order.

## Consequences

- One schema gives runtime validation, TypeScript types and readable error messages (`validation_failed` with paths).
- Users can keep notes and newer keys in their files.
- YAML pitfalls (implicit types) are caught by the schemas.

## Alternatives considered

- JSON: no comments, unfriendly for hand-editing.
- TOML: weak for nested lists of tabs and panes.
- JSON Schema + ajv: types and validation would be maintained separately.
