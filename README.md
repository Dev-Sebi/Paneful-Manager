# Agent Hub

[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)

![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

Agent Hub is a local web app for running and organizing Claude Code sessions. It runs inside WSL and gives you terminal tabs with split panes, saved workspace presets, an editor for skills and CLAUDE.md files, MCP server configuration, and experimental agent-team views.

## Features

- Terminal tabs with split panes
- Saved workspace presets (YAML)
- Skills and CLAUDE.md editor for global, project and git-worktree scopes
- MCP server configuration
- Experimental agent-team views

## Install

Inside WSL2 (with systemd, Node.js 22+, tmux 3.2+):

```bash
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
```

Then open `http://127.0.0.1:7337/`. The installer sets up the systemd user services `agent-hub-tmux.service` and `agent-hub.service`; flags, upgrade, rollback, uninstall and troubleshooting are in the [install guide](docs/install.md).

## Development

```bash
git clone <repo-url> agent-hub
cd agent-hub
pnpm install
pnpm dev
```

Open `http://localhost:3000` in your browser (Vite dev server).

## Requirements

- WSL2 with systemd enabled
- Node.js 22 or later
- pnpm 11 or later
- tmux 3.2 or later
- git
- Claude Code CLI

## Configuration

- App config: `~/.config/agent-hub/config.yaml`
- Workspace presets: `~/.config/agent-hub/workspaces/*.yaml`
- Server port: `port` in `config.yaml` (default `7337`); the env var `AGENT_HUB_PORT` overrides it

Example files are in `examples/`.

## Documentation

- [Install guide](docs/install.md)
- [Architecture](docs/architecture.md) (in progress)
- [Contributing](CONTRIBUTING.md)

## License

MIT. See [LICENSE](LICENSE).
