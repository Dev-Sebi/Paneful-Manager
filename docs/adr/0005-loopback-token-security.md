# ADR 0005: Loopback-only server with token security model

- Status: accepted
- Date: 2026-10-27

## Context

Agent Hub can spawn processes and write files as the user. v1 is single-user without login. The realistic attacker is a malicious web page in the same browser (CSRF, DNS rebinding, cross-site WebSocket hijacking), not a network attacker.

## Decision

- Bind `127.0.0.1` only; not configurable. `hostId` stays reserved for a later multi-host model.
- Host header allowlist (`127.0.0.1:<port>`, `localhost:<port>`, dev port) on every request.
- Origin allowlist on mutating requests and WS upgrades; no CORS headers.
- Per-boot random token required on every mutating request (`X-Agent-Hub-Token`) and on the WS upgrade (`token` query, redacted in logs).
- A separate persisted hook token in `$STATE/hook-token` (`0600`) authenticates Claude Code hook requests, because re-adopted sessions keep their environment across restarts.
- `execFile` with argument arrays only; path inputs resolved with `realpath` against an allowlist; secrets (MCP env, headers, tokens) never sent to the browser or logs.

## Consequences

- No login screen; the browser on the same machine just works.
- Other local processes of the same user are not defended against (out of scope).
- Adding remote access later needs real authentication and a new ADR.

## Alternatives considered

- Login with password: friction without real gain on a single-user machine.
- Unix socket plus local proxy: the Windows browser cannot reach it directly.
- Token only, without Host/Origin checks: a rebinding page could still read unprotected GET responses.
