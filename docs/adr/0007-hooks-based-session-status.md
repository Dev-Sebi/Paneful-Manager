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
- Header env interpolation, unset-variable behavior and minimum Claude Code version are assumed, verify in T26/T50.

## Alternatives considered

- Parsing terminal output: fragile, version dependent.
- `command` hooks running a helper script: works with older Claude Code versions, but costs a process spawn per event; kept as fallback.
- Reading transcript files: delayed and format-dependent.
