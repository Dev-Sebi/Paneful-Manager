# ADR 0005: Loopback-only server with token security model

- Status: accepted, amended by [ADR 0013](0013-access-key-against-local-users.md) (access key against other local users)
- Date: 2026-10-27

## Context

Agent Hub can spawn processes and write files as the user. v1 is single-user without login. The realistic attacker is a malicious web page in the same browser (CSRF, DNS rebinding, cross-site WebSocket hijacking), not a network attacker.

## Decision

- Bind `127.0.0.1` only; not configurable. `hostId` stays reserved for a later multi-host model.
- Host header allowlist on every request: `localhost:<port>`, `127.0.0.1:<port>`, `[::1]:<port>`, and bare `localhost` (`isAllowedHost` in `apps/server/src/security/origin.ts`). The Vite dev port is not part of it; in development the UI reaches the server through the Vite proxy, which rewrites Host.
- Origin allowlist on mutating requests and WS upgrades; no CORS headers.
- The Origin check is the primary CSRF control; the token is defense in depth.
- Per-boot random token, new on every restart, required on every mutating request (`X-Agent-Hub-Token`). The client fetches it from `GET /api/session-token` before every WS connect and refetches once after any `401`/`403`. Since ADR 0013 that route, like every other API route, also needs the persisted access key.
- WebSocket auth uses `Sec-WebSocket-Protocol: agent-hub.v1, token.<t>`; the server echoes only `agent-hub.v1`. No secret in the URL, so nothing lands in access logs. pino redacts the token headers.
- A separate persisted hook token in `$STATE/hook-token` (`0600`) authenticates Claude Code hook requests, because re-adopted sessions keep their environment across restarts. `POST /api/hooks` is exempt from the per-boot token and rejects any request carrying an `Origin` header.
- `execFile` with argument arrays only; path inputs resolved with `realpath` against an allowlist; secrets (MCP env, headers, tokens) never sent to the browser or logs.

## Consequences

- No login screen; the browser on the same machine just works.
- Other local processes of the same user are not defended against (out of scope). The hook token in the session environment is readable by the same user and child processes; the impact is forged status only (accepted).
- Clients must handle token rotation on server restart.
- Adding remote access later needs real authentication and a new ADR.

## Alternatives considered

- Login with password: friction without real gain on a single-user machine.
- Unix socket plus local proxy: the Windows browser cannot reach it directly.
- Token only, without Host/Origin checks: a rebinding page could still read unprotected GET responses.
- Token in the WS query string: simplest for browsers, but ends up in logs and proxies.
