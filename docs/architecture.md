# Agent Hub architecture

Agent Hub is a local web app running inside WSL that manages Claude Code sessions. Each session runs in its own tmux session; the browser shows them as terminal panes arranged in tabs. Decisions behind this document are recorded in [`adr/`](adr/).

Statements about Claude Code behavior that could not be verified from its documentation are marked **assumed** together with the task that has to verify them.

## Overview

```mermaid
flowchart LR
  subgraph Browser["Browser (Windows host)"]
    UI[Vue 3 + Vuetify SPA]
    XT[xterm.js panes]
  end
  subgraph WSL["WSL (systemd user session)"]
    subgraph Server["agent-hub.service (Node 22)"]
      HTTP[Fastify REST /api]
      WS[ws endpoint /ws]
      ENG[Session engine]
      FS[File service]
      CFG[Config + preset loader]
    end
    PTY[node-pty: tmux attach]
    TMUX[("tmux server -L agent-hub")]
    CC[claude processes]
    CONF[("config dir: config.yaml, workspaces/*.yaml")]
    STATE[("state dir: sessions, launch ledgers, hook token, backups")]
    CLAUDE[("~/.claude and project files: settings.json, CLAUDE.md, skills")]
  end
  UI -->|"REST + token"| HTTP
  XT <-->|"JSON frames"| WS
  HTTP --> ENG
  WS --> ENG
  HTTP --> FS
  HTTP --> CFG
  ENG --> PTY --> TMUX --> CC
  ENG -->|"execFile tmux"| TMUX
  CFG --> CONF
  ENG --> STATE
  FS --> CLAUDE
  CC -->|"HTTP hooks: POST /api/hooks"| HTTP
```

| Component | Responsibility |
| --- | --- |
| SPA (`apps/web`) | Tabs, split panes, preset/skill/MCP editors. Talks REST for CRUD and one WebSocket for terminal I/O and live state. |
| Fastify server (`apps/server`) | REST API, WebSocket endpoint, static file serving of the built SPA, Host/Origin/token checks. |
| Session engine | Creates, attaches, resizes, kills and re-adopts tmux sessions; fans out pty output to WS clients; derives session state from hooks. |
| File service | The only code path that writes files outside the state directory (see [File-write policy](#file-write-policy)). |
| tmux | Owns every session process. The server can crash or restart without killing a single session. |
| Claude Code | Runs inside tmux; reports activity back through HTTP hooks merged into its settings. |

## Process model

```mermaid
flowchart TB
  SD["systemd --user"] --> TU["agent-hub-tmux.service (Type=forking)"]
  SD --> SVC["agent-hub.service: node server"]
  SVC -.->|"Wants + After"| TU
  TU --> TS["tmux server, socket name agent-hub"]
  TS --> S1["tmux session ah-id1: claude"]
  TS --> S2["tmux session ah-id2: claude"]
  SVC -.->|"node-pty: tmux attach-session"| S1
  SVC -.->|"execFile: new-session, kill-session, ls, capture-pane"| TS
```

- **Server.** Runs as the systemd user service `agent-hub.service` inside WSL (`Restart=on-failure`, `Wants=` and `After=agent-hub-tmux.service`), installed by `install.sh` ([install guide](install.md)). `ExecStart` is the absolute `node` found at install time (node-pty is a Node-API addon, prebuilt in the release or compiled on install) running `<prefix>/current/apps/server/dist/index.js`; the unit sets `AGENT_HUB_PORT`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and the installer's `PATH`. It binds `127.0.0.1:<port>` only (`BIND_HOST`, `resolvePort`) and serves the built web app (`apps/web/dist`, or `AGENT_HUB_WEB_DIST`) with SPA fallback and a strict CSP. In development `pnpm dev` runs it with `tsx watch` instead.
- **One tmux server** with the dedicated socket name `agent-hub` (`tmux -L agent-hub ...`), so the user's own tmux sessions are never listed, touched or killed. It is owned by its own user unit `agent-hub-tmux.service` (`Type=forking`, `ExecStart=tmux -L agent-hub -f $STATE/tmux.conf start-server` with the absolute state path, `ExecStop=tmux -L agent-hub kill-server`), so restarting or stopping `agent-hub.service` never kills sessions. The unit carries the installer's `PATH`, because sessions inherit the tmux server environment and need to find `claude`; it has no sandboxing options, since sessions are the user's interactive shells (`sudo` must keep working).
- **tmux.conf** (`$STATE/tmux.conf`, copied by the installer from `packaging/tmux.conf`): `exit-empty off` (server stays up without sessions), `remain-on-exit on` (exit codes stay readable), status line off, `history-limit 50000` for scrollback, `window-size latest`, and the `terminal-overrides` entry below. tmux reads it only when the tmux server starts; changes need a restart of `agent-hub-tmux.service`.
- **The engine never starts the tmux server.** Every `execFile` call passes `tmux -N` (never start a server). If the socket is missing it reports `tmux_unavailable` (`ApiErrorCodeSchema`, HTTP 503), refuses to create sessions and keeps retrying the listing. In development the developer starts it with the same command.
- **No alternate screen.** When the tmux server becomes available, the engine appends `xterm-256color:smcup@:rmcup@` to the server option `terminal-overrides` (once), so the attach pty never switches xterm.js to the alternate buffer and scrollback written before the redraw stays visible.
- **Requirements:** tmux 3.2 or later (`new-session -e`); the installer checks `tmux -V`. The installer runs `loginctl enable-linger` so user units start at boot and run without a login session.
- **WSL lifetime.** systemd services do not keep a WSL instance alive: WSL stops an idle distro (`instanceIdleTimeout` in `.wslconfig`, default 15 s) and the VM (`vmIdleTimeout`), which ends all sessions. The [install guide](install.md#keeping-wsl-running) covers the optional Windows logon task that boots the distro and how to keep it running.
- **One tmux session per Agent Hub session**, running exactly one command (default `claude`) in one window and pane. Agent Hub layouts (splits, tabs) are drawn in the browser, never with tmux panes.
- **One pty per attached session.** When the first client attaches, the engine spawns `tmux -L agent-hub attach-session -t =ah-<id>` with node-pty and fans its output out to every attached WS client. When the last client detaches, the pty is closed; the tmux session keeps running. tmux therefore only ever sees one client per session, and the pty size is the session size.
- **All other tmux calls** (`new-session`, `kill-session`, `list-sessions`, `list-clients`, `display-message`, `capture-pane`, `refresh-client`, `show-options`, `set-option`) use `execFile` with argument arrays. Targets use the exact-match form because tmux otherwise prefix-matches names: `=ah-<id>` for session targets (`kill-session`, `attach-session`), `=ah-<id>:` for window and pane targets (`display-message`, `capture-pane`, `list-clients`).

### Lifecycle operations

| Operation | What happens |
| --- | --- |
| Create (REST or preset autostart) | Generate id, write metadata (`lifecycle: starting`), `new-session -d -s ah-<id> -c <cwd> -x <cols> -y <rows> -e AGENT_HUB_URL=http://127.0.0.1:<port> -e AGENT_HUB_SESSION_ID=<id> -- env -- <command> <args...>` (`env --` because tmux runs a single-word command through `sh -c`), preceded in the same tmux call by `source-file $STATE/session-env.tmux ;`, an owner-only (`0600`) file with `set-environment -g AGENT_HUB_HOOK_TOKEN '<token>'`, so the token never appears in a process's argv, then `running`; broadcast `session.created`. `cwd` must be an existing directory (`400 bad_request`). Failure: `session_spawn_failed`, metadata removed. |
| Browser closed | Nothing. Sessions keep running; the pty closes when no client is attached. |
| Close app tab | Client asks for confirmation (`confirmCloseTab`), then `DELETE /api/sessions/:id` per pane: `kill-session -t =ah-<id>`, metadata deleted, `session.removed` broadcast. |
| Command exits | Pane stays dead (`remain-on-exit`); engine sets `lifecycle: exited` with `exitCode` from `#{pane_dead_status}`. The session stays visible until the user closes it. |
| Server restart | Re-adoption, see below. |

Exit detection polls one `list-sessions` call (the re-adoption format below, which includes `pane_dead`, `pane_dead_status` and `pane_dead_signal`) for all sessions. A dead pane is `exited` at once; `exitCode` is the status, or `128 + signal` for a killed command, and is added by a later `state` frame when tmux reaps the process after marking the pane dead. Polling runs every 1 s while any session is attached, every 5 s otherwise; a session missing from the listing is removed (`session.removed`); sessions created after a listing started are left alone by it. If the shared pty exits unexpectedly, a fresh listing runs: a vanished session is removed, otherwise its clients get `error tmux_unavailable` (or `internal` when tmux is still up) and are detached. `GET /api/health` reports `tmux: available | unavailable`. The `SessionEnd` hook is only a hint that triggers an early poll (`engine.poll()`). A tmux `pane-died` hook calling back into the server is an optional later optimization.

### Re-adoption after restart

On startup the engine runs `tmux -L agent-hub list-sessions -F '#{session_name}\t#{session_created}\t#{session_path}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_start_command}'` (no server running = `tmux_unavailable`) and reconciles it with `$STATE/sessions/*.json`:

| tmux session | Metadata | Result |
| --- | --- | --- |
| `ah-<id>` exists | `sessions/<id>.json` exists | Adopted: `lifecycle` from `pane_dead`, `state` reset to `idle` until the next hook arrives. |
| `ah-<id>` exists | missing (orphan) | Adopted with reconstructed metadata (below). Never killed automatically. |
| missing | `sessions/<id>.json` exists | Stale record deleted. Clients still referencing the id get `unknown_session` and drop the pane. |
| name without `ah-` prefix | - | Ignored, never touched (someone used the socket manually). |

Reconstructed orphan record: `cwd` from `session_path`, `createdAt` from `session_created`, `title: "Recovered"`. `pane_start_command` is a shell-quoted string that cannot be split back reliably, so it is only logged and the record stores `command: 'tmux'`, `args: []`. Required fields without a source get defaults: `cols` 80, `rows` 24, `state: idle`, `lastEventAt` now, `hostId: local`. Recovered sessions are not opened in a tab automatically; `GET /api/sessions` lists them. Tabs live in the browser (`localStorage`, `agent-hub.tabs.v1`), not on the server.

Re-adopted sessions keep the environment they were created with, which is why the hook token is persisted and not per boot (see [Security model](#security-model)).

## Naming and storage

### Session ids and tmux names

- Session ids are generated by the server: 12 characters of `crypto.randomBytes(9).toString('base64url')`, so the charset is `[A-Za-z0-9_-]`, the same as `TmuxSessionNameSchema`.
- tmux session name: `ah-<sessionId>` (`Session.tmuxSession`). The prefix marks sessions as ours during re-adoption and guarantees a name never starts with `-`.
- `SessionIdSchema` enforces the charset above, so every valid id yields a valid `tmuxSession`.

### Where things live

| Path | Content | Writer |
| --- | --- | --- |
| `$XDG_CONFIG_HOME/agent-hub/config.yaml` (default `~/.config/agent-hub/`) | `AppConfigSchema` | user + server (`PATCH /api/config`) |
| `.../agent-hub/workspaces/<name>.yaml` | `WorkspacePresetSchema`, file name = `name` | user + server (preset API) |
| `.../agent-hub/teams/<name>.yaml` | `TeamTemplateSchema` (experimental), file name = `name` | user + server (team template API) |
| `$XDG_STATE_HOME/agent-hub/` (default `~/.local/state/agent-hub/`, called `$STATE`) | runtime state, mode `0700` | server only |
| `$STATE/sessions/<id>.json` | one `Session` record, rewritten on every lifecycle or state change | server |
| `$STATE/preset-launches.json` | preset name to the ids of the sessions it launched (autostart guard, see [Workspace presets](#workspace-presets)) | server |
| `$STATE/team-launches.json` | team template launches: template, lead session id, expected team name (see [Agent teams](#agent-teams-experimental)) | server |
| `$STATE/hook-token` | hook token, mode `0600`; created, replaced (corrupt file) or rotated only while holding `$STATE/hook-token.lock`, so concurrent starts agree on one token; temp files of interrupted writes older than 60 s are removed on start | server |
| `$STATE/hook-token.version` | server version that wrote `hook-token`; a different or missing version renews the token on start | server |
| `$STATE/tmux.conf` | tmux config, read by `agent-hub-tmux.service` at tmux start | installer |
| `$STATE/backups/<encoded-path>/<timestamp>` | backups before overwriting or deleting files (see below) | server |
| journald (`journalctl --user -u agent-hub`) | logs (pino to stdout) | server |

The state directory follows the XDG base directory spec the same way `resolveConfigDir` does for config: `$XDG_STATE_HOME/agent-hub` when set, otherwise `~/.local/state/agent-hub` (`resolveStateDir(env)` in `packages/shared`).

## WebSocket runtime behavior

The frame catalogue is in [Shared contracts](#websocket-protocol). This section defines how the server and client use it.

### Connection lifecycle

```mermaid
sequenceDiagram
    participant C as Browser
    participant S as Server
    C->>S: GET /api/session-token, X-Agent-Hub-Key
    S-->>C: token
    C->>S: GET /ws?v=1, Sec-WebSocket-Protocol agent-hub.v1 + token.t
    Note over S: Host, Origin, token, version checked before upgrade
    alt check fails
        S-->>C: HTTP 403 (bad Host/Origin/token)
    else version mismatch
        S-->>C: upgrade, error protocol_mismatch, close 4001
    else ok
        S-->>C: 101, Sec-WebSocket-Protocol agent-hub.v1
        C->>S: attach (one per visible pane)
        S-->>C: scrollback, then output ...
    end
```

1. Before every connect the client fetches the current per-boot token from `GET /api/session-token` (route name fixed, added to `API_ROUTES` in T11), sending the access key. It opens one socket per browser tab at `/ws?v=<WS_PROTOCOL_VERSION>` with the subprotocols `agent-hub.v1` and `token.<token>` (`new WebSocket(url, ['agent-hub.v1', 'token.' + token])`). The server validates the token entry and echoes only `agent-hub.v1`. Browsers cannot set other headers on WebSocket requests; the subprotocol header keeps the token out of URLs and access logs.
2. It sends `attach` for every pane that is visible. Hidden app tabs are detached to save bandwidth and re-attached when shown.
3. `session.created`, `session.removed` and `state` frames are broadcast to every connection, attached or not, so sidebars stay current.
4. Invalid frames get `error bad_message` and are ignored; the connection stays open.

### Attach and scrollback ordering

For each `attach {sessionId, cols, rows, scrollback}`:

1. Unknown id: `error unknown_session`.
2. Register the client on the session; spawn the pty if it is the first client. Live output for this client is buffered from now on.
3. Apply the size (resize rule below).
4. If `scrollback` is `true`: read `#{history_size}` (`display-message -p -t =ah-<id>:`); if it is not 0, `capture-pane -p -e -J -S -<min(history_size, 10000)> -E -1 -t =ah-<id>:` (history above the visible screen, with escape sequences; tmux swaps `-S`/`-E` on an empty history, hence the check). Line feeds become `\r\n` and the result is sent as one `scrollback` frame. The client resets its xterm before writing it.
5. Ask tmux to redraw the visible screen: read the pty's client tty with `list-clients -t =ah-<id>: -F '#{client_tty}'`, then `execFile tmux refresh-client -t <client_tty>`. Flush the buffered output and stream `output` frames. The redraw goes through the shared pty, so every viewer of that session receives it; it is a harmless repaint.

The visible screen always comes from tmux's redraw, so it is never duplicated. Lines that scroll off the screen exactly between capture and redraw may be missing from history; this is accepted for v1.

`input` or `resize` for a session the connection is not attached to returns `error not_attached`.

### Resize rule

A tmux session has one size. The last `attach` or `resize` from any client wins: the engine resizes the pty (and with it the tmux client), and all other attached clients render at that size. Values are bounded by `MAX_TERMINAL_SIZE`. The client debounces resize events (fit addon) before sending.

### Backpressure

v1 has no flow-control frames. Per connection the server keeps one pending output string per session:

| Condition | Action |
| --- | --- |
| `ws.bufferedAmount` below 1 MiB | Send `output` immediately. |
| at or above 1 MiB | Coalesce: append to the pending string for that session and flush it as one frame when the buffer drains (checked on a short timer). |
| pending output for one connection above 8 MiB | The client is too slow: close the connection with code `4008`. The client reconnects and re-attaches with `scrollback: true`, which resynchronizes the screen. |

The policy is coalesce, then close with `4008`; output is never dropped, because dropping escape sequences corrupts the terminal. The pty itself is never paused in v1, since it is shared by all clients of a session. Protocol v2 reserves `pause`/`resume` frames for real per-client flow control.

### Limits, heartbeat, close codes

- `maxPayload`: 1 MiB per incoming frame (large pastes fit; larger frames close the connection with `1009`).
- Heartbeat: the server sends a WebSocket ping every 30 s and terminates connections that missed the previous pong. The client sends the app-level `ping` every 25 s and treats a missing `pong` after 10 s as a dead connection.
- Close codes: `1000` normal, `1001` server shutdown, `1009` frame too large, `4001` protocol mismatch, `4008` slow consumer.

### Reconnect semantics

- The client reconnects automatically with exponential backoff (0.5 s doubling to 10 s, with jitter), except after `4001` (reload the page to get a matching client).
- After reconnect it re-sends `attach` with `scrollback: true` for every visible pane and refetches `GET /api/sessions`, because `session.created`/`session.removed` frames during the outage were missed.
- Server restart looks like a reconnect: sessions were re-adopted, so attaching works unchanged. The per-boot token changed, so the client always refetches it before connecting. `GET /api/health` `protocolVersion` tells the client whether it must reload.
- REST calls that fail with `401` or `403` refetch the token once and retry once; a second failure is shown to the user.
- Graceful shutdown closes all sockets with `1001` and all ptys; tmux sessions are left running.

### Split layouts (web)

`AhSplitLayout` renders a tab's `Layout` with `splitpanes`: `single`, `row`, `column`, `grid-2x2` and `custom` are all expanded into one node tree (`layoutTree.ts`) and drawn recursively by `AhSplitNode`; leaves are filled through the `pane` slot (`AhTerminalPane` in the workspace view). Default sizes come from the optional `size` weights of panes and nodes, otherwise equal shares.

Dragged sizes are kept per tab and per split node path in `localStorage` (`agent-hub.layout-sizes.v1`, `stores/layoutSizes.ts`, validated with zod on load; entries that no longer fit the node's pane count are ignored). "Reset layout" drops a tab's entries; entries of closed tabs are pruned. Splitters are focusable separators with `aria-label`; arrow keys move them in 5% steps. After a splitter move (debounced) and when a tab is activated, the workspace view calls `fit()` on the tab's terminal panes.

## File-write policy

`$CLAUDE_DIR` is `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`; the server honors it everywhere it reads or writes Claude Code files. The server writes only these files; everything else is read-only:

| Target | How | Notes |
| --- | --- | --- |
| Own config: `config.yaml`, `workspaces/*.yaml` | File service, atomic | YAML written through the `yaml` Document API so user comments and unknown keys survive. Preset file name must equal `PresetNameSchema`. |
| Own state: `$STATE/**` | Atomic | No conflict check (server is the only writer). |
| Claude settings: `$CLAUDE_DIR/settings.json` | Merge `hooks` key only, atomic, conflict-checked | Adds Agent Hub hook entries if missing; never changes or removes other entries or keys. Agent Hub's entries are identified by their exact URL `http://127.0.0.1:<any port>/api/hooks`, never by an extra key. Uninstall removes only those entries (and groups, event keys or the `hooks` key it emptied), so install then uninstall restores the file byte for byte when it uses one consistent indentation. The port is baked into that URL, so a port change re-merges the entries; running Claude Code sessions pick up hook edits live. Invalid JSON (including comments) is `409 conflict` and never rewritten. Symlinks are followed. |
| `CLAUDE.md` and skills | File service, atomic, conflict-checked | Only inside allowlisted scopes: global `$CLAUDE_DIR/CLAUDE.md` and `$CLAUDE_DIR/skills/**`; for each configured project and its git worktrees `<root>/CLAUDE.md`, `<root>/CLAUDE.local.md`, `<root>/.claude/skills/**`. |
| MCP servers | `claude mcp add-json` / `claude mcp remove` via `run()`, file edit as fallback | See [MCP configuration](#mcp-configuration) and [ADR 0009](adr/0009-mcp-config-via-cli.md). |
| Worktree helper | Copy gitignored files into a new worktree | Only after explicit confirmation, target must be inside the worktree (T34). Apply is all-or-nothing in validation, best-effort in writing. |

### Rules

- **Atomic write:** write `<dir>/.<name>.agent-hub-<random>.tmp` in the same directory (same filesystem), copy the target's mode, `fsync`, `rename` over the target. A crash leaves either the old or the new file, never a partial one.
- **Conflict detection:** every read returns `mtimeMs` and the sha256 `hash` of the content. Writes carry the hash they are based on as `expectedHash` (omitted only for a new file); the server compares it under a per-path lock and re-hashes the target once more right before the rename. Mismatch (or file created/deleted meanwhile) returns `409 conflict` with `{ currentHash }`, and the UI shows a diff or reload choice.
- **Never silent overwrite:** there is no force flag in the API. Overwriting after a conflict needs a fresh read. External changes are pushed to the UI by a file watcher (T31).
- **Symlinks:** the requested path must match a managed pattern. It is resolved with `realpath`, and the resolved path must stay inside the same scope root, contain no hidden segment (apart from the `.claude/skills` prefix) and be a managed file or a `.md` file, so `CLAUDE.md -> AGENTS.md` works while links to `package.json`, `.git/**` or `.claude/settings.json` are `403`. Writes go to the resolved target, so the link itself is kept; deleting a link removes only the link. New files are never created through a dangling link. Every component below the root is re-checked with `lstat` before writing, and anything but a regular file (FIFO, device) is `403`; files are opened with `O_NOFOLLOW | O_NONBLOCK`.
- **Hard links (accepted):** a managed file that is a hard link to a file elsewhere cannot be detected by path checks; writes replace the managed name via rename, so the other name keeps the old content. Creating such a link needs local access, which is out of scope.
- **Backups:** before the server overwrites or deletes a file it does not exclusively own (Claude settings, CLAUDE.md, skills, presets; `config.yaml` is written without a backup), the previous content is copied to `$STATE/backups/<encoded-path>/<timestamp>` with mode `0600` (default `~/.local/state/agent-hub/backups`; startup fails if it lies inside a scope). A deleted skill directory is backed up file by file; it is only removed when it holds nothing but managed files, otherwise `409 conflict` lists the blocking entries. Retention: the last 20 backups per file and at most 50 MB in total; the oldest backups are pruned first.

### MCP configuration

Claude Code keeps MCP servers in three scopes; Agent Hub maps its own scopes onto them (`toMcpScope`) and never invents a storage location.

| Agent Hub scope | Claude Code scope | Stored in |
| --- | --- | --- |
| `global` | `user` | `mcpServers` in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) |
| `project` / `worktree`, shared | `project` | `mcpServers` in `<root>/.mcp.json` (committed) |
| `project` / `worktree`, private | `local` | `projects["<root>"].mcpServers` in `~/.claude.json` |

```mermaid
flowchart LR
  REQ[PUT / DELETE /api/mcp] --> V{zod + known project?}
  V -- no --> E[400 / 404]
  V -- yes --> D{claude --version ok? cached 60 s}
  D -- yes --> CLI["claude mcp add-json -s scope name json<br/>claude mcp remove -s scope name"]
  D -- no --> F[jsonc edit of mcpServers.name<br/>atomic write + backup]
  LIST[GET /api/mcp] --> R[read ~/.claude.json + .mcp.json] --> M[mask env / headers]
```

- **Listing** always reads the files: `claude mcp list`/`get` have no machine-readable output and health-check every server. A scope whose file cannot be read is skipped with a warning.
- **CLI mode** (default when `claude --version` works, for entries without env or header values): `run('claude', ['mcp', 'add-json', '-s', <scope>, <name>, <json>])` and `['mcp', 'remove', '-s', <scope>, <name>]`, `cwd` = project or worktree root (home for `user`), `CLAUDE_CONFIG_DIR` passed on. An update is remove + add; a failed add puts the previous entry back (CLI, then file edit; `500 internal` if both fail). CLI errors are `409 conflict` with the first output line, scrubbed of secret values.
- **File mode** (no CLI, or the entry has env or header values, which would otherwise be `add-json` arguments readable in `/proc/<pid>/cmdline` by other local users): `jsonc-parser` edits only `mcpServers.<name>`, so unknown keys, key order and indentation survive. A file that is not strict JSON, or a non-object section on the path, is `409 conflict` (error code, line and column only, no file content) and is never overwritten. Atomic write and backups as above (hash re-checked before `rename`); `~/.claude.json` gets mode `0600`. Max file size 16 MiB.
- **Allowlist:** only `~/.claude.json` and `<root>/.mcp.json` of configured projects and worktrees; the resolved path must keep that file name and stay inside its directory, otherwise `403`.
- **Entries:** names match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$` and are not one of `RESERVED_MCP_NAMES`; transports `stdio` (`command`, `args`, `env`), `http`/`sse` (`url` = `http(s)://` or a `${VAR}` reference, `headers`). Unknown keys of an entry (`oauth`, `timeout`, ...) are kept on update while the transport family stays the same. `ws` entries and invalid names are not listed and cannot be overwritten.
- **Secrets:** every response masks env and header values as `{ masked: true, set }`, except `PATH`, `HOME`, `NODE_ENV`, `LOG_LEVEL`. On update, `{ keep: true }` for a key keeps the stored value; keys left out are removed. Logs contain only name, scope kind and mode. Secret-looking parts of `args` and the URL are replaced by `<masked>` (`MCP_MASKED_PLACEHOLDER`, `maskMcpArgs` / `maskMcpUrl`): values of flags, `NAME=value` pairs, `Name: value` headers and query parameters whose name contains token, secret, password, key, auth or credential, URL userinfo, and well-known token formats; `$VAR` / `${VAR}` references stay visible. An argument or URL sent back with `<masked>` unchanged gets the stored value (same position first, else the one unique match); a placeholder without a match is `400`. Secret values never go into a process's argv: entries with env or header values, or with a secret-looking argument or URL part, are written in file mode (unknown keys and formatting preserved), and a CLI restore is skipped for an old entry with such values.
- **Health check:** `POST /api/mcp/health` (`{ name, scope }`, 404 for unknown entries) and `POST /api/mcp/health/all` (`{ projectPath? }`) perform the MCP `initialize` handshake (protocol `2025-06-18`) and return `ok | error | timeout | unsupported` with latency, `serverInfo` and `protocolVersion`. stdio servers are spawned directly (no shell, own process group, base env plus the entry's env, cwd = project for `project`/`local`, home for `user`): `initialize` goes out as one JSON line, the first answer with id 1 decides, then `notifications/initialized` is sent and the group gets `SIGTERM`, `SIGKILL` after 1 s; stdout and stderr are capped at 64 KiB. `http` POSTs `initialize` (JSON or first SSE `data:` answer, redirects are errors); legacy `sse` waits for the `endpoint` event (same origin only), POSTs there and takes the answer from the stream or the POST body. `${VAR}` / `${VAR:-default}` in command, args, env, url and headers are expanded from the server's environment. Hard deadline 8 s per check, at most 4 checks in flight server-wide, a repeated request for an entry in flight shares the running check. Error text is scrubbed of env and header values (raw and expanded) and cut to 200 characters; a non-http(s) URL after expansion is `unsupported`. Both routes are POST because they run processes, so the session token is required; there is no GET variant. The health endpoints read the unmasked entry internally and never return it.
- **Approval and env filtering:** a `project`-scope entry comes from a committed `.mcp.json`, so it is health-checked only when the user approved it: `enableAllProjectMcpServers` or `enabledMcpjsonServers` in `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR`), or the same keys in the project's entry of `~/.claude.json`, which count only when that entry has `hasTrustDialogAccepted: true`. `<project>/.claude/settings.local.json` and `.claude/settings.json` can only disable, and `disabledMcpjsonServers` from any file wins. Managed settings (`/etc/claude-code/managed-settings.json` and `managed-settings.d/*.json`; macOS `/Library/Application Support/ClaudeCode`) block an entry in every scope through `disabledMcpjsonServers` or `deniedMcpServers`. An unapproved or blocked entry gets `unsupported` / `not approved in Claude Code` with no spawn, no request and no variable expansion (also in `/health/all`); list entries carry `approved`. `user` and `local` entries are checked unless blocked. This is deliberately stricter than Claude Code, which also honors project-level approvals. Before spawning, env keys not matching `^[A-Z_][A-Z0-9_]*$` and `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `PYTHONSTARTUP`, `PERL5OPT`, `RUBYOPT` are dropped and their names logged as a warning. In remote `url` and `headers`, variables whose name contains `TOKEN`, `SECRET`, `PASSWORD`, `KEY` or `AUTH` expand to an empty string; unset variables without default stay as literal text (logged by name). The scrub covers the value of every `${VAR}` referenced in command, args, env, url and headers.

## Security model

Agent Hub is a single-user tool on loopback. The main attacker is a web page open in the same browser; other OS users on the same machine are kept out by the access key ([ADR 0013](adr/0013-access-key-against-local-users.md)). The Origin check is the primary CSRF control; the token is defense in depth. `POST /api/hooks` takes its own path (hook token, see below). All request checks live in `apps/server/src/security/` and run in one `onRequest` hook (`registerSecurity`) before routing, so they also cover unknown routes.

```mermaid
flowchart LR
  REQ[Incoming request] --> H{Host in allowlist?}
  H -- no --> X403[403 forbidden]
  H -- yes --> K{POST /api/hooks?}
  K -- yes --> HO{Origin header present?}
  HO -- yes --> X403
  HO -- no --> E{Token and session headers both empty?}
  E -- yes --> X204[204, ignored]
  E -- no --> HT{Hook token valid?}
  HT -- no --> X401
  HT -- yes --> OK
  K -- no --> O{Origin present and not allowed?}
  O -- yes --> X403
  O -- no --> P{Matched route is health or a non-API route?}
  P -- yes --> OK[Handle]
  P -- no --> AK{Access key valid?}
  AK -- no --> X401L[401 login_required]
  AK -- yes --> M{Mutating?}
  M -- no --> OK
  M -- yes --> T{Origin present and token valid?}
  T -- no --> X401[401 unauthorized]
  T -- yes --> OK
```

| Control | Rule |
| --- | --- |
| Loopback bind | `127.0.0.1` only (`BIND_HOST`), not configurable. After `listen`, `startServer` asserts that the bound address is `127.0.0.1` and closes the server otherwise (the process exits 1). WSL localhost forwarding makes it reachable from the Windows browser (assumed, verify in T60). |
| Host allowlist | `localhost:<port>`, `127.0.0.1:<port>`, `[::1]:<port>` and bare `localhost` (case-insensitive), else `403 forbidden` on every route. Blocks DNS rebinding, where an attacker domain resolves to 127.0.0.1. No dev Host is allowed: in development the UI on `:3000` reaches the server only through the Vite proxy (`/api` and `/ws`, `changeOrigin: true`, `ws: true`; config lands in T22), which rewrites Host to the server's. Reusable as `isAllowedHost(host, port)`. |
| Origin allowlist | Checked on every request that carries `Origin`, and required on every mutating request except `POST /api/hooks`. Allowed: exactly `http://localhost:<port>`, `http://127.0.0.1:<port>` or `http://[::1]:<port>`; with `NODE_ENV=development` also `http://localhost:3000` / `http://127.0.0.1:3000` (Vite). A mismatch, including `null`, is `403`; a missing `Origin` on a mutation is `401`. Reads without `Origin` pass. No CORS headers are ever sent. Reusable as `isAllowedOrigin(origin, port, dev)`. |
| Access key | `randomBytes(32)` base64url, created once in `$STATE/access-key` (`0600`, state dir `0700`) by `loadAccessKey` and kept across restarts. Required as `X-Agent-Hub-Key` (`ACCESS_KEY_HEADER`) on every `/api/*` request, reads included, except `GET`/`HEAD /api/health` and `POST /api/hooks`; decided on the matched route (the router decodes `/%61pi/...` to `/api/...`) and on the raw path, and unmatched requests need it too (fail closed); constant-time compare; missing or wrong is `401 login_required`. The browser gets it from the login URL `http://127.0.0.1:<port>/#key=<key>` (printed by the installer, `install.sh --login-url` or `pnpm login-url [--port <n>]`): the SPA reads the fragment before the router starts, stores the key in `localStorage` (`agent-hub.access-key.v1`, scoped to the origin) and removes the fragment. Only on `127.0.0.1` (`isTrustedHost`): under `localhost` or `[::1]` the SPA strips the fragment without storing it, deletes a stored key and shows a hint to switch, because another local user can listen on `::1` with the same port and would own that origin. Without a key, or after `401 login_required`, the shell shows only the login hint. Keeps other OS users out; see [ADR 0013](adr/0013-access-key-against-local-users.md). |
| Per-boot token | `randomBytes(32)` base64url generated at startup, kept in memory, new on every restart. Required as `X-Agent-Hub-Token` (`SESSION_TOKEN_HEADER`) on every `POST`/`PUT`/`PATCH`/`DELETE` (except `POST /api/hooks`) and as `token.<t>` subprotocol on `/ws`; compared in constant time (SHA-256 + `timingSafeEqual`); missing or wrong is `401 unauthorized`. `GET /api/health` stays token-free. The SPA fetches it from `GET /api/session-token` (`SessionTokenResponseSchema`) before every WS connect and once more after any `401`/`403`. That route needs the access key, sits behind the Host and Origin checks and also rejects `Sec-Fetch-Site: cross-site`; without CORS headers other origins cannot read it. |
| WebSocket upgrade | `authorizeUpgrade(req, { port, token, dev })`: Host allowed, `Origin` present and allowed, `Sec-WebSocket-Protocol` offers `agent-hub.v1` (`WS_SUBPROTOCOL`) and exactly one `token.<token>`. The server echoes only `agent-hub.v1`. No token in the query string. |
| Hook token | Separate random token in `$STATE/hook-token` (`0600`), stable across restarts of the same version because re-adopted sessions keep their environment. It is renewed when the installed version changes (`$STATE/hook-token.version`; older builds exposed it in tmux's argv) and rotated after an install or uninstall through the Settings switch changed the settings file; sessions started with the old token then get `401` and are listed in `staleSessions` of `GET /api/hooks/status` until they are restarted. Only valid on `POST /api/hooks` (`API_ROUTES.hooks`), which is exempt from the per-boot token (`POST` only; other methods need it) and rejects any request that carries an `Origin` header (Claude Code sends none; browsers always do). The route checks `X-Agent-Hub-Hook-Token` (`HOOK_TOKEN_HEADER`, constant time, `401` otherwise) before the body is parsed; a request with both hook headers empty comes from a Claude session not started by Agent Hub and gets `204`. |
| Process spawning | `run(file, args, { cwd, timeoutMs, maxBuffer, env })` in `src/process/exec.ts`: `spawn` with an argument array, `shell: false` and `detached: true` (own process group); on timeout or output overflow the whole group gets `SIGKILL`. Rejects with `RunError` (`exit`/`signal`/`timeout`/`max-buffer`/`spawn`) unless exit code 0. The child env is `PATH`, `HOME`, `LANG`, `LC_ALL`, `USER`, `TMPDIR`, `SHELL` from the server env, overridden by the caller's `env`. node-pty also takes argument arrays only; commands after `--` in `new-session`. ESLint bans in `apps/server`: `exec`/`execSync` imports, default/namespace/dynamic `child_process` imports, a `shell` option other than `false` in `spawn`/`execFile`/`fork` calls, and options passed as a variable or spread there. |
| Path allowlist | `createAllowlist(roots).resolveInside(candidate)` in `src/fs/allowlist.ts`: rejects empty, relative and NUL-byte paths, `~`-expands, `path.resolve`s, then `realpath`s the candidate (or its nearest existing parent for new files) and checks it against the `realpath` of each root (`path.relative`, no `..` segment). `..` and symlink escapes, and paths through dangling links, fail with `403 forbidden`. Callers must use the returned path; writers use temp file + rename in the resolved directory (TOCTOU). |
| Security headers | Every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `/api/*` also `Cache-Control: no-store`. HTML responses of the SPA carry a strict CSP (`contentSecurityPolicy(port)` in `apps/server/src/static.ts`); `connect-src` is `'self'` plus `ws://localhost:<port>`, `ws://127.0.0.1:<port>` and `ws://[::1]:<port>` for the listening port only, so injected script cannot reach other loopback services. In development the Vite dev server serves the HTML without this CSP and proxies `/ws`, so the page only ever connects to its own origin. |
| No secrets to the browser | MCP `env` and `headers` values are masked as `{ masked: true, set }` in API responses (except `PATH`, `HOME`, `NODE_ENV`, `LOG_LEVEL`); `{ keep: true }` on save keeps the stored value. Secret-looking parts of `args` and the URL are shown as `<masked>` and kept when sent back unchanged. |
| Logging | pino `redact` removes the `authorization`, `x-agent-hub-key`, `x-agent-hub-token`, `x-agent-hub-hook-token` and `sec-websocket-protocol` request headers. Query strings carry no secrets. |
| Validation | Every REST body and WS frame is parsed with strict zod schemas; unknown keys fail. |

### Threats

| Threat | In scope | Mitigation |
| --- | --- | --- |
| Malicious web page sends requests to `localhost:7337` (CSRF) | yes | Origin check (required on mutations) + per-boot token |
| DNS rebinding | yes | Host allowlist |
| Cross-site WebSocket hijacking | yes | Origin check + token in `Sec-WebSocket-Protocol` on upgrade |
| Path traversal / symlink escape via file API | yes | realpath + allowlist |
| Command injection via session `command`/`args`/`cwd` | yes | `execFile` only, zod validation, ESLint ban on shells |
| Secret leakage (MCP env, tokens) to page or logs | yes | Masking, log redaction |
| Forged hook events from a web page | yes | Hook token + session id header, requests with `Origin` rejected, no CORS |
| Hook token readable from session environment | accepted | Visible to the same user and to child processes of the session; impact is forged session status only |
| Oversized frames / memory exhaustion | yes | `maxPayload`, backpressure limits, 1 MiB body limit, bounded `run()` output |
| Exposure to the LAN | yes | Loopback bind only, asserted after listen; user-made port proxies are out of scope |
| Other local processes of the same user | no | They can already read `~/.claude` and run `claude` |
| Other OS users on a shared machine | yes | Access key in an owner-only file on every API request; the per-boot token is only handed out with it ([ADR 0013](adr/0013-access-key-against-local-users.md)) |
| Malicious repository content (CLAUDE.md, skills, MCP servers in a project) | no | Claude Code's own trust model applies |
| Supply-chain attacks on dependencies | partly | Lockfile with `--frozen-lockfile` in CI, Dependabot update PRs |

## Session state machine

`lifecycle` (process) and `state` (activity) are independent fields of `Session`. `state` only has meaning while `lifecycle` is `running`; on `exited` it keeps its last value and the UI shows the exit instead. `stateSince` records when `state` last changed (creation, re-adoption or a hook that changed it); the UI is meant to derive its elapsed timer from it and pulses the badge once on `waiting`. The timer is a follow-up: the web sessions store does not copy `stateSince` from `state` frames yet.

```mermaid
stateDiagram-v2
    [*] --> starting: POST /api/sessions
    starting --> running: tmux new-session ok
    starting --> [*]: spawn failed
    running --> exited: pane dead (exitCode), SessionEnd triggers the poll
    running --> [*]: kill (close tab)
    exited --> [*]: kill (close tab)

    state running {
        [*] --> idle
        idle --> working: UserPromptSubmit
        working --> working: PreToolUse / PostToolUse / PostToolUseFailure
        working --> waiting: PermissionRequest / Notification(permission_prompt, elicitation_dialog, elicitation_url_dialog)
        waiting --> working: PreToolUse / PostToolUse / UserPromptSubmit
        working --> idle: Stop / SessionEnd / Notification(idle_prompt)
        waiting --> idle: Stop / SessionEnd / Notification(idle_prompt)
        working --> error: StopFailure
        error --> working: UserPromptSubmit
        error --> idle: SessionEnd
    }
```

### Hook mapping

Claude Code supports `http` hooks that POST the hook input JSON (`Content-Type: application/json`) to a URL, configured in `$CLAUDE_DIR/settings.json`. Agent Hub installs one matcher group per event below into the user settings, each with this handler:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:<port>/api/hooks",
  "headers": { "X-Agent-Hub-Session-Id": "$AGENT_HUB_SESSION_ID", "X-Agent-Hub-Hook-Token": "$AGENT_HUB_HOOK_TOKEN" },
  "allowedEnvVars": ["AGENT_HUB_SESSION_ID", "AGENT_HUB_HOOK_TOKEN"],
  "timeout": 5
}
```

The `Notification` group carries `"matcher": "permission_prompt|elicitation_dialog|elicitation_url_dialog|idle_prompt"` (exact match), all other groups have no matcher. `SessionStart` is not installed: it supports only `command` and `mcp_tool` hooks, not `http`. `SubagentStop` is not installed either, since a subagent finishing says nothing about the main agent. Install removes Agent Hub entries from any event that is no longer in the list. Installing is explicit (`POST /api/hooks/install`, the "Claude Code session status" switch in Settings) and idempotent; `POST /api/hooks/uninstall` removes only these handlers; both back up the previous file first (see [File-write policy](#file-write-policy)). `GET /api/hooks/status` reports `installed`, `portMatches`, `installedEvents` and `statusAvailable` with `reasons`, plus `staleSessions` (running sessions with an outdated hook token).

New sessions get `AGENT_HUB_SESSION_ID` and `AGENT_HUB_URL` through `tmux new-session -e`, and `AGENT_HUB_HOOK_TOKEN` from the tmux server's global environment, set from the owner-only `$STATE/session-env.tmux` by `source-file` in the same tmux call (no argv exposure). Re-adopted sessions keep the environment they were started with; sessions started before the hook token existed or was renewed or rotated, or whose server port changed, report nothing until they are restarted. A running process's environment cannot be changed from outside, so after a rotation old sessions fail closed: their hooks get `401`, which Claude Code treats as a non-blocking error, the session keeps its last state and the server is unaffected. Such sessions (running at rotation, or a known session id arriving with a wrong token) are listed in `staleSessions` of `GET /api/hooks/status` and the Settings view asks for a restart; a later hook with the current token removes the entry. New sessions get the current token because `session-env.tmux` is rewritten before every `new-session`. Claude sessions not started by Agent Hub resolve both headers to empty strings and get `204`; they change nothing.

`POST /api/hooks` always answers fast and without a body: `204` (accepted, unknown session, invalid session id or unparseable payload, all ignored) or `401` (wrong hook token). An empty 2xx is a plain success for Claude Code; a JSON body would be parsed as hook output. Its body limit is 16 MiB because tool payloads can exceed the global 1 MiB.

| Hook event (matcher) | New `state` | Verified |
| --- | --- | --- |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `working` | events yes |
| `PermissionRequest` | `waiting` | event yes |
| `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) | `waiting` | matcher values and `notification_type` input field yes |
| `Notification` (`idle_prompt`) | `idle` | matcher value yes |
| `Stop` | `idle` | event yes |
| `StopFailure` | `error` | event yes |
| `SessionEnd` | `idle`, plus an early exit poll (`engine.poll()`) | event yes |
| `SessionStart`, `SubagentStop` and all others | no change (not installed) | `SessionStart` has no `http` support: yes |

`mapHookEvent` in `packages/shared/src/hooks.ts` is the single source of this table. Each accepted hook for a `starting` or `running` session sets `lastEventAt` (a hook can arrive before `tmux new-session` returns); only a changed `state` also sets `stateSince`, persists the record and broadcasts a `state` frame (so `lastEventAt` on disk may lag). Events for `exited` sessions are ignored.

These Claude Code settings can disable status reporting; `GET /api/hooks/status` checks the user settings file plus `/etc/claude-code/managed-settings.json` and `managed-settings.d/*.json` (hidden drop-ins skipped) and lists every hit: `disableAllHooks: true`, `allowManagedHooksOnly: true` (managed only), `allowedHttpHookUrls` without a pattern matching the hook URL (`*` wildcard, matched case-sensitively, lists merged), `httpHookAllowedEnvVars` without both variables. An unreadable or invalid user or managed file is reported as `settings_invalid`. Project settings depend on the session directory and are not checked.

Verified in the Claude Code hooks and settings references (2026-10-27):

- `SessionStart` and `Setup` support only `command` and `mcp_tool` hooks.
- `http` handler fields `url`, `headers` (`$VAR` / `${VAR}` interpolation), `allowedEnvVars` (unlisted variables become empty strings), `timeout` (seconds; default 600), the event names and `Notification` matcher values used above.
- Non-2xx, connection failure and timeout are non-blocking errors; an empty 2xx is success.
- Settings files are strict JSON; a value the schema rejects is a Settings Error for the whole file, so Agent Hub adds no marker keys to handlers.
- Identical handlers defined in several settings files run once; settings edits, including hooks, apply to running sessions.

Assumed, verify in T50 or with a live session:

- A variable listed in `allowedEnvVars` but unset in the environment yields an empty header (documented only for unlisted variables).
- `PostToolUse` after an approved permission prompt reliably moves `waiting` back to `working`; a denied prompt is followed by `Stop` or `UserPromptSubmit`.
- Latency a slow or unreachable endpoint adds per event within the 5 s timeout (`SessionEnd` hooks share a 1.5 s budget).
- Agent-team events (`TeammateIdle`, `TaskCreated`, `TaskCompleted`) need their own mapping behind `experimental.agentTeams` (T50).
- The minimum Claude Code version that supports `http` hooks and `StopFailure`; the reference states none.

## Workspace presets

See [ADR 0011](adr/0011-preset-launch-ledger.md). Presets are `~/.config/agent-hub/workspaces/<name>.yaml` (`WorkspacePresetSchema`); the file name is the preset name.

- Store (`presets/store.ts`, built on the generic `files/yaml-store.ts` that team templates share): list, get, create, update, delete. Names must match `PresetNameSchema`; a symlinked file must resolve inside the real workspaces directory. Create answers `409` for an existing name, get, update and delete answer `404` for a missing one, update cannot rename (`400`). A file that is invalid YAML, fails the schema or declares another name is skipped in the listing and answers `409` on direct access. Writes are atomic (mode `0600`), serialized, and back up the previous content (see the file-write policy). Updates are merged into the existing YAML document, so top-level comments survive; keys missing from the replacement are removed, unknown keys sent back by the client are kept. Defaults the schema fills in (`args: []`, object-form layouts without options) are not written.
- Launch (`POST /api/presets/:name/launch`): every pane is validated as a `CreateSessionRequest` first, then sessions are created one after another through the engine. A failure kills the sessions created so far and rethrows the original error. The response lists the tabs (title, layout, panes with session ids); the web adds the ids and opens them through the tabs store. An untitled tab is named after the preset (with its position when the preset has several tabs).
- Autostart: after the server listens, every preset with `autostart: true` is launched once. A preset is skipped when any session id recorded for it in `$STATE/preset-launches.json` is still live (the session exists and is not `exited`), which covers sessions re-adopted from tmux after a restart. Every launch (manual or autostart) is recorded. One info line per preset; errors are logged and never stop the server.
- Web: `stores/presets.ts`, the presets panel in the Workspaces view (empty state, and a dialog from the tab bar), `PresetDialog` with YAML-shaped fields (arguments one per line; `custom` layouts and unknown keys are kept untouched) and "Save current tabs". The form is validated with the shared schema before sending.

## Agent teams (experimental)

Behind `experimental.agentTeams` (default off) and Claude Code `>= 2.1.309` (lowest tested), see [ADR 0010](adr/0010-agent-teams.md).

- Templates (T51, [ADR 0012](adr/0012-team-templates.md)): `~/.config/agent-hub/teams/<name>.yaml` (`TeamTemplateSchema`: `experimental: true`, `goal?`, `lead`, 1-8 `teammates`, `env` limited to `TEAM_TEMPLATE_ENV_KEYS`, reserved lead args refused, generated lead command capped at `MAX_LEAD_COMMAND_BYTES` because tmux refuses commands above about 16 KB). Store `team-templates/store.ts` with the preset rules. Every `/api/team-templates` route answers `404` while the flag is off.
- Launch (`team-templates/launch.ts`): version gate on `<lead command> --version`, then one lead session through the engine with `--teammate-mode tmux`, `--session-id <uuid>` (team name `session-<first 8>` known up front), `--settings` env `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_TASK_LIST_ID=<team name>` (so teammates inherit it), optional `--model`, and a generated first prompt naming every teammate. Claude Code spawns the teammates; no agent files are written. Launches are recorded in `$STATE/team-launches.json`; a failure after the lead start kills the lead.
- Web: "Templates" section in the Teams view (`TeamTemplatesPanel`, `TeamTemplateDialog`, `stores/teamTemplates.ts`): list, create/edit, delete confirm, launch into a tab with the lead, "View board" once the team's board exists.
- Task board: read-only, tolerant parse of `~/.claude/tasks/<task-list-id>/*.json`, refreshed by a chokidar watcher (`team.changed` WS frame, 200 ms debounce) plus a 10 s poll fallback, both active only while the flag is on. `GET /api/teams` returns `enabled: false` without file access when the flag is off.
- Pane map (T53): `members[].tmuxPaneId` from `~/.claude/teams/<team>/config.json` is looked up in `tmux -L agent-hub list-panes -a`; a pane inside an `ah-<id>` session links the member to that Agent Hub session, unless the member's `cwd` lies outside the session's `cwd` (pane ids are only unique per tmux server). A lead without a pane id inherits the session when all linked teammates share one. In-process members never get a pane. Each member in `GET /api/teams` carries an optional `link` (`linked` with `sessionId` and `via: pane | lead-window`, or `unlinked` with a `reason`). Links are recomputed on every read and by the poll; a changed link, or a session created or removed, sends `team.changed`. Works only while the lead runs (the config is removed at session end).
- Web: pane headers show the linked member's name and role (`AhStatusBadge`); "Open as tab" on a team builds a tab with one pane per member (lead first, max 6, layout `single`/`row`/`grid-2x2`/two-row `custom`). Members sharing a tmux window with an already shown member get no extra pane (named in the header); members without a session get a placeholder pane (`AppPane.placeholder`) with the reason. Closing a team tab (`team-` id) kills no sessions, and any tab close spares sessions another tab still shows. Team tabs are hidden while the flag is off.
- Teammate hook events carry their own `session_id`; only the lead's drive session status, others feed a per-teammate status map.
- Agent Hub never writes team or task files.

## Repo layout and build

```text
apps/
  server/          Fastify server (TS, tsx in dev, tsc build to dist/)
  web/             Vue 3 + Vuetify SPA (Vite, port 3000 in dev)
packages/
  shared/          zod schemas, types, defaults (@agent-hub/shared, built to dist/)
docs/
  architecture.md  this file
  adr/             architecture decision records
  design-system/   tokens.json, Motion.md, component specs
examples/          config.yaml and preset examples, validated by tests
```

| Command | Effect |
| --- | --- |
| `pnpm dev` | Builds `@agent-hub/shared`, then runs in parallel: shared `tsc --watch`, server `tsx watch`, web Vite dev server. Vite proxies `/api` and `/ws` to the server port (set up with the server skeleton). |
| `pnpm login-url [--port <n>]` | Prints the login URL with the access key of the server's state directory; `--port 3000` for the Vite dev server. |
| `pnpm build` | `tsc` for shared and server, `vite build` for web. In production the server serves `apps/web/dist` and the SPA uses relative URLs, so one origin serves everything. |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint (flat config, `eslint-config-vuetify` + `typescript-eslint`), `tsc`/`vue-tsc --noEmit`, vitest per package. |
| `pnpm e2e` | Playwright end-to-end tests in `apps/web`; see [Running the e2e suite](#running-the-e2e-suite). |

TypeScript is strict everywhere (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`). Node 22 and pnpm 11 are the minimum (`engines`).

Design tokens flow from `docs/design-system/tokens.json` through a build script into a generated Vuetify theme, CSS variables and an xterm theme (see `docs/design-system/README.md`); generated files are never edited by hand.

**CI** (`.github/workflows/ci.yml`): runs on push to `main` and on every pull request, cancels superseded runs, read-only token permissions, Node 22 with pnpm cache.

| Job | Steps |
| --- | --- |
| `check` | install tmux, `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` |
| `e2e` (after `check`) | install tmux, install, cached Playwright Chromium, build `@agent-hub/shared`, `pnpm e2e`; uploads the Playwright report on failure |

### Running the e2e suite

Install the browser once with `pnpm --dir apps/web exec playwright install chromium`, then run `pnpm e2e`. Playwright builds the server and starts it on port 7340 together with Vite on 3001, using a private tmux socket and temporary state and config directories, so a running Agent Hub is never touched. Specs that need sessions require `tmux` on the `PATH` and skip without it. Specs reach the server through `apps/web/e2e/support.ts`, which also reads the hook token from the isolated state directory. The e2e server gets a fixed access key (`apps/web/e2e/access.ts`, written into the temporary state directory before start); every page starts with it in `localStorage` through `storageState`, and `login.spec.ts` covers the login URL itself.

Dependabot (`.github/dependabot.yml`) opens dependency update pull requests. Required status checks for merging are a repository setting, not part of the repo.

## Shared contracts

All contracts live in `packages/shared` (`@agent-hub/shared`) as zod schemas. Every schema is exported as `XSchema` with its inferred type `X` (and `XInput` where defaults make input and output differ). Server and web client import the same schemas, so validation and types never drift.

### Strict vs. passthrough

| Where data comes from | Unknown keys | Why |
| --- | --- | --- |
| REST bodies, WS frames, sessions, runtime tabs | rejected (`z.strictObject`) | Typos and protocol drift fail loudly at the boundary. |
| User files: `config.yaml`, preset and team template YAML, MCP entries, layouts | kept (`z.looseObject`) | Users may add keys from newer versions or their own notes; a load/save cycle must not lose them. |

The REST wrappers around presets (`{ preset }`) are strict, but the preset itself stays loose, so `GET` then `PUT` keeps user-added keys. `ConfigPatchSchema` is strict because it is an API body, not a file.

### Product defaults (`defaults.ts`)

| Constant | Value |
| --- | --- |
| `DEFAULT_PORT` | `7337` (env `AGENT_HUB_PORT` overrides: digits only, 1-65535, otherwise startup fails; see `resolvePort`) |
| `BIND_HOST` | `127.0.0.1` (never configurable) |
| `DEFAULT_HOST_ID` | `local` (single user in v1, field kept for multi-user later) |
| `DEFAULT_COMMAND` | `claude` |
| `DEFAULT_COLS` / `DEFAULT_ROWS` | `120` / `30` |
| `MAX_TERMINAL_SIZE` | `1000` cols/rows |
| `MAX_PANES_PER_TAB` | `6` |
| `CONFIG_FILE` | `~/.config/agent-hub/config.yaml` |
| `WORKSPACES_DIR` | `~/.config/agent-hub/workspaces/*.yaml` |
| `resolveConfigDir(env)` | `$XDG_CONFIG_HOME/agent-hub` when set, otherwise `~/.config/agent-hub`; the constants above are the fallback |
| `DEFAULT_CONFIG` | equals `AppConfigSchema.parse({})` |
| `EXAMPLE_PRESET` | preset `project1`: 4 panes side by side in `~/git/project1` |

Paths may start with `~`; the server expands them.

### Schemas

| Module | Schema | Purpose |
| --- | --- | --- |
| `scope.ts` | `PathSchema` | Non-empty path, `~` allowed. |
| | `ScopeKindSchema`, `ScopeSchema` | `{ kind: global \| project \| worktree, path, branch?, projectPath? }`; `branch`/`projectPath` only for worktrees. |
| `config.ts` | `AppConfigSchema` | `config.yaml`: `port`, `experimental.agentTeams` (false), `confirmCloseTab` (true), `projects` (paths), `logLevel` (`info`), `theme` (`dark` \| `light` \| `system`, default `dark`). |
| | `ConfigPatchSchema` | Partial update; nested objects merge, arrays replace (`applyConfigPatch`). |
| | `PortSchema`, `LogLevelSchema`, `ThemeSchema` | Building blocks; `resolvePort(configPort, env)` applies `AGENT_HUB_PORT`, `resolveConfigDir(env)` applies `XDG_CONFIG_HOME`. |
| `session.ts` | `SessionSchema` | One session = one tmux session: `id`, `hostId`, `title?`, `cwd`, `command`, `args`, `tmuxSession`, `createdAt`, `state`, `lifecycle`, `exitCode?` (only when exited), `lastEventAt`, `stateSince?` (when `state` last changed; optional only for records written before it existed), `cols`, `rows`. Timestamps are ISO 8601 strings. |
| | `SessionStateSchema` | `working \| waiting \| error \| idle`, derived from Claude Code hooks. |
| | `SessionLifecycleSchema` | `starting \| running \| exited`. |
| `layout.ts` | `LayoutSchema` | `single \| row \| column \| grid-2x2 \| custom`; `custom` carries a split tree (`LayoutNodeSchema`) whose leaves point at pane indexes and carry relative `size` weights. |
| | `AppTabSchema`, `AppPaneSchema` | Runtime tab with 1-6 panes, each a `sessionId` plus optional `size`. |
| | `validateLayoutPanes` | `single` = 1 pane, `grid-2x2` = 4, `custom` must reference each pane exactly once. |
| `team-templates.ts` | `TeamTemplateSchema` | Team template file (experimental): `name`, `description?`, `experimental: true`, `goal?`, `lead` (`cwd`, `command`, `args` without reserved team flags, `model?`), `teammates[1-8]` (`name`, `prompt`, `cwd?`, `model?`), `env` (allowlisted keys only). |
| | `TeamLaunchSchema`, `buildLeadPrompt`, `teamNameFor` | Recorded launch; first prompt for the lead; `session-<first 8>` team name rule. |
| `preset.ts` | `WorkspacePresetSchema` | Preset file: `name` (also the file name), `description?`, `autostart` (false), `tabs[]`. |
| | `PresetTabSchema`, `PresetPaneSchema` | Tab: `title?`, `layout` (default `row`; string shorthand `single \| row \| column \| grid-2x2` or the object form, `custom` needs the object), 1-6 panes. Pane: `cwd`, `command` (`claude`), `args` (`[]`), `title?`, `size?`. |
| `mcp.ts` | `McpServerConfigSchema`, `McpServerEntrySchema` | Config discriminated by `transport`: `stdio` (`command`, `args`, `env`) or `http`/`sse` (`url`, `headers`); entry = `name`, `scope` (`user` \| `project` \| `local`, with `projectPath` for the last two), `config`, `source` (`cli` \| `file`). `toMcpScope` maps Agent Hub scopes, `maskMcpEntry` masks secrets. |
| `api.ts` | `ApiErrorSchema` | Every non-2xx body: `{ code, message, details? }`; `validation_failed` requires `details: { path, message }[]` (`toValidationError`). |
| | REST schemas | See table below. |
| `hooks.ts` | `HookPayloadSchema`, `mapHookEvent` | Claude Code hook input (loose: only `hook_event_name`, `session_id?`, `notification_type?` are validated) and the event-to-state mapping, see [Hook mapping](#hook-mapping). |
| | `HookStatusSchema`, `HookChangeResponseSchema` | Hook install status and install/uninstall results. |
| `ws.ts` | `ClientMessageSchema`, `ServerMessageSchema` | WebSocket protocol, see below. |

Minimal preset (`~/.config/agent-hub/workspaces/project1.yaml`; full examples in `examples/`, validated by `examples.test.ts`):

```yaml
name: project1
tabs:
  - title: project1
    layout: row # shorthand for { kind: row }
    panes:
      - cwd: ~/git/project1
      - cwd: ~/git/project1
      - cwd: ~/git/project1
      - cwd: ~/git/project1
```

### REST API

All routes live under `/api` (`API_ROUTES`).

| Method and route | Request | Response |
| --- | --- | --- |
| `GET /api/health` | - | `HealthResponseSchema` (`status`, `name`, `version`, `protocolVersion`, `uptimeSec`, `tmux`) |
| `GET /api/sessions` | - | `ListSessionsResponseSchema` |
| `POST /api/sessions` | `CreateSessionRequestSchema` (`cwd`, `command`, `args`, `title?`, `cols`, `rows`) | `CreateSessionResponseSchema` |
| `DELETE /api/sessions/:id` | `SessionParamsSchema` | `KillSessionResponseSchema` |
| `GET /api/presets` | - | `ListPresetsResponseSchema` |
| `GET /api/presets/:name` | `PresetParamsSchema` | `PresetResponseSchema` |
| `POST /api/presets` | `UpsertPresetRequestSchema` | `PresetResponseSchema` |
| `PUT /api/presets/:name` | `UpsertPresetRequestSchema` (full replace) | `PresetResponseSchema` |
| `DELETE /api/presets/:name` | `PresetParamsSchema` | `DeletePresetResponseSchema` |
| `POST /api/presets/:name/launch` | `PresetParamsSchema` | `LaunchPresetResponseSchema` (`name`, `tabs`: title, layout, panes with session ids) |
| `GET /api/team-templates` | - | `ListTeamTemplatesResponseSchema` (`templates`, live `launches`); `404` while `experimental.agentTeams` is off, like every team template route |
| `GET /api/team-templates/:name` | `TeamTemplateParamsSchema` | `TeamTemplateResponseSchema` |
| `POST /api/team-templates` | `UpsertTeamTemplateRequestSchema` | `TeamTemplateResponseSchema` |
| `PUT /api/team-templates/:name` | `UpsertTeamTemplateRequestSchema` (full replace) | `TeamTemplateResponseSchema` |
| `DELETE /api/team-templates/:name` | `TeamTemplateParamsSchema` | `DeleteTeamTemplateResponseSchema` |
| `POST /api/team-templates/:name/launch` | `TeamTemplateParamsSchema` | `LaunchTeamTemplateResponseSchema` (`launch`: template, sessionId, team; `claudeVersion`, `untestedVersion`) |
| `GET /api/config` | - | `GetConfigResponseSchema` |
| `PATCH /api/config` | `PatchConfigRequestSchema` | `PatchConfigResponseSchema` (`config`, `restartRequired`) |
| `POST /api/hooks` | Claude Code hook input (`HookPayloadSchema`), headers `X-Agent-Hub-Hook-Token`, `X-Agent-Hub-Session-Id` | `204` without body, or `401` |
| `GET /api/hooks/status` | - | `HookStatusSchema` |
| `POST /api/hooks/install` | `HookChangeRequestSchema` (empty) | `HookChangeResponseSchema` (`changed`, `status`) |
| `POST /api/hooks/uninstall` | `HookChangeRequestSchema` (empty) | `HookChangeResponseSchema` |
| `GET /api/mcp` | `ListMcpServersQuerySchema` (`projectPath?`) | `ListMcpServersResponseSchema` (`servers` masked, `mode`, `cliVersion?`) |
| `PUT /api/mcp` | `UpsertMcpServerRequestSchema` (`name`, `scope`, `config` with `{ keep: true }` values) | `UpsertMcpServerResponseSchema` (`server`, `created`) |
| `DELETE /api/mcp` | `RemoveMcpServerRequestSchema` (body `name`, `scope`) | `RemoveMcpServerResponseSchema` |

### WebSocket protocol

One connection per browser tab at `/ws?v=<WS_PROTOCOL_VERSION>` (currently `1`), multiplexing all sessions by `sessionId`. Each frame is one JSON text message with a `type` discriminator. On a version mismatch the server sends `error` with `protocol_mismatch` and closes the connection.

Terminal data (`input`, `output`, `scrollback`) is a plain UTF-8 string, not base64. Terminal I/O is almost entirely text, xterm.js consumes strings directly, and base64 would add a third more bytes plus encode/decode work per frame. The server decodes pty bytes with a streaming UTF-8 decoder, so multi-byte characters are never split across frames.

| Direction | `type` | Fields | Meaning |
| --- | --- | --- | --- |
| client to server | `attach` | `sessionId`, `cols`, `rows`, `scrollback` (default `true`) | Start streaming a session, resize it, optionally replay history first. |
| client to server | `detach` | `sessionId` | Stop streaming; the session keeps running in tmux. |
| client to server | `input` | `sessionId`, `data` | Keystrokes for the session. |
| client to server | `resize` | `sessionId`, `cols`, `rows` | Pane size changed. |
| client to server | `ping` | - | Keep-alive. |
| server to client | `output` | `sessionId`, `data` | Live terminal output. |
| server to client | `scrollback` | `sessionId`, `data` | History sent once after `attach`, before any `output`. |
| server to client | `state` | `sessionId`, `state`, `lifecycle`, `exitCode?`, `stateSince?` | Activity or lifecycle changed; `stateSince` is the base for the UI's elapsed timer (follow-up). |
| server to client | `session.created` | `session` | A session was created (by any client or a preset). |
| server to client | `session.removed` | `sessionId` | A session was killed or cleaned up. |
| server to client | `error` | `sessionId?`, `code`, `message` | `bad_message`, `protocol_mismatch`, `unknown_session`, `not_attached`, `tmux_unavailable`, `internal`. |
| server to client | `pong` | - | Answer to `ping`. |

`parseClientMessage` and `parseServerMessage` turn a raw text frame into a typed message or a readable error.

```mermaid
sequenceDiagram
    participant C as Browser (xterm.js)
    participant S as Agent Hub server
    participant T as tmux session
    C->>S: attach {sessionId, cols, rows, scrollback: true}
    S->>T: resize window to cols x rows
    S->>T: capture history
    S-->>C: scrollback {sessionId, data}
    loop while attached
        T-->>S: pty output
        S-->>C: output {sessionId, data}
        C->>S: input {sessionId, data}
        S->>T: write keys
    end
    C->>S: resize {sessionId, cols, rows}
    S->>T: resize window
    C->>S: detach {sessionId}
    Note over S,T: tmux session keeps running
```

### Known risks

- **No WebSocket flow control in v1.** The server watches `bufferedAmount` per connection, coalesces output for slow clients and closes them with `4008` above 8 MiB pending (output is never dropped); `pause`/`resume` messages are reserved for protocol v2.
- **Frame size.** The server must set the ws `maxPayload` option so a single oversized client frame cannot exhaust memory.
- **Scrollback race.** While capturing scrollback after `attach`, the server buffers live output and sends it after the `scrollback` frame; the visible screen comes from a tmux redraw and is never duplicated (details in [Attach and scrollback ordering](#attach-and-scrollback-ordering)).
- **Multiple clients at different sizes.** A tmux session has one size; the last `attach` or `resize` wins and other attached clients render at that size.
