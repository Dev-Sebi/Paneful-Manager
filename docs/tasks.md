# Agent Hub task board

Status: `todo` | `doing` | `review` | `done` | `blocked`. A task starts only when its deps are `done`.

## Wave 0 — foundation

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T01 | pnpm workspace (`apps/web`, `apps/server`, `packages/shared`), shared tsconfig/ESLint/Prettier, `pnpm dev` runs web + server | Sonnet | — | done | merged ba1dd9c |
| T02 | `packages/shared`: zod schemas + types (config, preset, session, session state, API + WS messages), defaults incl. port 7337 | Opus | T01 | done | merged |
| T03 | Architecture doc + ADRs: process model, tmux naming, WS protocol, file-write policy, security model | Opus | T02 | done | |
| T04 | Docs skeleton: README, CONTRIBUTING, LICENSE (MIT), issue/PR templates, example preset YAML | Haiku | T01 | done | merged |
| T05 | Design system `docs/design-system/`: tokens.json, Motion.md, components (`AhButton`, `AhTabs`/`AhTab`, `AhStatusBadge`, `AhDialog`) with index.d.ts, README (a11y) and preview | Opus | — | done | merged |

## Wave 1 — core engine

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T10 | Server skeleton: Fastify, YAML config loader + env override, pino, `/health`, graceful shutdown | Sonnet | T02 | done | |
| T11 | Security baseline: 127.0.0.1 bind, Host/Origin checks, per-boot token, `execFile` only, path allowlist helper | Opus | T10 | done | |
| T12 | Session engine: tmux + node-pty, WS streaming, resize, reconnect + scrollback, backpressure, re-adopt after restart | Opus | T10, T03 | done | |
| T13 | Design system → code: theme + CSS vars from tokens.json, animate.css per Motion.md, @fontsource Inter + JetBrains Mono | Sonnet | T01, T05 | done | |
| T14 | CI: GitHub Actions lint, typecheck, unit, Playwright, pnpm cache | Sonnet | T01 | done | |

## Wave 2 — terminals

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T20 | Components `AhButton`, `AhTabs`/`AhTab`, `AhStatusBadge`, `AhDialog` | Sonnet | T13 | done | |
| T21 | `AhTerminalPane`: xterm.js + fit, WS attach, focus, resize, read-only prop | Opus | T12, T20 | done | |
| T22 | App shell: sidebar, tab bar, routes, Pinia stores, empty states | Sonnet | T20 | done | |
| T23 | Split layouts (splitpanes), sizes persisted per tab | Sonnet | T21, T22 | done | merged 77c5cac |
| T24 | Workspace presets: CRUD API (atomic YAML) + UI + autostart | Sonnet | T23, T11 | doing | |
| T25 | Close-tab flow: confirm, kill sessions, "don't ask again" | Sonnet | T22, T12 | done | |
| T26 | Session status via Claude Code hooks (merge, never overwrite) | Opus | T12, T11 | done | merged aaf637d |

## Wave 3 — skills and CLAUDE.md

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T30 | Scope discovery: global, projects, worktrees | Sonnet | T10 | done | |
| T31 | File service: allowlisted scopes, atomic writes, conflict detection, chokidar | Opus | T11, T30 | done | |
| T32 | Monaco editor component (markdown + frontmatter, lazy) | Sonnet | T13 | done | |
| T33 | Skills + CLAUDE.md UI: CRUD across scopes, branch badge | Sonnet | T31, T32 | done | |
| T34 | Worktree helper: copy gitignored files with confirm | Sonnet | T31 | done | |

## Wave 4 — MCP

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T40 | MCP config service across scopes (`claude mcp` via execFile, preserve unknown keys) | Opus | T11, T31 | done | |
| T41 | MCP UI: list, add, edit, remove, env masked | Sonnet | T40, T20 | done | |
| T42 | MCP health check with status badge | Sonnet | T40 | done | merged 979724f |

## Wave 5 — agent teams (flag `experimental.agentTeams`)

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T50 | Spike + ADR: current agent-teams behavior, min version, on-disk formats | Opus | T12 | done | |
| T51 | Team templates (YAML) + launch flow | Opus | T50, T24 | todo | |
| T52 | Read-only live task board | Sonnet | T50 | done | |
| T53 | Map teammates to terminal panes | Opus | T50, T23 | doing | |

## Wave 6 — install and hardening

| ID | Task | Model | Deps | Status | Branch |
|---|---|---|---|---|---|
| T60 | `install.sh`: checks, install, systemd user service, wsl.conf, Windows logon task, idempotent, `--uninstall` | Opus | T10, T12 | done | merged c85083b |
| T61 | Playwright E2E main flows | Sonnet | Waves 2–4 | todo | |
| T62 | Full security review of server and installer | Opus | T60 | todo | |
| T63 | Final docs: install, config reference, screenshots, troubleshooting | Haiku | T60 | todo | |
| T15 | Lint infra: deterministic Vue parsing at root, ignore `.claude/**`, package lint scripts hooked into root lint | Opus | T14 | done | |
