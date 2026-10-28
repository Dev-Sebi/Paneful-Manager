# Changelog

All notable changes to Paneful Manager. Versions follow [Semantic Versioning](https://semver.org/); before 1.0.0 a minor version may break things.

## 0.1.0 - 2026-10-28

First public release.

- Local web app for Claude Code sessions: terminal tabs with split panes, backed by tmux sessions that survive a server restart
- Workspace presets (YAML) with layouts and autostart, session states from Claude Code hooks
- Editors for skills, CLAUDE.md and MCP servers per global, project and worktree scope
- Experimental agent-team views (off by default)
- One-line installers: `install.sh` for Linux and WSL2 (systemd user units with socket activation) and macOS (launchd user agents), `install.ps1` for Windows (prepares WSL 2 with systemd)
- Release tarballs for linux-x64, linux-arm64, darwin-x64 and darwin-arm64 with a prebuilt node-pty, plus a generic tarball that compiles it
- Loopback-only server on `127.0.0.1` with one-time login URLs
