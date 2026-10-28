# ADR 0007: Hooks-based session status

- Status: accepted
- Date: 2026-10-27

## Context

The UI shows whether each Claude Code session is working, waiting for the user, idle or failed. Parsing terminal output for this is fragile and breaks with every UI change of Claude Code.

## Decision

- Session status comes from Claude Code hooks. Agent Hub merges `http` hook handlers into `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude`; never overwriting other entries) that POST to `http://127.0.0.1:<port>/api/hooks` with a 5 s `timeout`. Non-2xx responses and connection failures are non-blocking for Claude Code (verified).
- Sessions spawned by Agent Hub get `AGENT_HUB_SESSION_ID` and `AGENT_HUB_HOOK_TOKEN` in their tmux environment; the hook headers carry both, so the server maps events to its session and ignores everything else.
- Mapping (amended in T26):

  | Event | State |
  | --- | --- |
  | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `working` |
  | `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) | `waiting` |
  | `Stop`, `Notification` (`idle_prompt`), `SessionEnd` | `idle`; `SessionEnd` also triggers an exit poll |
  | `StopFailure` | `error` |
  | `SessionStart`, `SubagentStart`, `SubagentStop`, everything else | no change, not installed |

  Lifecycle (`exited`, exit code) comes from tmux, not hooks.

## Consequences

- Status is precise and independent of terminal rendering.
- Commands other than `claude` stay `idle`.
- After a server restart, state is `idle` until the next hook event.
- `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls` and `httpHookAllowedEnvVars` can block the hooks; the UI then shows "status unavailable".
- The hook URL contains the port, so a port change re-merges the entries.
- Unset-variable behavior and the minimum Claude Code version remain assumed (see the amendment).

## Alternatives considered

- Parsing terminal output: fragile, version dependent.
- `command` hooks running a helper script: works with older Claude Code versions, but costs a process spawn per event; kept as fallback.
- Reading transcript files: delayed and format-dependent.

## Amendment (T26, 2026-10-27)

### Verified against the Claude Code hooks and settings references

- `http` handlers take `url`, `headers`, `allowedEnvVars` and the common `timeout`; header values interpolate `$VAR` / `${VAR}` only for variables listed in `allowedEnvVars`, unlisted ones become empty strings.
- The body is the hook input as JSON. An empty 2xx is success, a 2xx with a JSON body is parsed as hook output, non-2xx, connection failures and timeouts are non-blocking errors. The endpoint therefore answers `204` without a body.
- All mapped event names exist; `Notification` input carries `notification_type` and supports the matchers `permission_prompt`, `idle_prompt`, `elicitation_dialog` and `elicitation_url_dialog`; `Stop` and `UserPromptSubmit` ignore matchers.
- `SessionStart` (and `Setup`) support only `command` and `mcp_tool` hooks, so an `http` entry there cannot work and is not installed.
- `disableAllHooks` and `allowedHttpHookUrls` / `httpHookAllowedEnvVars` can be set in any settings file (lists merge); `allowManagedHooksOnly` is managed-only. Managed files on Linux and WSL live in `/etc/claude-code/`.
- Settings files are strict JSON. A value the schema rejects turns the whole file into a Settings Error, so unknown keys inside a handler are a real risk.

### Still assumed

- A listed but unset variable yields an empty header.
- Minimum Claude Code version for `http` hooks and `StopFailure` (not stated in the reference).

### Marker strategy

Handlers carry no marker key. Agent Hub's handlers are identified by their exact URL `http://127.0.0.1:<port>/api/hooks` (any port, `HOOK_URL_PATTERN`). Install updates them in place when the port changes, removes duplicates and entries for events no longer mapped; uninstall removes only them plus the groups, event keys or `hooks` key they leave empty.

### Changes to the decision

- Header names are `X-Agent-Hub-Session-Id` and `X-Agent-Hub-Hook-Token`; sessions also get `AGENT_HUB_URL`. A wrong hook token is `401`; a request with both headers empty (Claude sessions not started by Agent Hub) is `204` and ignored.
- Mapping as in the Decision table: `SessionStart` dropped (no `http` support), `SubagentStart` and `SubagentStop` change nothing, `elicitation_url_dialog` added to `waiting`, `SessionEnd` sets `idle` and triggers the exit poll. `mapHookEvent` in `packages/shared/src/hooks.ts` holds the table; install removes Agent Hub entries from events no longer listed.
- `allowedHttpHookUrls` patterns are matched case-sensitively (the hook URL is always lower case); invalid managed settings files are reported as `settings_invalid`, hidden drop-ins are skipped.
- The hook token file is written to an `O_EXCL` temp file (`wx`, mode 0600) and renamed into place, never truncated. Creating or replacing it (missing or corrupt file) happens under the lock file `hook-token.lock` (exclusive create, holder `pid:nonce`, broken when its process is gone or it is older than 10 s), so concurrent server starts agree on one token. Temp files left by interrupted writes (`.hook-token.*.tmp`, `session-env.tmux.*.tmp`) older than 60 s are removed on start.
- `Session` gains `stateSince`, set when `state` changes; `state` frames carry it.
- Re-adopted sessions keep their original environment; they report status only if they were started with the current token and port.

## Amendment (SEC-017, 2026-10-28)

- Earlier builds passed the hook token in tmux's argv, readable by other local users. The token is now renewed when the installed version differs from `$STATE/hook-token.version` (a missing file counts as different), and rotated after an install or uninstall in Settings that changed the settings file.
- Running sessions cannot receive a new environment. Their hooks fail closed with `401` (non-blocking for Claude Code; the session keeps its last state, the server is unaffected). The server lists them in `staleSessions` of `GET /api/hooks/status`, and Settings asks to restart them. New sessions get the current token because `session-env.tmux` is rewritten before every `new-session`.
- A session id is visible in argv (`-e AGENT_HUB_SESSION_ID`), so any local user can make a known session appear in `staleSessions` by sending a wrong token; the next valid hook clears it. The list is a hint only and changes no state.
