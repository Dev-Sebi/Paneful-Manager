# ADR 0007: Hooks-based session status

- Status: accepted
- Date: 2026-10-27

## Context

The UI shows whether each Claude Code session is working, waiting for the user, idle or failed. Parsing terminal output for this is fragile and breaks with every UI change of Claude Code.

## Decision

- Session status comes from Claude Code hooks. Agent Hub merges `http` hook handlers into `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude`; never overwriting other entries) that POST to `http://127.0.0.1:<port>/api/hooks` with a 5 s `timeout`. Non-2xx responses and connection failures are non-blocking for Claude Code (verified).
- Sessions spawned by Agent Hub get `AGENT_HUB_SESSION_ID` and `AGENT_HUB_HOOK_TOKEN` in their tmux environment; the hook headers carry both, so the server maps events to its session and ignores everything else.
- Mapping: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart` -> `working`; `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`) -> `waiting`; `Stop`, `Notification` (`idle_prompt`), `SessionStart` -> `idle`; `StopFailure` -> `error`. `SessionEnd` only triggers an exit poll. Lifecycle (`exited`, exit code) comes from tmux, not hooks.

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
- All mapped event names exist; `Notification` input carries `notification_type` and supports the matchers `permission_prompt`, `idle_prompt` and `elicitation_dialog`; `Stop` and `UserPromptSubmit` ignore matchers.
- `disableAllHooks` and `allowedHttpHookUrls` / `httpHookAllowedEnvVars` can be set in any settings file (lists merge); `allowManagedHooksOnly` is managed-only. Managed files on Linux and WSL live in `/etc/claude-code/`.
- Settings files are strict JSON. A value the schema rejects turns the whole file into a Settings Error, so unknown keys inside a handler are a real risk.

### Still assumed

- A listed but unset variable yields an empty header.
- Minimum Claude Code version for `http` hooks and `StopFailure` (not stated in the reference).

### Marker strategy

Handlers carry no marker key. Agent Hub's handlers are identified by their exact URL `http://127.0.0.1:<port>/api/hooks` (any port, `HOOK_URL_PATTERN`). Install updates them in place when the port changes, removes duplicates and entries for events no longer mapped; uninstall removes only them plus the groups, event keys or `hooks` key they leave empty.

### Changes to the decision

- Header names are `X-Agent-Hub-Session-Id` and `X-Agent-Hub-Hook-Token`; sessions also get `AGENT_HUB_URL`. A wrong hook token is `401`; a request with both headers empty (Claude sessions not started by Agent Hub) is `204` and ignored.
- Mapping per the T26 brief: `SessionStart` -> `working` (was `idle`), `Notification(idle_prompt)` -> `waiting` (was `idle`), `SubagentStop` -> `idle`, `SessionEnd` -> `idle` plus an exit poll; `SubagentStart` no longer changes state. `mapHookEvent` in `packages/shared/src/hooks.ts` holds the table.
- `Session` gains `stateSince`, set when `state` changes; `state` frames carry it.
- Re-adopted sessions keep their original environment; they report status only if they were started with the current token and port.
