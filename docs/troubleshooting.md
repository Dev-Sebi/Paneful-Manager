# Troubleshooting

Each table maps a symptom to its cause and fix. Messages in quotes are the exact text printed by the server or the installer. Replace `<port>` with your server port (default `7337`).

Related: [Install guide](install.md), [Configuration](configuration.md).

Useful first checks:

```bash
systemctl --user status agent-hub-tmux.service agent-hub.service
curl -fsS http://127.0.0.1:<port>/api/health
journalctl --user -u agent-hub -n 50
```

## Server does not start

| Symptom | Cause | Fix |
| --- | --- | --- |
| Log shows ``Port 7337 is already in use. Change `port` in config.yaml or set AGENT_HUB_PORT.`` | another process listens on the port | `ss -ltnp \| grep 7337` shows the process. Stop it, or move Agent Hub: `~/.local/share/agent-hub/current/install.sh --port 7338` (rewrites the unit and `config.yaml`, restarts the server). |
| Server stops with `Invalid config in <absolute path of config.yaml>:` followed by one `- <key>: <message>` line per key | a key has a wrong type or value | fix the listed key (see [Configuration](configuration.md#configyaml)) and restart the service. |
| Server stops with `Invalid YAML in ...` | syntax error in `config.yaml` | fix the YAML, then `systemctl --user restart agent-hub.service`. |
| Server stops with `Invalid AGENT_HUB_PORT "...": expected an integer between 1 and 65535` | the environment variable is not a valid port | unset it or set a valid port. |
| Log shows `Backup directory ... must be outside the scope ...` | the backup directory (default `~/.local/state/agent-hub/backups`) lies inside a project or the Claude config directory | move the state directory with `XDG_STATE_HOME` or remove the project from `projects`. |
| Health check of the installer fails: `No answer on http://127.0.0.1:<port>/api/health after 20s` | the server did not start | `systemctl --user status agent-hub.service` and `journalctl --user -u agent-hub -n 50`; the messages above apply. |

## tmux unavailable

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/api/health` returns `"tmux": "unavailable"`; new sessions fail with HTTP 503 `tmux_unavailable` ("tmux server is not running") | the tmux server for socket `agent-hub` is not running. The server never starts tmux itself. | `systemctl --user start agent-hub-tmux.service`. If it fails, `systemctl --user status agent-hub-tmux.service` and `journalctl --user -u agent-hub-tmux` show why. |
| Installer stops with `tmux 3.2 or later is required` | tmux is missing or older than 3.2 | `sudo apt-get install -y tmux`. Ubuntu 22.04 and later ship a recent enough version; on older releases upgrade the distro or build tmux. |
| A new pane exits right away with `env: 'claude': No such file or directory` | the units use the `PATH` from install time, which had no `claude` | re-run the installer from a shell where `claude` is on `PATH`, then `systemctl --user restart agent-hub-tmux.service` (this ends all running sessions). |

## Requests fail with 401 or 403

The server checks the Host header, the Origin header, the access key and a per-start token. See [Security model](architecture.md#security-model).

API calls from a shell need the access key; pass it on stdin, so it never appears in a command line:

```bash
printf 'X-Agent-Hub-Key: %s\n' "$(cat ~/.local/state/agent-hub/access-key)" | curl -fsS -H @- http://127.0.0.1:<port>/api/sessions
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| The app shows "Open the login URL once in this browser" | this browser has no access key for `http://127.0.0.1:<port>`, or the key was rotated | print the URL with `~/.local/share/agent-hub/current/install.sh --login-url` and open it in this browser. See [Login URL](install.md#login-url). |
| 401 `login_required` ("Missing or invalid access key; open the login URL once") | the request has no `X-Agent-Hub-Key` header or an old key | the web app shows the login hint, see the row above. Scripts send the key from `~/.local/state/agent-hub/access-key` as shown above. |
| `--login-url` prints `No access key yet` | the server has not started since the install | start it (`systemctl --user start agent-hub.service`) and run `--login-url` again. |
| The app shows "Open Agent Hub at http://127.0.0.1:<port>/ instead" | the page was opened as `localhost` or `[::1]`; the app keeps the key only on `127.0.0.1`, because another local user can listen on `::1` with the same port | open `http://127.0.0.1:<port>/` and the login URL there. |
| 403 `Host not allowed` | the page is opened through a name or address other than `localhost` or `127.0.0.1` (for example a LAN IP) | open `http://127.0.0.1:<port>/`. |
| 403 `Origin not allowed` | the request comes from another origin. Allowed origins are `http://localhost:<port>`, `http://127.0.0.1:<port>` and `http://[::1]:<port>`. | use the UI from one of these origins. In development the UI runs at `http://127.0.0.1:3000`; extra development origins are set with `AGENT_HUB_DEV_ORIGINS` and only work with `NODE_ENV=development`. |
| 401 `Missing Origin or invalid token` on `POST`, `PUT`, `PATCH` or `DELETE` | the request has no `Origin` header, or its `X-Agent-Hub-Token` is missing or from an earlier server start | send `Origin: http://127.0.0.1:<port>`, the access key and the token from `GET /api/session-token` in `X-Agent-Hub-Token`. The token changes on every server restart. The web app fetches a new one after a 401 or 403 on its own; reload the page if it does not. |
| 403 `Cross-site requests are not allowed` on `GET /api/session-token` | the request carries `Sec-Fetch-Site: cross-site` | open the UI directly in the browser, not from another site. |
| 403 `Browser requests are not allowed on this route` on `POST /api/hooks` | the request carries an `Origin` header; the hook endpoint accepts only Claude Code | none. Claude Code sends no `Origin`. |
| 401 `Invalid hook token` on `POST /api/hooks` | the `AGENT_HUB_HOOK_TOKEN` in the session's environment differs from `hook-token` in the state directory: the token is renewed after an Agent Hub update and rotated when the hooks are installed or removed in Settings, which lists the affected sessions | restart that Claude session. Sessions keep the environment they were started with. |

## Hook status is not updating

Session status (working, waiting, idle, error) comes from Claude Code hooks. Check the reasons first:

```bash
printf 'X-Agent-Hub-Key: %s\n' "$(cat ~/.local/state/agent-hub/access-key)" | curl -fsS -H @- http://127.0.0.1:<port>/api/hooks/status
```

The answer lists `installed`, `portMatches`, `statusAvailable` and `reasons`. Each reason has a `code`.

| Reason code | Cause | Fix |
| --- | --- | --- |
| `not_installed` | Agent Hub hook entries are missing in the Claude settings file | install them: `POST /api/hooks/install` with `Origin: http://127.0.0.1:<port>`, the access key and the `X-Agent-Hub-Token` header (see [401 and 403](#requests-fail-with-401-or-403)). |
| `port_mismatch` | the entries point at another port | run the install call again; it rewrites the entries for the current port. |
| `settings_invalid` | `settings.json` (user or managed) is not strict JSON. Comments and trailing commas are refused. | fix the file. Agent Hub never rewrites an invalid file. |
| `disable_all_hooks` | `disableAllHooks` is `true` in a settings file | remove the key. |
| `managed_hooks_only` | a managed settings file sets `allowManagedHooksOnly` and blocks user hooks | change the managed settings; this needs the administrator. |
| `url_not_allowed` | `allowedHttpHookUrls` is set and does not match `http://127.0.0.1:<port>/api/hooks` | add the URL, or a `*` pattern that matches it. |
| `env_vars_not_allowed` | `httpHookAllowedEnvVars` is set and does not list both `AGENT_HUB_SESSION_ID` and `AGENT_HUB_HOOK_TOKEN` | add both names. |

Other causes:

- Sessions that were started before the hooks were installed, or before the port changed, report nothing until they are restarted.
- Claude sessions that were not started by Agent Hub are not tracked. They send no session id and change nothing.
- Project settings are not checked by the status route, because they depend on the session's directory.

The settings file is `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`). Install and uninstall back up the previous file first.

## Sessions missing after a restart

| Symptom | Cause | Fix |
| --- | --- | --- |
| All sessions disappeared | the tmux unit was restarted or stopped (`agent-hub-tmux.service` owns the tmux server), or WSL stopped the distro after its idle timeout | restarting `agent-hub.service` alone keeps sessions. Keep WSL running, see [Keeping WSL running](install.md#keeping-wsl-running). |
| A session is gone although its tmux session exists | the tmux session name does not start with `ah-` or belongs to another server | Agent Hub only manages `ah-<id>` sessions on socket `agent-hub`. Check with `tmux -L agent-hub ls`. |
| `GET /api/sessions` lists a session titled `Recovered` with command `tmux` | a tmux session without a metadata file was found on start and adopted | expected. It is not opened in a tab by itself. Stop it with `DELETE /api/sessions/<id>` (Origin and token as in [401 and 403](#requests-fail-with-401-or-403)) or `tmux -L agent-hub kill-session -t ah-<id>`. |
| Tabs are missing in another browser or after clearing site data | open tabs are stored in the browser (`localStorage`), not on the server | the sessions keep running; `GET /api/sessions` lists them. |

Sessions that exited on their own stay visible until their tab is closed.

## Installer failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Checksum mismatch for agent-hub-<tag>.tar.gz (expected ..., got ...)` | the download is incomplete or the release asset does not match its `.sha256` file | run the installer again. If it repeats, do not continue: the release and its checksum disagree. Do not use `--no-verify` for this. |
| `The release publishes no agent-hub-<tag>.tar.gz.sha256; refusing to install unverified` | the release has no checksum file | use `--no-verify` only if you accept an unverified download, or install a tarball you built with `--from-source`. |
| `Continue? -> no (no terminal to ask).` followed by `Error: Aborted` | the installer runs without a terminal (for example in a script) and `--yes` is missing | run it from a terminal, or add `--yes`. |
| `Missing build tools for node-pty` and `Install them first: sudo apt-get update && sudo apt-get install -y build-essential python3` | `make`, `g++` or `python3` is missing | run the command, or re-run with `--yes` to let the installer run apt. |
| `pnpm install failed. If node-pty failed to build ...` | build tools are missing, or Node was changed | see [node-pty build failure](install.md#node-pty-build-failure). |
| `Node.js 22 or later is required` | Node is older than 22 | install Node 22 or later. |
| `pnpm <version> is required and corepack is missing` | corepack is not available | `npm install -g pnpm@<version>` with the version the message names. |
| `Refusing to use <path> as install prefix` | the prefix is outside your home directory, or is a system directory | choose a prefix below your home directory with `--prefix`, or pass `--force` for a prefix outside it. |
| `<prefix> is not empty and has no Agent Hub install marker` | the prefix holds other files | choose another `--prefix`, or pass `--force`. |
| `Registering the task failed. See docs/install.md (Windows logon task) ...` | Task Scheduler is blocked on this machine | create a basic task by hand: program `wsl.exe`, arguments `-d <distro> --exec true`, trigger at log on. See [Windows logon task](install.md#windows-logon-task). |

## WSL systemd not enabled

| Symptom | Cause | Fix |
| --- | --- | --- |
| `systemd is not running in this WSL distro`, or `systemctl --user` fails | `/etc/wsl.conf` has no `[boot]` section with `systemd=true`, or WSL was not restarted after adding it | `ps -p 1 -o comm=` must print `systemd`. Add `[boot]` and `systemd=true` to `/etc/wsl.conf`, run `wsl.exe --shutdown` in Windows PowerShell, open the distro again and re-run the installer with the same options. |
| The installer says `already enables systemd, but WSL has not been restarted since` | the setting exists but WSL still runs without systemd | run `wsl.exe --shutdown` in Windows PowerShell and open the distro again. |

## Team templates

| Symptom | Cause | Fix |
| --- | --- | --- |
| 404 `not_found` with "Team templates need experimental.agentTeams" on `/api/team-templates` | the flag is off, so every team template route answers 404 | set `experimental.agentTeams: true` in `config.yaml` (or `PATCH /api/config`). |
| Launch answers 409: "Agent teams need Claude Code 2.1.309 or later (found ...)" | the lead command reports an older version, or `--version` printed nothing | update Claude Code. Check with `<lead.command> --version` in the lead's directory. |
| Launch answers 409: "Could not run <command> --version" | the lead command is not on `PATH` for the server | set `lead.command` to an absolute path, or put the command on the `PATH` of the service (see [tmux unavailable](#tmux-unavailable)). |
| Launch answers 400 "cwd ... is not a directory" | `lead.cwd` does not exist | create the directory or correct the path. |
| Save answers 400 with "the generated lead command is N bytes, the limit is 12288" (a hand-edited file is refused with 409 and the same message) | the prompts, goal or args are too long for one tmux command | shorten `goal`, the teammate prompts or `lead.args`. |
| Save or launch answers 400 about `lead.args` | an argument is reserved by the launch (for example `--model`, `--session-id`, `-p`) | remove it; the launch sets these flags itself. |
| The lead starts but no teammates appear | Claude Code did not follow the first prompt. Its spawn behavior is not verified. | open the lead session and ask for the teammates by name, or check the board for the team name in the Teams view. |
| Team board stays empty | the lead has no tasks yet, or the flag was turned off | the board reads `$CLAUDE_CONFIG_DIR/tasks/<team>/` and `teams/<team>/`; both appear only after Claude Code writes them. |

## Browser shows "Disconnected"

The status badge in the app bar shows `Disconnected` when the WebSocket is closed. The web app reconnects by itself.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Disconnected` stays, `curl` to `/api/health` fails | the server is not running, or the distro was stopped | `systemctl --user status agent-hub.service`; start it with `systemctl --user start agent-hub.service`. If WSL stopped, see [Keeping WSL running](install.md#keeping-wsl-running). |
| `Disconnected` stays, `curl` to `/api/health` works | the browser uses another port or origin than the server, or has no access key for this origin | open the login URL (`install.sh --login-url`), which uses the port from `config.yaml` or `AGENT_HUB_PORT`. |
| The connection stops with a `protocol_mismatch` error (WebSocket close code 4001) | the web app and the server speak different protocol versions, for example after a partial update | reload the page. If it persists, re-run the installer so both come from the same release. The server reports its protocol version in the error message. |
| `Disconnected` stays and the UI cannot connect | the session token cannot be fetched from `GET /api/session-token`, for example because of a 403 from the Host, Origin or cross-site check | see [Requests fail with 401 or 403](#requests-fail-with-401-or-403). |

![App bar with the Disconnected status badge](images/disconnected-badge.png)
