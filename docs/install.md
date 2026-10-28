# Installing Agent Hub

Agent Hub runs inside WSL2 as two systemd user services: `agent-hub-tmux.service` owns the tmux server with all sessions, `agent-hub.service` runs the Node server on `127.0.0.1:<port>` (default `7337`) and serves the web app. `install.sh` sets both up. Plain Linux with systemd works too; the WSL steps are skipped there.

Related: [Configuration](configuration.md), [Troubleshooting](troubleshooting.md), [Architecture](architecture.md).

## Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| WSL2 with systemd | the services are systemd user units | `systemctl --user status` |
| Node.js 22 or later | server runtime (`engines.node` is `>=22`) | `node -v` |
| pnpm 11 or later | installs the production dependencies; installed with corepack if missing, version from `packageManager` | `pnpm -v` |
| tmux 3.2 or later | session backbone (`new-session -e`) | `tmux -V` |
| `make`, `g++`, `python3` | node-pty is compiled on install | `sudo apt-get install -y build-essential python3` |
| git | worktree scopes | `git --version` |
| Claude Code CLI (`claude`) | the default session command; the installer only warns if it is missing | `claude --version` |
| `curl`, `tar`, `gzip`, `sha256sum`, `realpath` | download, unpack, verify and resolve paths | |

## Install

```bash
curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh | sh
```

The installer downloads from the GitHub repository `Dev-Sebi/Paneful-Manager` (the default). The repository can be overridden with `AGENT_HUB_REPO`, for example for a fork:

```bash
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | AGENT_HUB_REPO=<owner>/<repo> sh
```

The installer prints a plan first and asks before it changes anything. Questions are read from the terminal, so they work with `curl | sh`. Without a terminal every question is answered with no, so nothing privileged happens by accident; pass `--yes` for unattended installs. `--dry-run` prints every step without changing anything.

When the install finishes, open `http://127.0.0.1:7337/` or `http://localhost:7337/` in a Windows browser. WSL forwards localhost ports to Windows.

### From a local build

```bash
pnpm install && pnpm build
./install.sh --from-source .                          # a built source checkout
pnpm release:pack                                     # or pack a tarball first
./install.sh --from-source dist/release/agent-hub-<tag>.tar.gz
```

A source checkout must contain `apps/server/dist/index.js` and `apps/web/dist/index.html`. `pnpm release:pack` (`scripts/release-pack.sh`) builds and writes `dist/release/agent-hub-<tag>.tar.gz` plus `agent-hub-<tag>.tar.gz.sha256`; the tag defaults to `v<package version>`. The installer downloads both files and `install.sh` from the GitHub release, so a release must publish all three as assets.

## Options

| Flag | Effect |
| --- | --- |
| `--version <tag\|latest>` | release to install (default `latest`) |
| `--from-source <path>` | install from a release tarball or a built source checkout instead of downloading |
| `--prefix <dir>` | install directory (default `~/.local/share/agent-hub`, or `$XDG_DATA_HOME/agent-hub`) |
| `--port <port>` | server port (default `7337`, or the port of the existing install); saved as `port` in `config.yaml` and in the unit |
| `--no-systemd` | do not install or start the units |
| `--no-wsl-conf` | never offer to change `/etc/wsl.conf` |
| `--no-windows-task` | never offer the Windows logon task |
| `--force` | reinstall the same version; also allows a prefix outside your home directory or a non-empty prefix without install marker |
| `--no-verify` | install a downloaded release that publishes no `.sha256` file |
| `--rollback` | switch back to the previous release |
| `--uninstall` | remove units, installed releases and the Windows task |
| `--purge` | with `--uninstall`: also remove config and state without asking |
| `--dry-run` | print every step, change nothing; confirmations are assumed to be yes |
| `-y`, `--yes` | answer yes to every question |
| `-h`, `--help` | print the help text |

Environment: `AGENT_HUB_REPO` (`<owner>/<repo>` to download releases from).

## What the installer changes

| Path or setting | Change | When |
| --- | --- | --- |
| `~/.local/share/agent-hub/releases/<tag>/` | unpacked release with production `node_modules` (`pnpm install --prod --frozen-lockfile`) | install, upgrade |
| `~/.local/share/agent-hub/current`, `previous` | symlinks to the active and the previous release, swapped with `mv -T` | install, upgrade, rollback |
| `~/.local/share/agent-hub/.agent-hub-install` | install marker with the active version; uninstall only deletes a prefix that has it | install, rollback |
| `~/.config/agent-hub/config.yaml` | created with `port: <port>` if missing; `port` updated when `--port` is given | install |
| `~/.local/state/agent-hub/` | state directory, mode `0700` | install |
| `~/.local/state/agent-hub/tmux.conf` | copy of `packaging/tmux.conf` | install, upgrade |
| `~/.config/systemd/user/agent-hub-tmux.service`, `agent-hub.service` | rendered from `packaging/systemd/` (repo, port, prefix, node and tmux paths, your current `PATH` and `LANG`) | install, upgrade |
| `systemctl --user` | `daemon-reload`, `enable`, `start` the tmux unit, `restart` the server unit | when something changed |
| `loginctl enable-linger $USER` | user services start at boot and keep running without a login session | if lingering is off |
| `/etc/wsl.conf` | `[boot]` `systemd=true`, merged into the existing file; if the file existed, a backup is written to `/etc/wsl.conf.agent-hub.bak` (sudo) | only if systemd is off and you agree |
| `build-essential`, `python3` (apt, sudo) | build tools for node-pty | only if missing and `--yes` is given |
| Windows Task Scheduler: `AgentHub-<distro>` | runs `wsl.exe -d <distro> --exec true` at your Windows logon | only if you agree |
| `~/.local/bin/pnpm` | corepack shim | only if pnpm is missing or older than the major version in `packageManager`, and you agree |

All paths follow `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` when they are set to absolute paths. The units pin the config and state values, so the server uses the same directories as the installer.

## Port

The server reads `port` from `config.yaml`; `AGENT_HUB_PORT` overrides it. `agent-hub.service` sets `AGENT_HUB_PORT` to the port the installer used: `--port` if given, otherwise the port of the installed unit, otherwise the `port` in `config.yaml`, otherwise `7337`. `--port` is also written to `config.yaml`, so both agree.

To change the port later, re-run the installer with `--port <port>`. It rewrites the unit and restarts the server. Editing only `config.yaml` has no effect while the unit sets `AGENT_HUB_PORT`.

## Verify

```bash
systemctl --user status agent-hub-tmux.service agent-hub.service
curl -fsS http://127.0.0.1:7337/api/health
```

The health answer is JSON with `status` (`ok`), `name` (`Agent Hub`), `version`, `protocolVersion`, `uptimeSec` and `tmux` (`available` or `unavailable`). `tmux: unavailable` means the tmux unit is not running; see [Troubleshooting](troubleshooting.md#tmux-unavailable).

Logs:

```bash
journalctl --user -u agent-hub -f
journalctl --user -u agent-hub-tmux -f
```

## Systemd in WSL

WSL starts systemd only with this in `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Check with `ps -p 1 -o comm=`, which must print `systemd`. If `systemctl --user` does not work, the installer offers to add the setting (sudo; other settings are kept; a backup is written when the file exists) and then stops with these steps:

1. In Windows PowerShell: `wsl.exe --shutdown`
2. Open the distro again and re-run the installer with the same options.

The installer exits with status 0 at this point. The release is already installed, but the units are not written or started until the second run.

## Windows logon task

WSL does not start when Windows boots, and systemd services do not keep a WSL instance alive. The installer can register the task `AgentHub-<distro>`, which runs `wsl.exe -d <distro> --exec true` at your Windows logon, so systemd starts Agent Hub. The task runs as your Windows user without admin rights.

The task only boots the distro. Without `instanceIdleTimeout=-1` in `%UserProfile%\.wslconfig` (see [Keeping WSL running](#keeping-wsl-running)), WSL stops the distro again after `instanceIdleTimeout`. The installer reports whether your `.wslconfig` already sets it, and it does not edit `.wslconfig`.

If the registration fails, create a basic task by hand in Task Scheduler with the same program (`wsl.exe`) and arguments (`-d <distro> --exec true`).

## Keeping WSL running

WSL stops a distro that has no open terminal or other client after `instanceIdleTimeout` (default 15 s, `[general]` in `%UserProfile%\.wslconfig`) and the VM after `vmIdleTimeout` (`[wsl2]`). Stopping the distro ends all Agent Hub sessions.

To keep the distro running with no terminal open, set this in `%UserProfile%\.wslconfig`, then run `wsl.exe --shutdown` once:

```ini
[general]
instanceIdleTimeout=-1
```

## Upgrade

Run the installer again. With a newer version it unpacks the release next to the current one, installs dependencies, swaps `current`, restarts `agent-hub.service` and keeps the old release as `previous`; older releases are removed. The tmux server and all sessions keep running.

With the same version it updates the units only when a value changed (port, `PATH`), otherwise it does nothing. `--force` reinstalls the release.

If `tmux.conf` changed, the installer says so. It applies only after `systemctl --user restart agent-hub-tmux.service`, which ends all sessions.

## Rollback

```bash
~/.local/share/agent-hub/current/install.sh --rollback
```

Swaps `current` and `previous` and restarts `agent-hub.service`. It fails when there is no previous release.

## Uninstall

```bash
~/.local/share/agent-hub/current/install.sh --uninstall
```

Stops and disables both units (this ends all sessions) and removes the unit files and the Windows logon task. From the prefix it removes only `releases/`, `current`, `previous` and the install marker; the prefix itself is removed only if it is then empty. A prefix without the marker `.agent-hub-install` is never touched.

The installer asks before removing `~/.config/agent-hub` (config, presets) and `~/.local/state/agent-hub` (session state, backups). With `--yes` it keeps them unless `--purge` is given.

It never edits `/etc/wsl.conf` and leaves lingering enabled. It prints how to revert both.

## Prefix rules

The prefix is normalized (`realpath -m`) before use. The installer refuses `/`, your home directory, and system directories (`/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/var`, `/boot`). A prefix outside your home directory needs `--force`. It does not install into a non-empty directory without the install marker unless `--force` is given.

## node-pty build failure

`pnpm install failed. If node-pty failed to build` means node-pty could not be compiled. Install the build tools (`sudo apt-get install -y build-essential python3`), then re-run the installer with `--force`. After switching Node versions (for example with nvm), re-run with `--force` as well, so node-pty is rebuilt and the unit points at the new `node`.

## Service hardening

`agent-hub.service` sets `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime` and `RestrictSUIDSGID`. It does not use filesystem sandboxing (`ProtectSystem`, `ProtectHome`, `PrivateTmp`), because the server edits files in the configured project scopes under your home directory. `agent-hub-tmux.service` has no sandboxing options, because every session inherits them and `NoNewPrivileges` would break `sudo` inside sessions.
