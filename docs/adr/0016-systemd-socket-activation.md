# ADR 0016: systemd socket activation against port squatting

- Status: accepted
- Date: 2026-10-28
- Amends: [ADR 0014](0014-device-login-against-origin-squatting.md)

## Context

ADR 0014 limits what another local user gains by binding `127.0.0.1:<port>` while Paneful Manager is down (boot, upgrade, restart, crash), and lists the remaining risks: squatter code that stays in the browser until the real server is back, and a login URL opened while the port is squatted. It recommended closing the window itself with systemd socket activation. The same holds for `[::1]:<port>`: `localhost` may resolve to `::1`, and nothing stops another user from listening there while the server holds only `127.0.0.1`.

## Decision

- **`paneful-manager.socket`** (`packaging/systemd/`) binds `ListenStream=127.0.0.1:<port>` and, when the machine has IPv6 loopback, `ListenStream=[::1]:<port>`. Without IPv6 loopback (`/proc/net/if_inet6` has no `::1`) the line is left out: binding it would fail, and nobody else can bind it either. The installer enables the socket together with the units.
- **`paneful-manager.service`** has `Requires=` and `After=paneful-manager.socket`, keeps `WantedBy=default.target` (presets with autostart need the server up without a first connection) and is started explicitly after the socket.
- **The server takes the sockets** (`apps/server/src/socket-activation.ts`): when `LISTEN_PID` is its pid it reads `LISTEN_FDS` (fds from 3 on, in the order of the `ListenStream=` lines), and always removes `LISTEN_PID`, `LISTEN_FDS` and `LISTEN_FDNAMES` from its environment, so no child process takes them for its own. Fastify listens on fd 3; the bound-address check stays and refuses anything but `127.0.0.1`. Every further fd gets a minimal HTTP server that must be bound to loopback and answers every request with `403` and the hint to open `http://127.0.0.1:<port>/`, and closes upgrades. Only `127.0.0.1` stays trusted (ADR 0013). Without these variables the server listens itself as before (manual start, `pnpm dev`, tests, macOS).
- **The socket stays up across server restarts.** An upgrade or rollback restarts only the service; connections in the meantime queue in the socket and are served when the new process takes it. Only when the socket unit itself changed (another port, first install) does the installer stop the service, restart the socket and start the service again; that short gap is the only time the port is free.
- The server uses the port of the socket it got and warns when it differs from the configured one.

## Consequences

- From the start of the user manager on, the port and `[::1]` are never free while Paneful Manager is installed, so the squatting scenarios of ADR 0014 need a squatter that binds before the user manager (with lingering: early boot) or a server started by hand.
- `systemctl --user stop paneful-manager.service` alone does not free the port (the socket would restart the service on the next connection); stop the socket as well. Uninstall disables all three units.
- The passed fds have no close-on-exec flag (Node has no `fcntl`), so child processes of the server (tmux clients, `git`, `claude mcp`) inherit copies of the listening sockets. They are processes of the same user, which is out of scope (ADR 0005), and they never accept on them.
- A broken socket unit (edited by hand to a non-loopback address) makes the server refuse to start instead of serving there.

## macOS

launchd can also hold sockets (`Sockets` in the plist), but hands them over only through `launch_activate_socket()`, a C call without a Node API; it would need a native addon or a wrapper binary in the release. Not done: macOS keeps the ADR 0014 residual risk for the time the server is down, and the docs say so.

## Alternatives considered

- **Holding the port with a separate small process:** needs its own supervision and a hand-over protocol; systemd already provides both.
- **Serving on `[::1]` as well:** a second trusted origin, which ADR 0013 rejected; holding it and answering with the hint is enough.
- **`Accept=yes` (one service instance per connection):** wrong model for a long-running server with in-memory state.
