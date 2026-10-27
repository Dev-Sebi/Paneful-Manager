# ADR 0002: tmux as session backbone

- Status: accepted
- Date: 2026-10-27

## Context

Sessions must survive browser close and server restart, and closing an app tab must kill its sessions on purpose. A Node process owning ptys directly loses every session when it crashes or is restarted (systemd restart, update).

## Decision

Every Agent Hub session runs in its own tmux session `ah-<sessionId>` on a dedicated tmux server (`tmux -L agent-hub`). The server attaches to a session with node-pty (`tmux attach-session -t =ah-<id>`, one pty per attached session, shared by all clients) and controls tmux otherwise via `execFile`. On startup it re-adopts existing `ah-*` sessions by listing `tmux list-sessions -F` and reconciling them with `$STATE/sessions/*.json`. Under systemd the tmux server runs in its own scope so stopping the service does not kill it. `remain-on-exit` keeps dead panes so exit codes can be read.

## Consequences

- Server restarts and crashes are invisible to running Claude Code sessions.
- Scrollback comes from `tmux capture-pane`; history depth is the tmux `history-limit`.
- tmux is a hard runtime dependency, checked by the installer.
- One size per session: the last resize wins across clients.
- Splits and tabs are drawn by the browser, never by tmux panes.

## Alternatives considered

- node-pty only: simplest, but every restart kills all sessions.
- GNU screen or abduco/dtach: weaker scripting interface (no format strings for listing, capture, exit status) or no scrollback capture.
- A custom pty-holder daemon: reimplements what tmux already does reliably.
- User's default tmux socket: would mix Agent Hub sessions with the user's own and risk touching them.
