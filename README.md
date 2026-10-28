# Paneful Manager

[![CI](https://github.com/Dev-Sebi/Paneful-Manager/actions/workflows/ci.yml/badge.svg)](https://github.com/Dev-Sebi/Paneful-Manager/actions/workflows/ci.yml)

![Status: early development](https://img.shields.io/badge/status-early%20development-orange)

Paneful Manager is a local web app for running and organizing Claude Code sessions. It runs on Linux, inside WSL on Windows, and on macOS, and shows the sessions as terminal tabs with split panes in the browser.

![Paneful Manager with a preset tab of four Claude Code panes](docs/images/workspace-four-panes.png)

## Features

- Terminal tabs with split panes, backed by tmux sessions that survive a server restart
- Saved workspace presets (YAML) with layouts and optional autostart
- Session state (working, waiting, idle, error) from Claude Code hooks
- Skills and CLAUDE.md editor for global, project and git-worktree scopes
- MCP server configuration
- Experimental agent-team views (off by default)

## Experimental: agent teams

Agent teams build on an experimental Claude Code feature (Claude Code 2.1.309 or later) and are off by default. Set `experimental.agentTeams: true` in `~/.config/paneful-manager/config.yaml` (or through `PATCH /api/config`) to get the Teams view: a read-only task board per team and team templates (`~/.config/paneful-manager/teams/<name>.yaml`, see [examples/teams](examples/teams)). Launching a template starts the lead session; Claude Code spawns the teammates from the generated first prompt, so names and models are requests, not guarantees. Upstream changes can break this at any time; see [ADR 0010](docs/adr/0010-agent-teams.md) and [ADR 0012](docs/adr/0012-team-templates.md). Reference: [team templates and agent teams](docs/configuration.md#agent-teams-experimental).

## Install

| System | Command |
| --- | --- |
| Linux, WSL2 | `curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh \| sh` |
| macOS | `curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh \| sh` |
| Windows (PowerShell) | `irm https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.ps1 \| iex` |

Prerequisites:

- **Linux / WSL2:** systemd (WSL: `systemd=true` in `/etc/wsl.conf`; the installer offers to set it), Node.js 22 or later, tmux 3.2 or later (`sudo apt-get install -y tmux`), git, the Claude Code CLI (`claude`).
- **macOS:** Node.js 22 or later (`brew install node@22`), tmux 3.2 or later (`brew install tmux`), git (`xcode-select --install`), the Claude Code CLI. Runs as launchd user agents, so it starts when you log in.
- **Windows:** Windows 10 2004 or later, or Windows 11. The script checks WSL 2 (and tells you how to install it, which needs an administrator PowerShell and a restart), picks or installs an Ubuntu distro, enables systemd there and runs the Linux installer inside it. Node.js, tmux and the Claude Code CLI are needed inside the distro. Options are environment variables, for example `$env:PANEFUL_MANAGER_PORT = '7400'` before the command.

On x64 and arm64 (Linux and macOS) the release ships a prebuilt node-pty, so no compiler is needed; anything else compiles it on install. Every installer shows a plan and asks before it changes anything.

### Open the login URL

At the end the installer prints a one-time login URL such as `http://127.0.0.1:7337/#login=<code>`. Copy it into the browser you use for Paneful Manager (on Windows: your Windows browser; WSL forwards the port) within 10 minutes. It works once; the installer never opens the browser itself, because a browser started with the URL would show the code in the process list. For another browser, or later, print a new one:

```bash
~/.local/share/paneful-manager/current/install.sh --login-url          # Linux, WSL, macOS
wsl -- ~/.local/share/paneful-manager/current/install.sh --login-url   # Windows PowerShell
```

Always use `127.0.0.1`, not `localhost`. Flags, the list of changes, upgrade, rollback and uninstall are in the [install guide](docs/install.md).

## Documentation

- [Install guide](docs/install.md): requirements, installer flags, what changes on the system, upgrade and uninstall
- [Configuration](docs/configuration.md): `config.yaml` keys, environment variables, file locations, preset reference
- [Troubleshooting](docs/troubleshooting.md): symptoms, causes and fixes
- [Architecture](docs/architecture.md): components, process model, security model, session states
- [Documentation index](docs/README.md): all documents, including the decision records and the design system
- [Contributing](CONTRIBUTING.md)

## Development

```bash
git clone <repo-url> paneful-manager
cd paneful-manager
pnpm install
pnpm dev
```

Open the URL from `pnpm login-url --port 3000` in your browser (Vite dev server; a one-time login code, see [Login URL](docs/install.md#login-url)), later `http://127.0.0.1:3000` is enough. The API server listens on the configured port (default `7337`); the Vite proxy forwards to `PANEFUL_MANAGER_PORT` or `7337`, so set `PANEFUL_MANAGER_PORT` when `config.yaml` uses another port.

## Requirements

- Linux with systemd, WSL2 with systemd enabled, or macOS
- Node.js 22 or later
- pnpm 11 or later
- tmux 3.2 or later
- git
- Claude Code CLI

## Configuration

- App config: `~/.config/paneful-manager/config.yaml`
- Workspace presets: `~/.config/paneful-manager/workspaces/*.yaml`
- Server port: `port` in `config.yaml` (default `7337`); the environment variable `PANEFUL_MANAGER_PORT` overrides it

Example files are in `examples/`. All keys are listed in the [configuration reference](docs/configuration.md).

## License

MIT. See [LICENSE](LICENSE).
