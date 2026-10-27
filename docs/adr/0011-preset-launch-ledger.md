# ADR 0011: Preset launch ledger for autostart

- Status: accepted
- Date: 2026-10-27

## Context

Presets with `autostart: true` are launched when the server starts. tmux sessions survive a server restart and are re-adopted, so a plain "launch on start" would open a second copy of every autostart preset after each restart. The server must tell a preset that is still running from one that is not, and it must do so after a restart.

## Decision

- The server keeps `$STATE/preset-launches.json`, a map from preset name to the ids of the sessions it launched. Every launch, manual or autostart, appends its ids.
- Autostart skips a preset when at least one recorded id still exists in the engine; otherwise it launches the preset. Ids of sessions that no longer exist are dropped when the next launch is recorded.
- The ledger is written atomically like all state files. A missing or invalid file is treated as empty, which at worst launches an autostart preset once more.
- Launching rolls back: if any pane fails, the sessions created so far are killed and the original error is returned. Nothing is recorded for a failed launch.

## Consequences

- No change to the `Session` schema or the create request; session records stay free of preset knowledge.
- A preset whose sessions the user all closed starts again on the next server start, which is the intended meaning of autostart.
- A manually launched preset also blocks autostart while its sessions run.
- Autostarted sessions are not part of any browser tab. They show up in the sessions list and can be adopted into tabs by the "Recovered" tab mechanism or a later server-side tab restore; this is not solved here.

## Alternatives considered

- A `preset` field on the session record: ties session schema, create request and tmux re-adoption to presets, and orphan re-adoption cannot recover it.
- Matching running sessions by cwd and command: wrong when the user runs the same command by hand.
- Always launching at start: duplicates sessions on every restart.
