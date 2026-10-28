# Agent Hub

[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)

![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

Agent Hub is a local web app for running and organizing Claude Code sessions. It runs inside WSL and shows the sessions as terminal tabs with split panes in the browser.

<!-- screenshot: Agent Hub with a preset tab of four Claude Code panes side by side -->

## Features

- Terminal tabs with split panes, backed by tmux sessions that survive a server restart
- Saved workspace presets (YAML) with layouts and optional autostart
- Session state (working, waiting, idle, error) from Claude Code hooks
- Skills and CLAUDE.md editor for global, project and git-worktree scopes
- MCP server configuration
- Experimental agent-team views (off by default)

## Experimental: agent teams

Agent teams build on an experimental Claude Code feature (Claude Code 2.1.309 or later) and are off by default. Set `experimental.agentTeams: true` in `~/.config/agent-hub/config.yaml` (or through `PATCH /api/config`) to get the Teams view: a read-only task board per team and team templates (`~/.config/agent-hub/teams/<name>.yaml`, see [examples/teams](examples/teams)). Launching a template starts the lead session; Claude Code spawns the teammates from the generated first prompt, so names and models are requests, not guarantees. Upstream changes can break this at any time; see [ADR 0010](docs/adr/0010-agent-teams.md) and [ADR 0012](docs/adr/0012-team-templates.md). Reference: [team templates and agent teams](docs/configuration.md#agent-teams-experimental).

## Quick start

Inside WSL2 with systemd, Node.js 22 or later and tmux 3.2 or later (the installer adds pnpm if it is missing):

```bash
curl -fsSL https://github.com/agent-hub/agent-hub/releases/latest/download/install.sh | sh
```

The installer shows a plan and asks before it changes anything. It sets up the systemd user services `agent-hub-tmux.service` and `agent-hub.service`. Then open `http://127.0.0.1:7337/` in your Windows browser.

Flags, the list of changes, upgrade, rollback and uninstall are in the [install guide](docs/install.md).

## Documentation

- [Install guide](docs/install.md): requirements, installer flags, what changes on the system, upgrade and uninstall
- [Configuration](docs/configuration.md): `config.yaml` keys, environment variables, file locations, preset reference
- [Troubleshooting](docs/troubleshooting.md): symptoms, causes and fixes
- [Architecture](docs/architecture.md): components, process model, security model, session states
- [Documentation index](docs/README.md): all documents, including the decision records and the design system
- [Contributing](CONTRIBUTING.md)

## Development

```bash
git clone <repo-url> agent-hub
cd agent-hub
pnpm install
pnpm dev
```

Open `http://localhost:3000` in your browser (Vite dev server). The API server listens on the configured port (default `7337`); the Vite proxy forwards to `AGENT_HUB_PORT` or `7337`, so set `AGENT_HUB_PORT` when `config.yaml` uses another port.

## Requirements

- WSL2 with systemd enabled (or plain Linux with systemd)
- Node.js 22 or later
- pnpm 11 or later
- tmux 3.2 or later
- git
- Claude Code CLI

## Configuration

- App config: `~/.config/agent-hub/config.yaml`
- Workspace presets: `~/.config/agent-hub/workspaces/*.yaml`
- Server port: `port` in `config.yaml` (default `7337`); the environment variable `AGENT_HUB_PORT` overrides it

Example files are in `examples/`. All keys are listed in the [configuration reference](docs/configuration.md).

## License

MIT. See [LICENSE](LICENSE).
