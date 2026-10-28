# Installing Paneful Manager

Paneful Manager runs as user services that `install.sh` sets up:

| System | Services | Started |
| --- | --- | --- |
| Linux, WSL2 | systemd user units `paneful-manager-tmux.service` (the tmux server with all sessions), `paneful-manager.socket` (holds `127.0.0.1:<port>` and `[::1]:<port>`), `paneful-manager.service` (the Node server, takes the sockets) | at boot (lingering); WSL: when the distro starts |
| macOS | launchd user agents `dev.paneful-manager.tmux` (starts the tmux server) and `dev.paneful-manager` (the Node server) | at login |
| Windows | `install.ps1` prepares WSL2 with systemd and runs `install.sh` inside the distro | at Windows logon (scheduled task) |

The server listens on `127.0.0.1:<port>` (default `7337`) only and serves the web app.

Related: [Configuration](configuration.md), [Troubleshooting](troubleshooting.md), [Architecture](architecture.md).

## Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| Linux or WSL2 with systemd | the services are systemd user units | `systemctl --user status` |
| macOS 13 or later | the services are launchd user agents; Apple silicon and Intel | `sw_vers` |
| Node.js 22 or later | server runtime (`engines.node` is `>=22`) | `node -v` (macOS: `brew install node`) |
| pnpm 11 or later | only when node-pty has to be compiled (see below); installed with corepack if missing, version from `packageManager` | `pnpm -v` |
| tmux 3.2 or later | session backbone (`new-session -e`) | `tmux -V` (`sudo apt-get install -y tmux`, macOS: `brew install tmux`) |
| `make`, `g++`, `python3` | only when the release has no prebuilt node-pty for your system, or it does not load (an older glibc than Ubuntu 24.04); node-pty is then compiled on install | `sudo apt-get install -y build-essential python3`; macOS: `xcode-select --install` |
| git | worktree scopes | `git --version` (macOS: `xcode-select --install`) |
| Claude Code CLI (`claude`) | the default session command; the installer only warns if it is missing | `claude --version` |
| `curl`, `tar`, `gzip`, `sha256sum` or `shasum` | download, unpack and verify | |

## Install

```bash
curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh | sh
```

The same command works on Linux, in WSL2 and on macOS. On Windows run [`install.ps1`](#windows) in PowerShell instead.

The installer downloads the latest published release from the GitHub repository `Dev-Sebi/Paneful-Manager` (the default); the command works once a release has been published ([releasing](releasing.md)). It picks the tarball for your system and CPU (`uname -s`, and the architecture of the installed `node`, which is what node-pty has to match): `linux-x64`, `linux-arm64`, `darwin-x64` or `darwin-arm64`. These ship the production dependencies with node-pty prebuilt, so no compiler and no pnpm are needed. On any other system, or when a release has no build for yours, it takes the generic tarball and compiles node-pty (see [node-pty build failure](#node-pty-build-failure)). The repository can be overridden with `PANEFUL_MANAGER_REPO`, for example for a fork:

```bash
curl -fsSL https://github.com/<owner>/<repo>/releases/latest/download/install.sh | PANEFUL_MANAGER_REPO=<owner>/<repo> sh
```

The installer prints a plan first and asks before it changes anything. Questions are read from the terminal, so they work with `curl | sh`. Without a terminal every question is answered with no, so nothing privileged happens by accident; pass `--yes` for unattended installs. `--dry-run` prints every step without changing anything.

### Private repository

GitHub answers `404` to anonymous requests for a private repository, so `releases/latest/download/...` does not work there and the installer stops with a hint. Two ways to install anyway:

**a) Installer with a token.** Get `install.sh` from the release with the GitHub CLI, then run it with a token:

```bash
gh release download --repo Dev-Sebi/Paneful-Manager --pattern install.sh
GITHUB_TOKEN=<token> sh install.sh
```

When `GITHUB_TOKEN` (or `GH_TOKEN`) is set, or `gh auth token` works because `gh` is installed and logged in, the installer looks the release up through the GitHub API (`/repos/<repo>/releases/latest`, or `/releases/tags/<tag>` with `--version`) and downloads the tarball and its `.sha256` as API assets. Without a token it uses the anonymous URLs as before. Use a fine-grained personal access token limited to this repository with read-only **Contents** access; nothing more is needed.

The token never leaves the installer process: it is read once from the environment and unset, so no child process (`pnpm`, `node`, `systemctl`) inherits it; `curl` gets the `Authorization` header on stdin (`-H @-`), so it does not appear in the process list; it is never written to disk or printed (unless you trace the installer with `sh -x`). `curl` does not forward the header to the storage host GitHub redirects asset downloads to; the token path needs curl 7.58 or later for that and refuses older versions.

**b) Without a token in the installer.** Download the release with `gh` and install the tarball:

```bash
gh release download --repo Dev-Sebi/Paneful-Manager --pattern 'paneful-manager-*.tar.gz*' --pattern install.sh
sh install.sh --from-source paneful-manager-<tag>.tar.gz
```

The installer verifies the tarball against the `.sha256` next to it. For a specific release, pass its tag: `gh release download <tag> --repo Dev-Sebi/Paneful-Manager ...`.

When the install finishes, the installer prints a login URL. Open it in your browser within 10 minutes (in WSL: a Windows browser; WSL forwards loopback ports to Windows). See [Login URL](#login-url).

### macOS

`install.sh` detects macOS (`uname -s` is `Darwin`) and installs two launchd user agents instead of systemd units. Everything else is the same as on Linux, including the paths: the install goes to `~/.local/share/paneful-manager`, config to `~/.config/paneful-manager`, state to `~/.local/state/paneful-manager` (the XDG variables are honored), because the server resolves its directories the same way on every system.

| Agent | File | Runs |
| --- | --- | --- |
| `dev.paneful-manager.tmux` | `~/Library/LaunchAgents/dev.paneful-manager.tmux.plist` | `tmux -L paneful-manager -f <state>/tmux.conf start-server` at load (`RunAtLoad`); tmux daemonizes and the agent abandons it (`AbandonProcessGroup`), so reloading the agent never ends sessions; `KeepAlive` retries a failed start only |
| `dev.paneful-manager` | `~/Library/LaunchAgents/dev.paneful-manager.plist` | `node <prefix>/current/apps/server/dist/index.js` with `RunAtLoad` and `KeepAlive` (restarted when it exits) |

Logs go to `~/.local/state/paneful-manager/logs/server.log` and `tmux.log`. The agents are loaded with `launchctl bootstrap gui/<uid>`, so they run while you are logged in (also after a reboot, from your next login on). Over SSH without a desktop login the installer writes them and says they load at your next login. Check them with `launchctl print gui/$(id -u)/dev.paneful-manager`.

Not on macOS: no lingering, no WSL or Windows steps, and no socket activation (see [ADR 0016](adr/0016-systemd-socket-activation.md#macos)): while the server is down, another local user could bind the port, which the [device login](adr/0014-device-login-against-origin-squatting.md) limits. Background: [ADR 0015](adr/0015-macos-launchd-and-release-targets.md).

### Windows

In PowerShell (no administrator rights needed unless WSL itself is missing):

```powershell
irm https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.ps1 | iex
```

`install.ps1` works in Windows PowerShell 5.1 and PowerShell 7. It never closes your console and stops with exact next steps whenever something needs you:

1. **WSL 2.** Checks `wsl.exe --status`. Without WSL it prints the steps: `wsl --install` in an administrator PowerShell, restart Windows, create your Linux user, run the one-liner again. In an administrator PowerShell it offers to run `wsl --install --no-distribution` itself, then stops for the restart.
2. **Distro.** Takes `PANEFUL_MANAGER_DISTRO`, otherwise your default distro (asks when there are several; `docker-desktop` distros are skipped). Without one it offers `wsl --install -d Ubuntu`, then stops so you can create your Linux user. A WSL 1 distro is refused with the `wsl --set-version <distro> 2` hint; a distro whose default user is root asks first.
3. **systemd.** When PID 1 of the distro is not `systemd`, it asks, then runs `install.sh --enable-wsl-systemd` in the distro as root (merges `[boot]` `systemd=true` into `/etc/wsl.conf`, writes a backup) and `wsl --shutdown`, which stops all running distros, and checks again.
4. **Install.** Downloads `install.sh` of the same release inside the distro and runs it with `--yes --no-wsl-conf --no-windows-task` (plus `--port`, `--version` from the options). Its output, including the login URL, appears in PowerShell.
5. **Logon task.** Registers the task `paneful-manager-<distro>` (see [Windows logon task](#windows-logon-task)); `install.sh` is told not to, so it exists once.

Options are environment variables, since `irm | iex` cannot pass arguments; set them in the same PowerShell first, for example `$env:PANEFUL_MANAGER_PORT = '7400'`:

| Variable | Effect |
| --- | --- |
| `PANEFUL_MANAGER_DISTRO` | distro to install into |
| `PANEFUL_MANAGER_PORT` | server port (`install.sh --port`) |
| `PANEFUL_MANAGER_VERSION` | release tag to install (default latest) |
| `PANEFUL_MANAGER_REPO` | `<owner>/<repo>` to download from |
| `PANEFUL_MANAGER_YES=1` | answer yes to every question |
| `PANEFUL_MANAGER_DRY_RUN=1` | print every step and run `install.sh --dry-run`; changes nothing |
| `PANEFUL_MANAGER_UNINSTALL=1` | run `install.sh --uninstall` in the distro and remove the logon task |
| `PANEFUL_MANAGER_NO_WINDOWS_TASK=1` | never create or remove the logon task |

A downloaded `install.ps1` takes the same as switches: `powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall` (`-Yes`, `-DryRun`, `-NoWindowsTask`, `-Distro <name>`, `-Port <port>`, `-Version <tag>`); then the exit code tells the result. `irm | iex` itself is not subject to the execution policy. If `irm` fails with a TLS error on an old Windows PowerShell, run `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` first. Background: [ADR 0017](adr/0017-windows-installer.md).

**Default user.** If the distro logs in as root, create a user in it (`adduser <name>`), set `[user]` `default=<name>` in `/etc/wsl.conf`, run `wsl --shutdown` and run the one-liner again.

### From a local build

```bash
pnpm install && pnpm build
./install.sh --from-source .                          # a built source checkout
pnpm release:pack                                     # or pack a tarball first
./install.sh --from-source dist/release/paneful-manager-<tag>-<target>.tar.gz
```

A source checkout must contain `apps/server/dist/index.js` and `apps/web/dist/index.html`. `pnpm release:pack` (`scripts/release-pack.sh`) builds and writes `dist/release/paneful-manager-<tag>-<target>.tar.gz` plus its `.sha256`, where `<target>` is this machine (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`); the tag defaults to `v<package version>`. It bundles the production `node_modules` with node-pty for this machine; `--no-deps` leaves them out and writes the generic `paneful-manager-<tag>.tar.gz`. The [release workflow](releasing.md) publishes one tarball per target, the generic one, `install.sh` and `install.ps1`.

## Options

| Flag | Effect |
| --- | --- |
| `--version <tag\|latest>` | release to install (default `latest`) |
| `--from-source <path>` | install from a release tarball or a built source checkout instead of downloading |
| `--prefix <dir>` | install directory (default `~/.local/share/paneful-manager`, or `$XDG_DATA_HOME/paneful-manager`) |
| `--port <port>` | server port (default `7337`, or the port of the existing install); saved as `port` in `config.yaml` and in the unit |
| `--no-service` | do not install or start the systemd units or launchd agents (`--no-systemd` still works) |
| `--no-wsl-conf` | never offer to change `/etc/wsl.conf` |
| `--no-windows-task` | never offer the Windows logon task |
| `--force` | reinstall the same version; also allows a prefix outside your home directory or a non-empty prefix without install marker |
| `--no-verify` | install a downloaded release that publishes no `.sha256` file |
| `--login-url` | print a new one-time login URL (see [Login URL](#login-url)) and exit |
| `--enable-wsl-systemd` | WSL only: merge `[boot]` `systemd=true` into `/etc/wsl.conf` (sudo unless root, backup written), then exit; `install.ps1` uses it |
| `--rollback` | switch back to the previous release |
| `--uninstall` | remove units or agents, installed releases and the Windows task (not with `--no-windows-task`) |
| `--purge` | with `--uninstall`: also remove config and state without asking |
| `--dry-run` | print every step, change nothing; confirmations are assumed to be yes |
| `-y`, `--yes` | answer yes to every question |
| `-h`, `--help` | print the help text |

Environment: `PANEFUL_MANAGER_REPO` (`<owner>/<repo>` to download releases from), `GITHUB_TOKEN` or `GH_TOKEN` (token for a private repository, see [Private repository](#private-repository)).

## What the installer changes

| Path or setting | Change | When |
| --- | --- | --- |
| `~/.local/share/paneful-manager/releases/<tag>/` | unpacked release with its bundled production `node_modules`; if the bundled node-pty does not load, they are replaced by `pnpm install --prod --frozen-lockfile` | install, upgrade |
| `~/.local/share/paneful-manager/current`, `previous` | symlinks to the active and the previous release, swapped atomically (a new link renamed over the old one) | install, upgrade, rollback |
| `~/.local/share/paneful-manager/.paneful-manager-install` | install marker with the active version; uninstall only deletes a prefix that has it | install, rollback |
| `~/.config/paneful-manager/config.yaml` | created with `port: <port>` if missing; `port` updated when `--port` is given | install |
| `~/.local/state/paneful-manager/` | state directory, mode `0700` | install |
| `~/.local/state/paneful-manager/tmux.conf` | copy of `packaging/tmux.conf` | install, upgrade |
| `~/.config/systemd/user/paneful-manager-tmux.service`, `paneful-manager.socket`, `paneful-manager.service` | rendered from `packaging/systemd/` (repo, port, prefix, node and tmux paths, your current `PATH` and `LANG`); the socket lists `[::1]` only when the machine has IPv6 loopback | install, upgrade (Linux, WSL) |
| `systemctl --user` | `daemon-reload`, `enable` all three, `start` the tmux unit, `restart` the server unit; when the socket unit changed (new port, first install): `stop` the server, `restart` the socket, `start` the server | when something changed (Linux, WSL) |
| `~/Library/LaunchAgents/dev.paneful-manager.tmux.plist`, `dev.paneful-manager.plist` | rendered from `packaging/launchd/` (same values, XML-escaped) | install, upgrade (macOS) |
| `launchctl` | `bootstrap gui/<uid>` an agent that changed or is not loaded (`bootout` first), `kickstart -k` the server agent after an upgrade | when something changed (macOS) |
| `~/.local/state/paneful-manager/logs/` | `server.log`, `tmux.log` of the agents | install (macOS) |
| `loginctl enable-linger $USER` | user services start at boot and keep running without a login session | if lingering is off (Linux, WSL) |
| `/etc/wsl.conf` | `[boot]` `systemd=true`, merged into the existing file; if the file existed, a backup is written to `/etc/wsl.conf.paneful-manager.bak` (sudo) | only if systemd is off and you agree |
| `build-essential`, `python3` (apt, sudo) | build tools for node-pty | only if node-pty has to be compiled, the tools are missing and `--yes` is given |
| Windows Task Scheduler: `paneful-manager-<distro>` | runs `wsl.exe -d <distro> --exec true` at your Windows logon | only if you agree |
| `~/.local/bin/pnpm` | corepack shim | only if node-pty has to be compiled, pnpm is missing or older than the major version in `packageManager`, and you agree |

All paths follow `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` when they are set to absolute paths. The units pin the config and state values, so the server uses the same directories as the installer.

## Login URL

Other users on the same machine can reach the loopback port too, so every API request must prove it comes from you. Background: [ADR 0013](adr/0013-access-key-against-local-users.md) and [ADR 0014](adr/0014-device-login-against-origin-squatting.md).

A browser logs in once with a login URL:

```bash
~/.local/share/paneful-manager/current/install.sh --login-url
#   http://127.0.0.1:7337/#login=<one-time code>
```

The code works once and expires after 10 minutes; it sits in `~/.local/state/paneful-manager/login-code` (mode `0600`) until it is used. Opening the URL makes the browser create a device key that it can use but never reveal, and registers it with the server. Later visits to `http://127.0.0.1:7337/` sign a fresh challenge with that key; nothing secret is kept in the browser's storage. The login survives server restarts and upgrades.

- One login URL per browser profile: for a second browser, print a new one.
- Always use `127.0.0.1`, never `localhost`: `localhost` may resolve to `::1`, where another user on the machine can listen on the same port. Under any other host name the app does not log in and asks you to switch to `127.0.0.1`.
- Without a login, or after a logout, the app shows only the hint to open a login URL. A used or expired URL shows "already used or has expired".
- The installer does not open the browser: a browser started with the URL as an argument would show the code in the process list.
- Log every browser out: `rm ~/.local/state/paneful-manager/devices.json` (in a checkout `pnpm login-url --reset`). The server refuses the session keys of removed devices from the next request on; no restart needed.
- Older builds kept the access key itself in the browser (`#key=` login URLs); the app deletes it on the first start, so each browser needs one new login URL after the upgrade.
- In a source checkout, `pnpm login-url` prints a URL for the server port; `pnpm login-url --port 3000` prints it for the Vite dev server.

## Port

The server reads `port` from `config.yaml`; `PANEFUL_MANAGER_PORT` overrides it. `paneful-manager.service` (macOS: the `dev.paneful-manager` agent) sets `PANEFUL_MANAGER_PORT` to the port the installer used: `--port` if given, otherwise the port of the installed unit or agent, otherwise the `port` in `config.yaml`, otherwise `7337`. `--port` is also written to `config.yaml`, so both agree. Under systemd the port the server really uses is the one of `paneful-manager.socket` (the server logs a warning when it differs from the configured one).

To change the port later, re-run the installer with `--port <port>`. It rewrites the units (the socket too) or the agent and restarts the server. Editing only `config.yaml` has no effect while the unit sets `PANEFUL_MANAGER_PORT`.

## Socket activation

On Linux and WSL `paneful-manager.socket` binds `127.0.0.1:<port>` and `[::1]:<port>` and hands both to `paneful-manager.service` (`LISTEN_FDS`). The port then stays bound while the server restarts, is upgraded or crashed, so no other local user can listen there in between (the squatting window of [ADR 0014](adr/0014-device-login-against-origin-squatting.md)). A connection while the server is down waits until systemd has started it again. The server serves the `127.0.0.1` socket and answers every request on `[::1]` with `403` and a hint to open `http://127.0.0.1:<port>/`; `[::1]` is held only so nobody else can take it. On a machine without IPv6 loopback the socket unit leaves `[::1]` out, since nobody can bind it there either. Started by hand (`node .../index.js`, `pnpm dev`) the server listens itself as before. Details: [ADR 0016](adr/0016-systemd-socket-activation.md).

## Verify

```bash
systemctl --user status paneful-manager-tmux.service paneful-manager.socket paneful-manager.service
launchctl print gui/$(id -u)/dev.paneful-manager        # macOS
curl -fsS http://127.0.0.1:7337/api/health
```

`/api/health` is the only route that needs no credential. Scripts use the access key, a random value the server writes once to `~/.local/state/paneful-manager/access-key` (mode `0600`, readable only by you and root; browsers never get it). Pass it on stdin so it does not show up in `curl`'s command line:

```bash
printf 'X-Paneful-Key: %s\n' "$(cat ~/.local/state/paneful-manager/access-key)" | curl -fsS -H @- http://127.0.0.1:7337/api/sessions
```

The health answer is JSON with `status` (`ok`), `name` (`Paneful Manager`), `version`, `protocolVersion`, `uptimeSec` and `tmux` (`available` or `unavailable`). `tmux: unavailable` means the tmux unit is not running; see [Troubleshooting](troubleshooting.md#tmux-unavailable).

Logs:

```bash
journalctl --user -u paneful-manager -f
journalctl --user -u paneful-manager-tmux -f
tail -f ~/.local/state/paneful-manager/logs/server.log    # macOS
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

`install.ps1` does all of this from Windows: it runs `install.sh --enable-wsl-systemd` as root in the distro (no sudo password needed), asks before `wsl --shutdown` and continues with the install. systemd in WSL needs WSL 0.67.6 or later (the Microsoft Store version; `wsl --update`).

## Windows logon task

WSL does not start when Windows boots, and systemd services do not keep a WSL instance alive. `install.ps1`, or `install.sh` run inside WSL, can register the task `paneful-manager-<distro>`, which runs `wsl.exe -d <distro> --exec true` at your Windows logon, so systemd starts Paneful Manager. The task runs as your Windows user without admin rights.

The task only boots the distro. Without `instanceIdleTimeout=-1` in `%UserProfile%\.wslconfig` (see [Keeping WSL running](#keeping-wsl-running)), WSL stops the distro again after `instanceIdleTimeout`. The installer reports whether your `.wslconfig` already sets it, and it does not edit `.wslconfig`.

If the registration fails, create a basic task by hand in Task Scheduler with the same program (`wsl.exe`) and arguments (`-d <distro> --exec true`).

## Keeping WSL running

WSL stops a distro that has no open terminal or other client after `instanceIdleTimeout` (default 15 s, `[general]` in `%UserProfile%\.wslconfig`) and the VM after `vmIdleTimeout` (`[wsl2]`). Stopping the distro ends all Paneful Manager sessions.

To keep the distro running with no terminal open, set this in `%UserProfile%\.wslconfig`, then run `wsl.exe --shutdown` once:

```ini
[general]
instanceIdleTimeout=-1
```

## Upgrade

Run the installer again. With a newer version it unpacks the release next to the current one, installs dependencies, swaps `current`, restarts `paneful-manager.service` (macOS: `launchctl kickstart -k` of the server agent) and keeps the old release as `previous`; older releases are removed. The tmux server and all sessions keep running; under systemd the socket keeps the port bound meanwhile.

With the same version it updates the units or agents only when a value changed (port, `PATH`), otherwise it does nothing. `--force` reinstalls the release.

If `tmux.conf` changed, the installer says so. It applies only after `systemctl --user restart paneful-manager-tmux.service` (macOS: `tmux -L paneful-manager kill-server`, then `launchctl kickstart gui/$(id -u)/dev.paneful-manager.tmux`), which ends all sessions.

## Rollback

```bash
~/.local/share/paneful-manager/current/install.sh --rollback
```

Swaps `current` and `previous` and restarts the server. It fails when there is no previous release.

## Uninstall

```bash
~/.local/share/paneful-manager/current/install.sh --uninstall
```

Stops and disables the three units (this ends all sessions) and removes the unit files and the Windows logon task. On macOS it unloads both agents, stops the tmux server (`tmux -L paneful-manager kill-server`, the agent does not own it) and removes the plists. On Windows run the one-liner with `$env:PANEFUL_MANAGER_UNINSTALL = '1'`, which runs this inside the distro and removes the logon task. From the prefix it removes only `releases/`, `current`, `previous` and the install marker; the prefix itself is removed only if it is then empty. A prefix without the marker `.paneful-manager-install` is never touched.

The installer asks before removing `~/.config/paneful-manager` (config, presets) and `~/.local/state/paneful-manager` (session state, backups). With `--yes` it keeps them unless `--purge` is given.

If `~/.local/share/agent-hub/.agent-hub-install` exists (a pre-rename install), uninstall also removes the `agent-hub.service` / `agent-hub-tmux.service` units and that prefix's releases.

It never edits `/etc/wsl.conf` and leaves lingering enabled. It prints how to revert both. `--no-windows-task` leaves the logon task alone (`install.ps1` removes it itself).

## Prefix rules

The prefix is normalized before use (`realpath -m`, or the same with Node where that is missing, as on macOS). The installer refuses `/`, your home directory, and system directories (`/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/var`, `/boot`, on macOS also `/System`, `/Library`, `/Applications`, `/private`). A prefix outside your home directory needs `--force`. It does not install into a non-empty directory without the install marker unless `--force` is given.

## node-pty build failure

The installer first tries the node-pty prebuilt in the release tarball of your target. Only when there is none (another system or CPU) or it does not load (an older glibc than Ubuntu 24.04) does it compile node-pty with pnpm. `pnpm install failed. If node-pty failed to build` means that compile failed. Install the build tools (`sudo apt-get install -y build-essential python3`; macOS: `xcode-select --install`), then re-run the installer with `--force`. After switching Node versions (for example with nvm), re-run with `--force` as well, so node-pty is rebuilt and the unit points at the new `node`.

## Service hardening

`paneful-manager.service` requires `paneful-manager.socket` and sets `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime` and `RestrictSUIDSGID`. It does not use filesystem sandboxing (`ProtectSystem`, `ProtectHome`, `PrivateTmp`), because the server edits files in the configured project scopes under your home directory. `paneful-manager-tmux.service` has no sandboxing options, because every session inherits them and `NoNewPrivileges` would break `sudo` inside sessions.
