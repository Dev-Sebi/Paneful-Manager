# Installing Paneful Manager

Paneful Manager runs inside WSL2 as two systemd user services: `paneful-manager-tmux.service` owns the tmux server with all sessions, `paneful-manager.service` runs the Node server on `127.0.0.1:<port>` (default `7337`) and serves the web app. `install.sh` sets both up. Plain Linux with systemd works too; the WSL steps are skipped there.

Related: [Configuration](configuration.md), [Troubleshooting](troubleshooting.md), [Architecture](architecture.md).

## Requirements

| Requirement | Why | Check |
| --- | --- | --- |
| WSL2 with systemd | the services are systemd user units | `systemctl --user status` |
| Node.js 22 or later | server runtime (`engines.node` is `>=22`) | `node -v` |
| pnpm 11 or later | only when node-pty has to be compiled (see below); installed with corepack if missing, version from `packageManager` | `pnpm -v` |
| tmux 3.2 or later | session backbone (`new-session -e`) | `tmux -V` |
| `make`, `g++`, `python3` | only when the release's prebuilt node-pty does not load (not x64, or an older glibc than Ubuntu 24.04); node-pty is then compiled on install | `sudo apt-get install -y build-essential python3` |
| git | worktree scopes | `git --version` |
| Claude Code CLI (`claude`) | the default session command; the installer only warns if it is missing | `claude --version` |
| `curl`, `tar`, `gzip`, `sha256sum`, `realpath` | download, unpack, verify and resolve paths | |

## Install

```bash
curl -fsSL https://github.com/Dev-Sebi/Paneful-Manager/releases/latest/download/install.sh | sh
```

The installer downloads the latest published release from the GitHub repository `Dev-Sebi/Paneful-Manager` (the default); the command works once a release has been published ([releasing](releasing.md)). Release tarballs ship the production dependencies with node-pty prebuilt for linux x64, so on WSL2 or Linux x64 with Node 22 no compiler and no pnpm are needed. The repository can be overridden with `PANEFUL_MANAGER_REPO`, for example for a fork:

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

### From a local build

```bash
pnpm install && pnpm build
./install.sh --from-source .                          # a built source checkout
pnpm release:pack                                     # or pack a tarball first
./install.sh --from-source dist/release/paneful-manager-<tag>.tar.gz
```

A source checkout must contain `apps/server/dist/index.js` and `apps/web/dist/index.html`. `pnpm release:pack` (`scripts/release-pack.sh`) builds and writes `dist/release/paneful-manager-<tag>.tar.gz` plus `paneful-manager-<tag>.tar.gz.sha256`; the tag defaults to `v<package version>`. It also bundles the production `node_modules` with node-pty compiled on your machine; `--no-deps` leaves them out. The installer downloads both files and `install.sh` from the GitHub release; the [release workflow](releasing.md) publishes all three as assets.

## Options

| Flag | Effect |
| --- | --- |
| `--version <tag\|latest>` | release to install (default `latest`) |
| `--from-source <path>` | install from a release tarball or a built source checkout instead of downloading |
| `--prefix <dir>` | install directory (default `~/.local/share/paneful-manager`, or `$XDG_DATA_HOME/paneful-manager`) |
| `--port <port>` | server port (default `7337`, or the port of the existing install); saved as `port` in `config.yaml` and in the unit |
| `--no-systemd` | do not install or start the units |
| `--no-wsl-conf` | never offer to change `/etc/wsl.conf` |
| `--no-windows-task` | never offer the Windows logon task |
| `--force` | reinstall the same version; also allows a prefix outside your home directory or a non-empty prefix without install marker |
| `--no-verify` | install a downloaded release that publishes no `.sha256` file |
| `--login-url` | print a new one-time login URL (see [Login URL](#login-url)) and exit |
| `--rollback` | switch back to the previous release |
| `--uninstall` | remove units, installed releases and the Windows task |
| `--purge` | with `--uninstall`: also remove config and state without asking |
| `--dry-run` | print every step, change nothing; confirmations are assumed to be yes |
| `-y`, `--yes` | answer yes to every question |
| `-h`, `--help` | print the help text |

Environment: `PANEFUL_MANAGER_REPO` (`<owner>/<repo>` to download releases from), `GITHUB_TOKEN` or `GH_TOKEN` (token for a private repository, see [Private repository](#private-repository)).

## What the installer changes

| Path or setting | Change | When |
| --- | --- | --- |
| `~/.local/share/paneful-manager/releases/<tag>/` | unpacked release with its bundled production `node_modules`; if the bundled node-pty does not load, they are replaced by `pnpm install --prod --frozen-lockfile` | install, upgrade |
| `~/.local/share/paneful-manager/current`, `previous` | symlinks to the active and the previous release, swapped with `mv -T` | install, upgrade, rollback |
| `~/.local/share/paneful-manager/.paneful-manager-install` | install marker with the active version; uninstall only deletes a prefix that has it | install, rollback |
| `~/.config/paneful-manager/config.yaml` | created with `port: <port>` if missing; `port` updated when `--port` is given | install |
| `~/.local/state/paneful-manager/` | state directory, mode `0700` | install |
| `~/.local/state/paneful-manager/tmux.conf` | copy of `packaging/tmux.conf` | install, upgrade |
| `~/.config/systemd/user/paneful-manager-tmux.service`, `paneful-manager.service` | rendered from `packaging/systemd/` (repo, port, prefix, node and tmux paths, your current `PATH` and `LANG`) | install, upgrade |
| `systemctl --user` | `daemon-reload`, `enable`, `start` the tmux unit, `restart` the server unit | when something changed |
| `loginctl enable-linger $USER` | user services start at boot and keep running without a login session | if lingering is off |
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

The server reads `port` from `config.yaml`; `PANEFUL_MANAGER_PORT` overrides it. `paneful-manager.service` sets `PANEFUL_MANAGER_PORT` to the port the installer used: `--port` if given, otherwise the port of the installed unit, otherwise the `port` in `config.yaml`, otherwise `7337`. `--port` is also written to `config.yaml`, so both agree.

To change the port later, re-run the installer with `--port <port>`. It rewrites the unit and restarts the server. Editing only `config.yaml` has no effect while the unit sets `PANEFUL_MANAGER_PORT`.

## Verify

```bash
systemctl --user status paneful-manager-tmux.service paneful-manager.service
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

WSL does not start when Windows boots, and systemd services do not keep a WSL instance alive. The installer can register the task `paneful-manager-<distro>`, which runs `wsl.exe -d <distro> --exec true` at your Windows logon, so systemd starts Paneful Manager. The task runs as your Windows user without admin rights.

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

Run the installer again. With a newer version it unpacks the release next to the current one, installs dependencies, swaps `current`, restarts `paneful-manager.service` and keeps the old release as `previous`; older releases are removed. The tmux server and all sessions keep running.

With the same version it updates the units only when a value changed (port, `PATH`), otherwise it does nothing. `--force` reinstalls the release.

If `tmux.conf` changed, the installer says so. It applies only after `systemctl --user restart paneful-manager-tmux.service`, which ends all sessions.

## Rollback

```bash
~/.local/share/paneful-manager/current/install.sh --rollback
```

Swaps `current` and `previous` and restarts `paneful-manager.service`. It fails when there is no previous release.

## Uninstall

```bash
~/.local/share/paneful-manager/current/install.sh --uninstall
```

Stops and disables both units (this ends all sessions) and removes the unit files and the Windows logon task. From the prefix it removes only `releases/`, `current`, `previous` and the install marker; the prefix itself is removed only if it is then empty. A prefix without the marker `.paneful-manager-install` is never touched.

The installer asks before removing `~/.config/paneful-manager` (config, presets) and `~/.local/state/paneful-manager` (session state, backups). With `--yes` it keeps them unless `--purge` is given.

If `~/.local/share/agent-hub/.agent-hub-install` exists (a pre-rename install), uninstall also removes the `agent-hub.service` / `agent-hub-tmux.service` units and that prefix's releases.

It never edits `/etc/wsl.conf` and leaves lingering enabled. It prints how to revert both.

## Prefix rules

The prefix is normalized (`realpath -m`) before use. The installer refuses `/`, your home directory, and system directories (`/usr`, `/etc`, `/bin`, `/sbin`, `/lib`, `/var`, `/boot`). A prefix outside your home directory needs `--force`. It does not install into a non-empty directory without the install marker unless `--force` is given.

## node-pty build failure

The installer first tries the node-pty prebuilt in the release. Only when that does not load on your system (not x64, or an older glibc) does it compile node-pty with pnpm. `pnpm install failed. If node-pty failed to build` means that compile failed. Install the build tools (`sudo apt-get install -y build-essential python3`), then re-run the installer with `--force`. After switching Node versions (for example with nvm), re-run with `--force` as well, so node-pty is rebuilt and the unit points at the new `node`.

## Service hardening

`paneful-manager.service` sets `NoNewPrivileges`, `LockPersonality`, `RestrictRealtime` and `RestrictSUIDSGID`. It does not use filesystem sandboxing (`ProtectSystem`, `ProtectHome`, `PrivateTmp`), because the server edits files in the configured project scopes under your home directory. `paneful-manager-tmux.service` has no sandboxing options, because every session inherits them and `NoNewPrivileges` would break `sudo` inside sessions.
