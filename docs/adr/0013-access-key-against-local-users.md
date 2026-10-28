# ADR 0013: Access key against other local users

- Status: accepted
- Date: 2026-10-28
- Amends: [ADR 0005](0005-loopback-token-security.md)

## Context

ADR 0005 protects the server against web pages in the user's browser. It does not protect against other OS users on the same machine: loopback is shared by every account, `GET /api/session-token` handed the per-boot token to any client that sent no `Origin`, and every read route (`GET /api/files/content`, `/api/sessions`, `/api/mcp`, ...) answered without any credential. On a shared host another user could read the owner's files and drive sessions with plain `curl`.

Constraints:

- The browser is often on the Windows host and reaches the server through WSL localhost forwarding. Seen from the server, such a connection comes from the forwarding relay, not from the browser's user, so the peer uid of the socket (`/proc/net/tcp`, `SO_PEERCRED` on TCP) cannot identify the caller.
- A native Linux browser on the same machine must work the same way.
- The development setup (Vite on `:3000` proxying `/api` and `/ws`) and the e2e suite must keep working.

## Decision

- The server creates a persisted **access key** once: 32 random bytes, base64url, in `$STATE/access-key` with mode `0600` inside the `0700` state directory (same loader as the hook token). Only the owner and root can read it. It survives restarts.
- Every `/api/*` request must carry it in `X-Agent-Hub-Key` (`ACCESS_KEY_HEADER`), compared in constant time; otherwise `401 login_required`. Exempt: `GET`/`HEAD /api/health` (installer and monitoring; reveals only name and version) and `POST /api/hooks` (has its own hook token). The check runs in the same `onRequest` hook as the Host and Origin checks, so it also covers unknown routes.
- `GET /api/session-token` therefore needs the key. The per-boot token, the Origin rules and the WebSocket subprotocol stay as in ADR 0005; the WebSocket is reachable only with the per-boot token, which only a key holder can fetch.
- The browser gets the key out of band through a **login URL**: `http://localhost:<port>/#key=<key>`. The key sits in the fragment, so the browser never sends it to the server and it never lands in access logs. The SPA reads the fragment before the router starts, stores the key in `localStorage` and removes the fragment with `history.replaceState`. `localStorage` is scoped to scheme, host and port.
- The login URL is printed by the installer after a successful start and later by `install.sh --login-url`; in a checkout by `pnpm login-url [--port <vite port>]`. Nothing opens it automatically: a browser started with the URL as an argument would expose the key in its command line.
- Without a stored key, or after a `401 login_required`, the web app shows only a hint to open the login URL and loads nothing.

## Consequences

- Other OS users cannot read the key, so they get `401 login_required` on every route except health and the hook route.
- Each browser profile and each origin needs the login URL once: `localhost:<port>` and `127.0.0.1:<port>` are different origins, and so is the Vite dev server. After clearing site data it is needed again.
- Rotating the key: delete `$STATE/access-key` and restart the server; every browser must log in again.
- Script access to the API needs the header. Pass the key through stdin, not in `curl`'s arguments: `printf 'X-Agent-Hub-Key: %s\n' "$(cat ~/.local/state/agent-hub/access-key)" | curl -H @- ...` (`printf` is a shell builtin).
- A script running in the owner's page (XSS) could read the key from `localStorage`. Such a script can already drive the API, and the CSP limits where it can send data (`connect-src`).
- Root and processes of the same user can still read the key; they are out of scope as in ADR 0005.
- Real WSL localhost forwarding was not tested automatically; the design does not depend on the peer address, so forwarded and direct connections behave the same.

## Alternatives considered

- Peer uid lookup through `/proc/net/tcp`: works for a native Linux browser, but WSL-forwarded connections come from the relay, so the Windows browser would be locked out or the check would have to trust the relay's uid.
- HttpOnly `SameSite=Strict` cookie set by a one-time login URL: cookies are not scoped by port, so a server of another local user on `localhost:<other port>` receives the cookie as soon as the owner opens a page there. `localStorage` is port-scoped.
- Putting the per-boot token in the login URL: every server restart (upgrade, crash) would force a new login.
- Login with a password: friction without gain over a key file that only the owner can read.
- Unix socket with file permissions: the Windows browser cannot reach it (as in ADR 0005).
