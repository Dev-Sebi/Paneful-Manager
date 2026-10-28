# ADR 0013: Access key against other local users

- Status: accepted, amended by [ADR 0014](0014-device-login-against-origin-squatting.md) (browsers log in with a non-extractable device key and a one-time login code; the access key is for scripts only)
- Date: 2026-10-28
- Amends: [ADR 0005](0005-loopback-token-security.md)

> Since ADR 0014 the login URL carries a one-time code (`#login=<code>`), not the access key, and no browser stores the key. The parts below about the browser storing the key describe the state before ADR 0014.

## Context

ADR 0005 protects the server against web pages in the user's browser. It does not protect against other OS users on the same machine: loopback is shared by every account, `GET /api/session-token` handed the per-boot token to any client that sent no `Origin`, and every read route (`GET /api/files/content`, `/api/sessions`, `/api/mcp`, ...) answered without any credential. On a shared host another user could read the owner's files and drive sessions with plain `curl`.

Constraints:

- The browser is often on the Windows host and reaches the server through WSL localhost forwarding. Seen from the server, such a connection comes from the forwarding relay, not from the browser's user, so the peer uid of the socket (`/proc/net/tcp`, `SO_PEERCRED` on TCP) cannot identify the caller.
- A native Linux browser on the same machine must work the same way.
- The development setup (Vite on `:3000` proxying `/api` and `/ws`) and the e2e suite must keep working.

## Decision

- The server creates a persisted **access key** once: 32 random bytes, base64url, in `$STATE/access-key` with mode `0600` inside the `0700` state directory (same loader as the hook token). Only the owner and root can read it. It survives restarts.
- Every `/api/*` request must carry it in `X-Agent-Hub-Key` (`ACCESS_KEY_HEADER`), compared in constant time; otherwise `401 login_required`. Exempt: `GET`/`HEAD /api/health` (installer and monitoring; reveals name, version, protocol version, uptime and whether tmux is available) and `POST /api/hooks` (has its own hook token). The check runs in the same `onRequest` hook as the Host and Origin checks, so it also covers unknown routes.
- `GET /api/session-token` therefore needs the key. The per-boot token, the Origin rules and the WebSocket subprotocol stay as in ADR 0005; the WebSocket is reachable only with the per-boot token, which only a key holder can fetch.
- The browser gets the key out of band through a **login URL**: `http://127.0.0.1:<port>/#key=<key>`. The key sits in the fragment, so the browser never sends it to the server and it never lands in access logs. The SPA reads the fragment before the router starts, stores the key in `localStorage` and removes the fragment with `history.replaceState`. `localStorage` is scoped to scheme, host and port.
- The key is kept only on the bound address `127.0.0.1` (`isTrustedHost` in `apps/web/src/api/access.ts`); the login URL and the Vite dev server use it too. `localhost` may resolve to `::1`, and a socket on `[::1]:<port>` is free while the server holds `127.0.0.1:<port>`: another local user listening there would receive the login URL page (and read the fragment) or the stored key of the `localhost` origin. Under any other host name the SPA strips the fragment without storing it, deletes a stored key and asks to switch to `127.0.0.1`.
- The login URL is printed by the installer after a successful start and later by `install.sh --login-url`; in a checkout by `pnpm login-url [--port <vite port>]`. Nothing opens it automatically: a browser started with the URL as an argument would expose the key in its command line.
- Without a stored key, or after a `401 login_required`, the web app shows only a hint to open the login URL and loads nothing.

### Secrets in process arguments

Every process's argv is readable by all local users in `/proc/<pid>/cmdline` (unless `/proc` is mounted with `hidepid`), so no secret is passed as an argument:

- Hook token: the engine writes `set-environment -g AGENT_HUB_HOOK_TOKEN '<token>'` to `$STATE/session-env.tmux` (`0600`, atomic) and runs `tmux source-file <file> ; new-session ...` in one call. tmux reads the file and puts the token into its global environment, from which the pane inherits it. Only non-secret values (`AGENT_HUB_SESSION_ID`, `AGENT_HUB_URL`) stay as `new-session -e` arguments. Names and values are validated, so the file holds only these commands.
- MCP secrets: an entry with env or header values is written in file mode instead of through `claude mcp add-json <json>` ([ADR 0009](0009-mcp-config-via-cli.md)).

## Consequences

- Other OS users cannot read the key, so they get `401 login_required` on every route except health and the hook route.
- Each browser profile needs the login URL once, and once more for the Vite dev server (another origin). After clearing site data it is needed again.
- Rotating the key: delete `$STATE/access-key` and restart the server; every browser must log in again.
- Script access to the API needs the header. Pass the key through stdin, not in `curl`'s arguments: `printf 'X-Agent-Hub-Key: %s\n' "$(cat ~/.local/state/agent-hub/access-key)" | curl -H @- ...` (`printf` is a shell builtin).
- A script running in the owner's page (XSS) could read the key from `localStorage`. Such a script can already drive the API, and the CSP limits where it can send data (`connect-src`).
- Residual (fixed by [ADR 0014](0014-device-login-against-origin-squatting.md)): while Agent Hub is not running (boot, upgrade, crash), another local user can bind `127.0.0.1:<port>` and serve a page in the owner's origin, which can read the stored key. A browser tab left open or reopened in that window leaks it.
- Keys stored by builds before this change under `localhost` stay in that origin until the app is opened there once and deletes them; clear the site data of `http://localhost:<port>` to be sure.
- Root and processes of the same user can still read the key; they are out of scope as in ADR 0005.
- The hook token sits in the global environment of Agent Hub's own tmux server (socket `agent-hub`), so every pane there inherits it, also windows a user opens by hand. Only the same user can read it.
- Real WSL localhost forwarding was not tested automatically; the design does not depend on the peer address, so forwarded and direct connections behave the same.

## Alternatives considered

- Peer uid lookup through `/proc/net/tcp`: works for a native Linux browser, but WSL-forwarded connections come from the relay, so the Windows browser would be locked out or the check would have to trust the relay's uid.
- HttpOnly `SameSite=Strict` cookie set by a one-time login URL: cookies are not scoped by port, so a server of another local user on `localhost:<other port>` receives the cookie as soon as the owner opens a page there. `localStorage` is port-scoped.
- Putting the per-boot token in the login URL: every server restart (upgrade, crash) would force a new login.
- Login with a password: friction without gain over a key file that only the owner can read.
- Unix socket with file permissions: the Windows browser cannot reach it (as in ADR 0005).
