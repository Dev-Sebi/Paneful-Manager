# Installing Agent Hub

Agent Hub runs inside WSL2 as two systemd user services: `agent-hub-tmux.service` owns the tmux server with all sessions, `agent-hub.service` runs the Node server on `127.0.0.1:<port>` (default `7337`) and serves the web app. `install.sh` sets both up. Plain Linux with systemd works too; the WSL steps are skipped there.

## Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| WSL2 with systemd | the services are systemd user units | `systemctl --user status` |
| Node.js 22 or later | server runtime | `node -v` |
| pnpm | installs the production dependencies; installed with corepack if missing (version from `packageManager`) | `pnpm -v` |
| tmux 3.2 or later | session backbone (`new-session -e`) | `tmux -V` |
| `make`, `g++`, `python3` | node-pty is compiled on install | `sudo apt-get install -y build-essential python3` |
| git | worktree scopes | `git --version` |
| Claude Code CLI (`claude`) | the default session command; the installer only warns if missing | `claude --version` |
| curl, tar, gzip | download and unpack the release | |

## Install

```bash
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | sh
```

`<owner>/<repo>` is the GitHub repository that publishes the releases. The script downloads from the repository in `AGENT_HUB_REPO` (the default in `install.sh` is a placeholder), so set it when you install from a fork:

```bash
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | AGENT_HUB_REPO=<owner>/<repo> sh
```

The installer prints a plan first and asks before it changes anything (questions are read from the terminal, so they work with `curl | sh`). Without a terminal it uses each question's default; pass `--yes` for unattended installs. Run it with `--dry-run` to see every step without changing anything.

Then open `http://127.0.0.1:7337/` (or `http://localhost:7337/`) in a Windows browser. WSL forwards localhost ports to Windows.

### From a local build

```bash
pnpm install && pnpm build
./install.sh --from-source .                      # a built source checkout
pnpm release:pack                                 # or pack a tarball first
./install.sh --from-source dist/release/agent-hub-v0.1.0.tar.gz
```

`pnpm release:pack` (`scripts/release-pack.sh`) builds and writes `dist/release/agent-hub-<tag>.tar.gz` plus `agent-hub-<tag>.tar.gz.sha256`. A release publishes both files and `install.sh` as assets.

## Options

| Flag | Effect |
| --- | --- |
| `--version <tag\|latest>` | release to install (default `latest`) |
| `--from-source <path>` | install from a release tarball or a built source checkout instead of downloading |
| `--prefix <dir>` | install directory (default `~/.local/share/agent-hub`, or `$XDG_DATA_HOME/agent-hub`) |
| `--port <port>` | server port (default `7337`); written to `config.yaml` only if the file is missing |
| `--no-systemd` | do not install or start the units |
| `--no-wsl-conf` | never offer to change `/etc/wsl.conf` |
| `--no-windows-task` | never offer the Windows logon task |
| `--force` | reinstall the same version |
| `--rollback` | switch back to the previous release |
| `--uninstall` | remove units, install directory and Windows task |
| `--purge` | with `--uninstall`: also remove config and state |
| `--dry-run` | print every step, change nothing |
| `-y`, `--yes` | answer yes to every question |
| `-h`, `--help` | help |

## What the installer changes

| Path or setting | Change | When |
| --- | --- | --- |
| `~/.local/share/agent-hub/releases/<tag>/` | unpacked release with production `node_modules` | install, upgrade |
| `~/.local/share/agent-hub/current`, `previous` | symlinks to the active and the previous release, swapped atomically | install, upgrade, rollback |
| `~/.config/agent-hub/config.yaml` | `port: <port>` | only if missing |
| `~/.local/state/agent-hub/` | state directory, mode `0700` | install |
| `~/.local/state/agent-hub/tmux.conf` | copy of `packaging/tmux.conf` | install, upgrade |
| `~/.config/systemd/user/agent-hub-tmux.service`, `agent-hub.service` | rendered from `packaging/systemd/` (prefix, port, node and tmux paths, your current `PATH` and `LANG`) | install, upgrade |
| `systemctl --user` | `daemon-reload`, `enable`, `start` the tmux unit, `restart` the server unit | when something changed |
| `loginctl enable-linger $USER` | user services start at boot and keep running without a login session | if lingering is off |
| `/etc/wsl.conf` | `[boot]` `systemd=true`, merged into the existing file, backup at `/etc/wsl.conf.agent-hub.bak` (sudo) | only if systemd is off and you agree |
| `build-essential python3` (apt, sudo) | build tools for node-pty | only if missing and `--yes` is given |
| Windows Task Scheduler: `AgentHub-<distro>` | runs `wsl.exe -d <distro> --exec true` at your Windows logon | only if you agree |
| `~/.local/bin/pnpm` | corepack shim | only if pnpm is missing and you agree |

All paths follow `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` when they are set. The units pin these values, so the service uses the same directories as the installer.

## Port

The server reads `port` from `config.yaml`; `AGENT_HUB_PORT` overrides it. `agent-hub.service` sets `AGENT_HUB_PORT` to the port the installer used: `--port` if given, otherwise the `port` in an existing `config.yaml`, otherwise `7337`. To change the port later, edit `config.yaml` and re-run the installer, or re-run it with `--port <port>`. A re-run rewrites the units when a value changed and restarts the server.

## Systemd in WSL

WSL starts systemd only with this in `/etc/wsl.conf` (WSL 0.67.6 or later, check with `wsl --version` in Windows):

```ini
[boot]
systemd=true
```

If `systemctl --user` does not work, the installer offers to add it (sudo, other settings are kept, a backup is written) and stops with these steps:

1. In Windows PowerShell: `wsl.exe --shutdown`
2. Open the distro again and re-run the installer with the same options.

On Debian-based distros other than current Ubuntu, also install `systemd` and `systemd-sysv`.

## Keeping WSL running

systemd services do not keep a WSL instance alive. WSL stops a distro that has no open terminal or other client after `instanceIdleTimeout` (default 15 s, `[general]` in `%UserProfile%\.wslconfig`) and the VM after `vmIdleTimeout`. Stopping the distro ends all Agent Hub sessions.

- **Windows logon task (optional).** WSL does not start when Windows boots. The installer can register the task `AgentHub-<distro>`, which runs `wsl.exe -d <distro> --exec true` at your Windows logon, so systemd starts Agent Hub. It runs as your Windows user without admin rights; a console window may flash once. If registration fails (some managed machines block it), create a basic task by hand in Task Scheduler with the same program and arguments, or put a shortcut to `wsl.exe -d <distro> --exec true` into `shell:startup`.
- **Staying up while idle.** To keep the distro running with no terminal open, set `instanceIdleTimeout=-1` under `[general]` in `%UserProfile%\.wslconfig` (or keep a WSL terminal open), then run `wsl.exe --shutdown` once. The installer does not change `.wslconfig`, because it applies to every distro.

## Upgrade

Run the installer again. With a newer version it unpacks the release next to the current one, installs dependencies, swaps `current`, restarts `agent-hub.service` and keeps the old release as `previous`; older releases are removed. The tmux server and all sessions keep running. With the same version it only updates the units when a value changed (port, `PATH`) and otherwise does nothing; `--force` reinstalls the release.

If `tmux.conf` changed, the installer says so: it only applies after `systemctl --user restart agent-hub-tmux.service`, which ends all sessions.

## Rollback

```bash
~/.local/share/agent-hub/current/install.sh --rollback
```

Swaps `current` and `previous` and restarts `agent-hub.service`.

## Uninstall

```bash
~/.local/share/agent-hub/current/install.sh --uninstall
```

Stops and disables both units (this ends all sessions), removes the unit files, the install directory and the Windows logon task. It asks before removing `~/.config/agent-hub` (config, presets) and `~/.local/state/agent-hub` (session state, backups); with `--yes` it keeps them unless `--purge` is given. It never edits `/etc/wsl.conf` and leaves lingering on; it prints how to revert both.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Health check fails, `journalctl --user -u agent-hub` shows `Port 7337 is already in use` | another process uses the port (`ss -ltnp \| grep 7337`); stop it, or pick another port: `install.sh --port 7338` |
| `tmux 3.2 or later is required` | Ubuntu 22.04 and later ship a recent tmux; on older releases upgrade the distro or build tmux from source |
| `pnpm install failed`, node-gyp errors about node-pty | install build tools: `sudo apt-get install -y build-essential python3`, then re-run the installer with `--force`. After switching Node versions (nvm), re-run with `--force` so node-pty is rebuilt and the unit points at the new `node` |
| `systemd is not running in this WSL distro` | see [Systemd in WSL](#systemd-in-wsl); check with `ps -p 1 -o comm=` (must print `systemd`) |
| `systemctl --user` fails although systemd runs | open a new login shell (`wsl.exe -d <distro>`), or check `loginctl user-status` |
| UI loads but sessions do not start, health shows `tmux: unavailable` | `systemctl --user status agent-hub-tmux.service`; start it with `systemctl --user start agent-hub-tmux.service` |
| Sessions fail with `claude: not found` | the units use the `PATH` from install time; re-run the installer from a shell where `claude` is on `PATH`, then `systemctl --user restart agent-hub-tmux.service` (ends running sessions) |
| Sessions are gone after a while | WSL stopped the idle distro, see [Keeping WSL running](#keeping-wsl-running) |

Logs: `journalctl --user -u agent-hub -f`, `journalctl --user -u agent-hub-tmux`.

## Service hardening

`agent-hub.service` sets `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime` and `RestrictSUIDSGID`. Filesystem sandboxing (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`) is left out on purpose: the server edits files anywhere in the configured project scopes under your home directory, and these options need user namespaces that user units do not always have. `agent-hub-tmux.service` has no sandboxing options at all, because every session inherits them (`NoNewPrivileges` would break `sudo` inside sessions).
