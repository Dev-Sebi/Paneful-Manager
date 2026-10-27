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
    STATE[("state dir: sessions, tabs, hook token, backups")]
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
  SD["systemd --user"] --> SVC["agent-hub.service: node server"]
  SD --> SCOPE["agent-hub-tmux.scope"]
  SCOPE --> TS["tmux server, socket name agent-hub"]
  TS --> S1["tmux session ah-id1: claude"]
  TS --> S2["tmux session ah-id2: claude"]
  SVC -.->|"node-pty: tmux attach-session"| S1
  SVC -.->|"execFile: new-session, kill-session, ls, capture-pane"| TS
```

- **Server.** Runs as the systemd user service `agent-hub.service` inside WSL (`Restart=on-failure`), installed by `install.sh` (T60). It binds `127.0.0.1:<port>` only (`BIND_HOST`, `resolvePort`). In development `pnpm dev` runs it with `tsx watch` instead.
- **One tmux server** with the dedicated socket name `agent-hub` (`tmux -L agent-hub ...`), so the user's own tmux sessions are never listed, touched or killed. It starts with a generated config `$STATE/tmux.conf` (`-f`): status line off, `remain-on-exit on` (exit codes stay readable), large `history-limit` for scrollback, `window-size latest`.
- **Own cgroup for tmux.** systemd kills every process in a service's cgroup on stop, which would take all sessions with it. When running under systemd the server starts the tmux server through `systemd-run --user --scope --unit=agent-hub-tmux`, so it lives outside the service cgroup. Without systemd (dev) tmux daemonizes itself and survives anyway. Exact unit flags are fixed in T60.
- **One tmux session per Agent Hub session**, running exactly one command (default `claude`) in one window and pane. Agent Hub layouts (splits, tabs) are drawn in the browser, never with tmux panes.
- **One pty per attached session.** When the first client attaches, the engine spawns `tmux -L agent-hub attach-session -t =ah-<id>` with node-pty and fans its output out to every attached WS client. When the last client detaches, the pty is closed; the tmux session keeps running. tmux therefore only ever sees one client per session, and the pty size is the session size.
- **All other tmux calls** (`new-session`, `kill-session`, `list-sessions`, `list-panes`, `capture-pane`, `resize-window`) use `execFile` with argument arrays. Targets always use the exact-match form `=ah-<id>` because tmux otherwise prefix-matches session names.

### Lifecycle operations

| Operation | What happens |
| --- | --- |
| Create (REST or preset autostart) | Generate id, write metadata (`lifecycle: starting`), `new-session -d -s ah-<id> -c <cwd> -x <cols> -y <rows> -e AGENT_HUB_SESSION_ID=<id> -e AGENT_HUB_HOOK_TOKEN=<token> -- <command> <args...>`, then `running`; broadcast `session.created`. Failure: `session_spawn_failed`, metadata removed. |
| Browser closed | Nothing. Sessions keep running; the pty closes when no client is attached. |
| Close app tab | Client asks for confirmation (`confirmCloseTab`), then `DELETE /api/sessions/:id` per pane: `kill-session -t =ah-<id>`, metadata deleted, `session.removed` broadcast. |
| Command exits | Pane stays dead (`remain-on-exit`); engine sets `lifecycle: exited` with `exitCode` from `#{pane_dead_status}`. The session stays visible until the user closes it. |
| Server restart | Re-adoption, see below. |

Exit detection polls `list-panes -F '#{pane_dead} #{pane_dead_status}'` for attached and unattached sessions on a short interval; the `SessionEnd` hook is only a hint that triggers an early poll.

### Re-adoption after restart

On startup the engine runs `tmux -L agent-hub list-sessions -F '#{session_name}\t#{session_created}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_current_path}'` (no server running = no sessions) and reconciles it with `$STATE/sessions/*.json`:

| tmux session | Metadata | Result |
| --- | --- | --- |
| `ah-<id>` exists | `sessions/<id>.json` exists | Adopted: `lifecycle` from `pane_dead`, `state` reset to `idle` until the next hook arrives. |
| `ah-<id>` exists | missing (orphan) | Adopted with reconstructed metadata: `cwd` from `pane_current_path`, `createdAt` from `session_created`, `title: "Recovered"`, `command` from `pane_start_command`. Never killed automatically. |
| missing | `sessions/<id>.json` exists | Stale record deleted. Clients still referencing the id get `unknown_session` and drop the pane. |
| name without `ah-` prefix | - | Ignored, never touched (someone used the socket manually). |

Re-adopted sessions keep the environment they were created with, which is why the hook token is persisted and not per boot (see [Security model](#security-model)).

## Naming and storage

### Session ids and tmux names

- Session ids are generated by the server: 12 characters of `crypto.randomBytes(9).toString('base64url')`, so the charset is `[A-Za-z0-9_-]`, the same as `TmuxSessionNameSchema`.
- tmux session name: `ah-<sessionId>` (`Session.tmuxSession`). The prefix marks sessions as ours during re-adoption and guarantees a name never starts with `-`.
- `SessionIdSchema` currently only checks `min(1)`. T12 should tighten it to the charset above so that every valid id yields a valid `tmuxSession`.

### Where things live

| Path | Content | Writer |
| --- | --- | --- |
| `$XDG_CONFIG_HOME/agent-hub/config.yaml` (default `~/.config/agent-hub/`) | `AppConfigSchema` | user + server (`PATCH /api/config`) |
| `.../agent-hub/workspaces/<name>.yaml` | `WorkspacePresetSchema`, file name = `name` | user + server (preset API) |
| `$XDG_STATE_HOME/agent-hub/` (default `~/.local/state/agent-hub/`, called `$STATE`) | runtime state, mode `0700` | server only |
| `$STATE/sessions/<id>.json` | one `Session` record, rewritten on every lifecycle or state change | server |
| `$STATE/tabs.json` | runtime tabs (`AppTabSchema[]`) incl. pane sizes, so tabs survive browser close | server |
| `$STATE/hook-token` | hook token, mode `0600`, created once | server |
| `$STATE/tmux.conf` | generated tmux config | server |
| `$STATE/backups/` | backups before overwriting or deleting files (see below) | server |
| journald (`journalctl --user -u agent-hub`) | logs (pino to stdout) | server |

The state directory follows the XDG base directory spec the same way `resolveConfigDir` does for config: `$XDG_STATE_HOME/agent-hub` when set, otherwise `~/.local/state/agent-hub`. A `resolveStateDir(env)` helper belongs next to `resolveConfigDir` in `packages/shared` (T12).

## WebSocket runtime behavior

The frame catalogue is in [Shared contracts](#websocket-protocol). This section defines how the server and client use it.

### Connection lifecycle

```mermaid
sequenceDiagram
    participant C as Browser
    participant S as Server
    C->>S: GET /ws?v=1&token=... (Upgrade)
    Note over S: Host, Origin, token, version checked before upgrade
    alt check fails
        S-->>C: HTTP 403 (bad Host/Origin/token)
    else version mismatch
        S-->>C: upgrade, error protocol_mismatch, close 4001
    else ok
        S-->>C: 101 Switching Protocols
        C->>S: attach (one per visible pane)
        S-->>C: scrollback, then output ...
    end
```

1. The client opens one socket per browser tab at `/ws?v=<WS_PROTOCOL_VERSION>&token=<token>` (browsers cannot set headers on WebSocket requests, so the token travels in the query; the logger redacts it).
2. It sends `attach` for every pane that is visible. Hidden app tabs are detached to save bandwidth and re-attached when shown.
3. `session.created`, `session.removed` and `state` frames are broadcast to every connection, attached or not, so sidebars stay current.
4. Invalid frames get `error bad_message` and are ignored; the connection stays open.

### Attach and scrollback ordering

For each `attach {sessionId, cols, rows, scrollback}`:

1. Unknown id: `error unknown_session`.
2. Register the client on the session; spawn the pty if it is the first client. Live output for this client is buffered from now on.
3. Apply the size (resize rule below).
4. If `scrollback` is `true`: `capture-pane -p -e -J -S -<history> -E -1 -t =ah-<id>` (history above the visible screen, with escape sequences) and send it as one `scrollback` frame. The client resets its xterm before writing it.
5. Ask tmux to redraw the visible screen (`refresh-client` through the pty), then flush the buffered output and stream `output` frames.

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

Output is never dropped silently in the middle of a stream, because dropping escape sequences corrupts the terminal. The pty itself is never paused in v1, since it is shared by all clients of a session. Protocol v2 reserves `pause`/`resume` frames for real per-client flow control.

### Limits, heartbeat, close codes

- `maxPayload`: 1 MiB per incoming frame (large pastes fit; larger frames close the connection with `1009`).
- Heartbeat: the server sends a WebSocket ping every 30 s and terminates connections that missed the previous pong. The client sends the app-level `ping` every 25 s and treats a missing `pong` after 10 s as a dead connection.
- Close codes: `1000` normal, `1001` server shutdown, `1009` frame too large, `4001` protocol mismatch, `4008` slow consumer.

### Reconnect semantics

- The client reconnects automatically with exponential backoff (0.5 s doubling to 10 s, with jitter), except after `4001` (reload the page to get a matching client).
- After reconnect it re-sends `attach` with `scrollback: true` for every visible pane and refetches `GET /api/sessions`, because `session.created`/`session.removed` frames during the outage were missed.
- Server restart looks like a reconnect: sessions were re-adopted, so attaching works unchanged. `GET /api/health` `protocolVersion` tells the client whether it must reload.
- Graceful shutdown closes all sockets with `1001` and all ptys; tmux sessions are left running.

## File-write policy

The server writes only these files; everything else is read-only:

| Target | How | Notes |
| --- | --- | --- |
| Own config: `config.yaml`, `workspaces/*.yaml` | File service, atomic | YAML written through the `yaml` Document API so user comments and unknown keys survive. Preset file name must equal `PresetNameSchema`. |
| Own state: `$STATE/**` | Atomic | No conflict check (server is the only writer). |
| Claude settings: `~/.claude/settings.json` | Merge `hooks` key only, atomic, conflict-checked | Adds Agent Hub hook entries if missing; never changes or removes other entries or keys. Uninstall removes only entries pointing at Agent Hub's hook URL. |
| `CLAUDE.md` and skills | File service, atomic, conflict-checked | Only inside allowlisted scopes: global `~/.claude/CLAUDE.md` and `~/.claude/skills/**`; for each configured project and its git worktrees `<root>/CLAUDE.md`, `<root>/CLAUDE.local.md`, `<root>/.claude/skills/**`. |
| MCP servers | `claude mcp add-json` / `claude mcp remove` via `execFile` | Never edit `~/.claude.json` or `.mcp.json` directly; the CLI owns their format. Exact subcommands are assumed, verify in T40. |
| Worktree helper | Copy gitignored files into a new worktree | Only after explicit confirmation, target must be inside the worktree (T34). |

### Rules

- **Atomic write:** write `<dir>/.<name>.agent-hub-<random>.tmp` in the same directory (same filesystem), copy the target's mode, `fsync`, `rename` over the target. A crash leaves either the old or the new file, never a partial one.
- **Conflict detection:** every read returns a version `{ mtimeMs, sha256 }`. Writes carry the version they are based on; right before the rename the server re-stats and re-hashes the target. Mismatch (or file created/deleted meanwhile) returns `409 conflict` with the current version, and the UI shows a diff or reload choice.
- **Never silent overwrite:** there is no force flag in the API. Overwriting after a conflict needs a fresh read. External changes are pushed to the UI by a file watcher (T31).
- **Symlinks:** paths are resolved with `realpath` and the resolved path must still be inside an allowlisted root. Writes go to the resolved target, so the link itself is kept. Links that resolve outside the allowlist are shown read-only. New files are never created through a dangling link.
- **Backups:** before the server overwrites or deletes a file it does not exclusively own (Claude settings, CLAUDE.md, skills, presets, `config.yaml`), the previous content is copied to `$STATE/backups/<yyyy-mm-dd>/<path-with-slashes-encoded>.<time>`; the last 20 backups per file are kept.

## Security model

Agent Hub is a single-user tool on loopback. The main attacker is a web page open in the same browser, not another user on the machine.

```mermaid
flowchart LR
  REQ[Incoming request] --> H{Host in allowlist?}
  H -- no --> X403[403]
  H -- yes --> M{Mutating or WS?}
  M -- no --> OK[Handle]
  M -- yes --> O{Origin allowed?}
  O -- no --> X403
  O -- yes --> T{Token valid?}
  T -- no --> X403
  T -- yes --> OK
```

| Control | Rule |
| --- | --- |
| Loopback bind | `127.0.0.1` only (`BIND_HOST`), not configurable. WSL localhost forwarding makes it reachable from the Windows browser. |
| Host allowlist | `127.0.0.1:<port>` and `localhost:<port>` (plus the Vite dev port in development). Blocks DNS rebinding, where an attacker domain resolves to 127.0.0.1. |
| Origin allowlist | Mutating requests and WS upgrades need `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>` (plus the dev origin). Missing `Origin` is rejected, except on the hook endpoint. No CORS headers are ever sent. |
| Per-boot token | 32 random bytes generated at startup, kept in memory. Required as `X-Agent-Hub-Token` on every `POST`/`PUT`/`PATCH`/`DELETE` and as `token` query on `/ws`. The SPA gets it from a same-origin bootstrap endpoint (added to `API_ROUTES` in T11); the Host/Origin checks plus missing CORS keep other origins from reading it. |
| Hook token | Separate random token in `$STATE/hook-token` (`0600`), stable across restarts because re-adopted sessions keep their environment. Only valid on `POST /api/hooks`. |
| Process spawning | `execFile`/node-pty with argument arrays only; never a shell, never string-built commands. Commands after `--` in `new-session`. |
| Path allowlist | Every path from a request is `~`-expanded, `path.resolve`d, `realpath`ed and checked against the allowlisted roots (prefix plus separator). `..` and symlink escapes fail. |
| No secrets to the browser | MCP `env` values and `headers` are masked (`***`) in API responses; an unchanged mask on save keeps the stored value. Tokens never appear in logs. |
| Validation | Every REST body and WS frame is parsed with strict zod schemas; unknown keys fail. |

### Threats

| Threat | In scope | Mitigation |
| --- | --- | --- |
| Malicious web page sends requests to `localhost:7337` (CSRF) | yes | Origin check + per-boot token |
| DNS rebinding | yes | Host allowlist |
| Cross-site WebSocket hijacking | yes | Origin check + token on upgrade |
| Path traversal / symlink escape via file API | yes | realpath + allowlist |
| Command injection via session `command`/`args`/`cwd` | yes | `execFile` only, zod validation |
| Secret leakage (MCP env, tokens) to page or logs | yes | Masking, log redaction |
| Forged hook events from a web page | yes | Hook token + session id header, no CORS |
| Oversized frames / memory exhaustion | yes | `maxPayload`, backpressure limits |
| Exposure to the LAN | yes | Loopback bind only; user-made port proxies are out of scope |
| Other local processes of the same user | no | They can already read `~/.claude` and run `claude` |
| Other OS users on a shared machine | no | v1 targets personal machines; the token is only a partial barrier |
| Malicious repository content (CLAUDE.md, skills, MCP servers in a project) | no | Claude Code's own trust model applies |
| Supply-chain attacks on dependencies | partly | Lockfile, CI dependency audit |

## Session state machine

`lifecycle` (process) and `state` (activity) are independent fields of `Session`. `state` only has meaning while `lifecycle` is `running`; on `exited` it keeps its last value and the UI shows the exit instead.

```mermaid
stateDiagram-v2
    [*] --> starting: POST /api/sessions
    starting --> running: tmux new-session ok
    starting --> [*]: spawn failed
    running --> exited: pane dead (exitCode)
    running --> [*]: kill (close tab)
    exited --> [*]: kill (close tab)

    state running {
        [*] --> idle
        idle --> working: UserPromptSubmit
        working --> working: PreToolUse / PostToolUse / SubagentStart
        working --> waiting: PermissionRequest / Notification(permission_prompt, elicitation_dialog)
        waiting --> working: PostToolUse / UserPromptSubmit
        working --> idle: Stop / Notification(idle_prompt)
        working --> error: StopFailure
        waiting --> idle: Stop
        error --> working: UserPromptSubmit
        error --> idle: SessionStart
    }
```

### Hook mapping

Claude Code supports `http` hooks that POST the hook input JSON to a URL, configured in `~/.claude/settings.json` (verified in the Claude Code hooks reference). Agent Hub merges one `http` handler per event below into the user settings, pointing at `http://127.0.0.1:<port>/api/hooks` with headers `X-Agent-Hub-Session: $AGENT_HUB_SESSION_ID` and `X-Agent-Hub-Hook-Token: $AGENT_HUB_HOOK_TOKEN` (`allowedEnvVars` lists both). Claude sessions not started by Agent Hub have no such variables; the server ignores their requests.

| Hook event (matcher) | New `state` | Verified |
| --- | --- | --- |
| `SessionStart` | `idle` | event yes |
| `UserPromptSubmit` | `working` | event yes |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart` | `working` | event yes |
| `PermissionRequest` | `waiting` | event yes |
| `Notification` (`permission_prompt`, `elicitation_dialog`) | `waiting` | matcher values yes |
| `Notification` (`idle_prompt`) | `idle` | matcher value yes |
| `Stop` | `idle` | event yes |
| `StopFailure` | `error` | event yes |
| `SessionEnd` | no change; triggers an exit poll | event yes |
| all others | ignored | - |

Assumed, verify in T26/T50:

- Environment variable interpolation in `http` hook headers works for variables set with `tmux new-session -e`, and an unset variable yields an empty header instead of a failed hook.
- `PostToolUse` after an approved permission prompt reliably moves `waiting` back to `working`; a denied prompt is followed by `Stop` or `UserPromptSubmit`.
- Hook delivery is fire-and-forget for Claude Code: a non-2xx response or an unreachable server (Agent Hub stopped) never blocks the session (the reference documents non-blocking errors; timing impact is unverified).
- Agent-team teammates (`TeammateIdle`, `TaskCreated`, `TaskCompleted`) need their own mapping behind `experimental.agentTeams`; not part of v1 state (T50).
- The minimum Claude Code version that supports `http` hooks and `StopFailure`; older versions would need a `command` hook fallback.

Each accepted hook updates `state` and `lastEventAt`, persists the record and broadcasts a `state` frame. Events for an `exited` session are ignored.

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
| `pnpm build` | `tsc` for shared and server, `vite build` for web. In production the server serves `apps/web/dist` and the SPA uses relative URLs, so one origin serves everything. |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | ESLint (flat config, `eslint-config-vuetify` + `typescript-eslint`), `tsc`/`vue-tsc --noEmit`, vitest per package. |

TypeScript is strict everywhere (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`). Node 22 and pnpm 11 are the minimum (`engines`).

Design tokens flow from `docs/design-system/tokens.json` through a build script into a generated Vuetify theme, CSS variables and an xterm theme (see `docs/design-system/README.md`); generated files are never edited by hand.

**CI** (GitHub Actions, T14): one workflow on push and pull request with a pnpm store cache running lint, typecheck, unit tests (vitest) and Playwright end-to-end tests. Merges to `main` require it to pass.

## Shared contracts

All contracts live in `packages/shared` (`@agent-hub/shared`) as zod schemas. Every schema is exported as `XSchema` with its inferred type `X` (and `XInput` where defaults make input and output differ). Server and web client import the same schemas, so validation and types never drift.

### Strict vs. passthrough

| Where data comes from | Unknown keys | Why |
| --- | --- | --- |
| REST bodies, WS frames, sessions, runtime tabs | rejected (`z.strictObject`) | Typos and protocol drift fail loudly at the boundary. |
| User files: `config.yaml`, preset YAML, MCP entries, layouts | kept (`z.looseObject`) | Users may add keys from newer versions or their own notes; a load/save cycle must not lose them. |

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
| `session.ts` | `SessionSchema` | One session = one tmux session: `id`, `hostId`, `title?`, `cwd`, `command`, `args`, `tmuxSession`, `createdAt`, `state`, `lifecycle`, `exitCode?` (only when exited), `lastEventAt`, `cols`, `rows`. Timestamps are ISO 8601 strings. |
| | `SessionStateSchema` | `working \| waiting \| error \| idle`, derived from Claude Code hooks. |
| | `SessionLifecycleSchema` | `starting \| running \| exited`. |
| `layout.ts` | `LayoutSchema` | `single \| row \| column \| grid-2x2 \| custom`; `custom` carries a split tree (`LayoutNodeSchema`) whose leaves point at pane indexes and carry relative `size` weights. |
| | `AppTabSchema`, `AppPaneSchema` | Runtime tab with 1-6 panes, each a `sessionId` plus optional `size`. |
| | `validateLayoutPanes` | `single` = 1 pane, `grid-2x2` = 4, `custom` must reference each pane exactly once. |
| `preset.ts` | `WorkspacePresetSchema` | Preset file: `name` (also the file name), `description?`, `autostart` (false), `tabs[]`. |
| | `PresetTabSchema`, `PresetPaneSchema` | Tab: `title?`, `layout` (default `row`; string shorthand `single \| row \| column \| grid-2x2` or the object form, `custom` needs the object), 1-6 panes. Pane: `cwd`, `command` (`claude`), `args` (`[]`), `title?`, `size?`. |
| `mcp.ts` | `McpServerSchema` | Discriminated by `transport`: `stdio` (`command`, `args`, `env?`) or `http`/`sse` (`url`, `headers?`); `scope` is `global \| project \| worktree`. |
| `api.ts` | `ApiErrorSchema` | Every non-2xx body: `{ code, message, details? }`; `validation_failed` requires `details: { path, message }[]` (`toValidationError`). |
| | REST schemas | See table below. |
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
| `GET /api/health` | - | `HealthResponseSchema` (`status`, `name`, `version`, `protocolVersion`, `uptimeSec`) |
| `GET /api/sessions` | - | `ListSessionsResponseSchema` |
| `POST /api/sessions` | `CreateSessionRequestSchema` (`cwd`, `command`, `args`, `title?`, `cols`, `rows`) | `CreateSessionResponseSchema` |
| `DELETE /api/sessions/:id` | `SessionParamsSchema` | `KillSessionResponseSchema` |
| `GET /api/presets` | - | `ListPresetsResponseSchema` |
| `GET /api/presets/:name` | `PresetParamsSchema` | `PresetResponseSchema` |
| `POST /api/presets` | `UpsertPresetRequestSchema` | `PresetResponseSchema` |
| `PUT /api/presets/:name` | `UpsertPresetRequestSchema` (full replace) | `PresetResponseSchema` |
| `DELETE /api/presets/:name` | `PresetParamsSchema` | `DeletePresetResponseSchema` |
| `GET /api/config` | - | `GetConfigResponseSchema` |
| `PATCH /api/config` | `PatchConfigRequestSchema` | `PatchConfigResponseSchema` (`config`, `restartRequired`) |

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
| server to client | `state` | `sessionId`, `state`, `lifecycle`, `exitCode?` | Activity or lifecycle changed. |
| server to client | `session.created` | `session` | A session was created (by any client or a preset). |
| server to client | `session.removed` | `sessionId` | A session was killed or cleaned up. |
| server to client | `error` | `sessionId?`, `code`, `message` | `bad_message`, `protocol_mismatch`, `unknown_session`, `not_attached`, `internal`. |
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

- **No WebSocket flow control in v1.** The server watches `bufferedAmount` per connection and drops or coalesces output for slow clients; `pause`/`resume` messages are reserved for protocol v2.
- **Frame size.** The server must set the ws `maxPayload` option so a single oversized client frame cannot exhaust memory.
- **Scrollback race.** While capturing scrollback after `attach`, the server buffers live output and sends it after the `scrollback` frame; the visible screen comes from a tmux redraw and is never duplicated (details in [Attach and scrollback ordering](#attach-and-scrollback-ordering)).
- **Multiple clients at different sizes.** A tmux session has one size; the last `attach` or `resize` wins and other attached clients render at that size.
