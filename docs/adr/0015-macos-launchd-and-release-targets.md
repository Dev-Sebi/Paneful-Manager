# ADR 0015: macOS with launchd agents and release tarballs per target

- Status: accepted
- Date: 2026-10-28

## Context

Paneful Manager was built for WSL2 and plain Linux with systemd user units; the release shipped one tarball with node-pty compiled for linux x64. The repository goes public with one-line installers for Linux, WSL, macOS and Windows. macOS has no systemd, its `realpath`, `mv`, `tar` and `sha256sum` differ from GNU coreutils, and Apple silicon and Intel Macs need different node-pty addons.

## Decision

- **One `install.sh` for Linux, WSL2 and macOS.** It picks the platform with `uname -s` (`Linux` or `Darwin`; anything else is refused with a pointer to `install.ps1`). WSL detection only applies on Linux. GNU-only calls are replaced: `realpath -m` falls back to a Node one-liner, `mv -T` becomes a rename of a new symlink over the old one through Node, `sha256sum` falls back to `shasum -a 256`.
- **Same XDG-style paths on macOS.** `~/.local/share/paneful-manager`, `~/.config/paneful-manager`, `~/.local/state/paneful-manager`. The server resolves its directories through the XDG variables on every system, so the installer, `--login-url`, scripts and docs agree without a platform switch. `~/Library/Application Support` would be more idiomatic, but would need a second path scheme in the server and every doc.
- **launchd user agents instead of systemd units** (`packaging/launchd/`, rendered with XML-escaped values into `~/Library/LaunchAgents/`):
  - `dev.paneful-manager.tmux` runs `tmux -L paneful-manager -f <state>/tmux.conf start-server` with `RunAtLoad`, `AbandonProcessGroup` and `KeepAlive` `{ SuccessfulExit = false }`. tmux daemonizes; the agent only starts it, like the `Type=forking` unit on Linux. Reloading the agent therefore never ends sessions, and a start while the server already runs is harmless (the client exits 0).
  - `dev.paneful-manager` runs `node <prefix>/current/apps/server/dist/index.js` with `RunAtLoad` and `KeepAlive`, `PANEFUL_MANAGER_PORT`, the XDG variables, `PATH` and `LANG` of the install, and logs to `<state>/logs/server.log`.
  - Loaded with `launchctl bootstrap gui/<uid>` (after `bootout` when it changed); an upgrade runs `launchctl kickstart -k` on the server agent. `--uninstall` boots both out, runs `tmux -L paneful-manager kill-server` (the agent does not own the daemon) and removes the plists.
  - No lingering exists: the agents run while the user is logged in. Over SSH without a desktop login the plists are written and load at the next login.
- **No browser is opened.** The login URL carries a one-time code; `open <url>` would put it into a process's argv, readable by other local users (ADR 0013, ADR 0014). The installer prints it, as on Linux.
- **Release tarballs per target.** `paneful-manager-<tag>-<target>.tar.gz` for `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, each with its `.sha256`, packed and smoke-tested on a native runner (`ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `macos-15-intel`). The Linux addons are compiled on the runner; on macOS node-pty's own prebuild for the platform is kept and every other platform's removed. `release-pack.sh` loads the pruned addon before it packs. A generic `paneful-manager-<tag>.tar.gz` without `node_modules` covers every other system (and older `install.sh` versions that only know that name); `install.sh` installs it with pnpm.
- **Asset choice.** The target is `uname -s` plus the architecture of the installed `node` (`process.arch`), falling back to `uname -m`: the addon must match the Node binary, which differs from `uname -m` for an x64 Node under Rosetta. Anonymous downloads try the target's asset and fall back to the generic one on 404; with a token the API answer is searched for the target's asset first.
- **Smoke tests without services.** The release smoke test installs with `--no-service` (new name of `--no-systemd`, which stays as an alias), starts the server by hand and checks `/api/health`, on Linux and macOS runners alike. Units and agents are covered by `scripts/test-install.sh` with stubbed `systemctl`, `launchctl` and `uname`.

## Consequences

- macOS needs Homebrew (or another source) for Node 22 and tmux 3.2+; the installer prints the `brew install` hints. Compiling node-pty is only needed for an unknown target and then needs `xcode-select --install`.
- launchd has no socket activation that a Node server can use (see ADR 0016), so on macOS the port can be squatted while the server is down; ADR 0014 limits what a squatter gains.
- A crashed tmux daemon is not restarted by launchd (the job already exited successfully); `/api/health` reports `tmux: unavailable` and `launchctl kickstart gui/<uid>/dev.paneful-manager.tmux` starts it again.
- GitHub retires `macos-15-intel` some day; then `darwin-x64` leaves the matrix and Intel Macs use the generic tarball (node-pty's npm package ships darwin-x64 prebuilds, so usually nothing is compiled).
- Not tested on a real Mac by the test suite; the release workflow's macOS jobs run the packed tarball through `install.sh --no-service` and a real server start.

## Alternatives considered

- `tmux -D` (foreground) under a `KeepAlive` agent: launchd would supervise tmux, but every reload of the agent would kill all sessions, and a second start against a running server is not clearly safe.
- `~/Library/Application Support/Paneful Manager`: the space in the path breaks the unquoted-path rule of the units and plists, and the server would need macOS-specific path resolution.
- A Homebrew formula or cask: a second packaging and release channel to maintain; the one-liner works without it.
- One universal macOS tarball with both addons: node-pty loads by `process.arch` anyway, but the per-target scheme is already needed for Linux arm64 and keeps every tarball smaller.
