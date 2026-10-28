# ADR 0002: tmux as session backbone

- Status: accepted
- Date: 2026-10-27

## Context

Sessions must survive browser close and server restart, and closing an app tab must kill its sessions on purpose. A Node process owning ptys directly loses every session when it crashes or is restarted (systemd restart, update).

## Decision

Every Paneful Manager session runs in its own tmux session `pm-<sessionId>` on a dedicated tmux server (`tmux -L paneful-manager`). The server attaches to a session with node-pty (`tmux attach-session -t =pm-<id>`, one pty per attached session, shared by all clients) and controls tmux otherwise via `execFile`. On startup it re-adopts existing `pm-*` sessions by listing `tmux list-sessions -F` and reconciling them with `$STATE/sessions/*.json`. Targets use exact matching (`=pm-<id>`, `=pm-<id>:`).

The tmux server is owned by a dedicated user unit `paneful-manager-tmux.service` (`Type=forking`, `tmux -L paneful-manager -f $STATE/tmux.conf start-server`, with `exit-empty off` and `remain-on-exit on` in `tmux.conf`). `paneful-manager.service` has `Wants=` and `After=paneful-manager-tmux.service`. The engine never creates the tmux server; if it is missing, it reports `tmux_unavailable` and refuses to create sessions. The installer enables lingering (`loginctl enable-linger`) and requires tmux 3.2 or later (`new-session -e`).

## Consequences

- Server restarts and crashes are invisible to running Claude Code sessions.
- Scrollback comes from `tmux capture-pane`; history depth is the tmux `history-limit`.
- tmux 3.2+ is a hard runtime dependency, checked by the installer (`tmux -V`).
- Restarting or stopping `paneful-manager.service` never touches tmux; stopping `paneful-manager-tmux.service` kills all sessions.
- WSL idle shutdown still ends all sessions (assumed, verify in T60).
- One size per session: the last resize wins across clients.
- Splits and tabs are drawn by the browser, never by tmux panes.

## Alternatives considered

- node-pty only: simplest, but every restart kills all sessions.
- GNU screen or abduco/dtach: weaker scripting interface (no format strings for listing, capture, exit status) or no scrollback capture.
- A custom pty-holder daemon: reimplements what tmux already does reliably.
- User's default tmux socket: would mix Paneful Manager sessions with the user's own and risk touching them.
- Server starts tmux via `systemd-run --user --scope`: works, but the server then owns the tmux lifecycle and a missing scope unit is hard to diagnose.
- `KillMode=process` on `paneful-manager.service`: tmux would stay in the service cgroup as a leftover process; systemd discourages this mode.
