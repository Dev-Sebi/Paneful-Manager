# ADR 0014: Device login against origin squatting

- Status: accepted
- Date: 2026-10-28
- Amends: [ADR 0013](0013-access-key-against-local-users.md)

## Context

ADR 0013 gave the browser the persisted access key through the login URL and kept it in `localStorage` of `http://127.0.0.1:<port>`. While Paneful Manager is not listening (boot before the unit starts, upgrade, crash, a stopped unit), any other local user can bind `127.0.0.1:<port>` and serve a page on exactly that origin. If the owner's browser loads it (a restored tab, a bookmark), the page reads the stored key, sends it home, and the other user can then call the real API with `curl` at any later time, until the key is rotated (SEC-014).

No browser storage is safe against a page on the same origin, so the fix must make what is stored useless outside the page: page code may use it, but must not be able to copy it out in a form that still works later.

## Decision

- **Device key instead of a stored bearer key.** On login the SPA generates an ECDSA P-256 key pair with WebCrypto, private half `extractable: false`, and stores the `CryptoKey` object in IndexedDB (database `paneful-manager`, store `device`). Structured clone keeps it non-extractable: page code can sign with it, nobody can read the key bytes. The public key (JWK `x`/`y`) is registered with the server.
- **One-time login code.** The login URL becomes `http://127.0.0.1:<port>/#login=<code>`. The code is 32 random bytes written to `$STATE/login-code` (`0600`) together with its expiry (10 minutes) by `install.sh --login-url` or `pnpm login-url`; one pending code at a time, a new one replaces it. `POST /api/auth/register { code, publicKey }` consumes it (claimed with `rename`, so only one of several concurrent requests wins; a wrong guess leaves the pending code alone) and stores the device in `$STATE/devices.json` (`0600`, public keys only, at most 20, the oldest dropped). The code lives only in the fragment and in page memory, never in browser storage. No server needs to run to create a code, and the CLI never talks to the port, so it cannot hand anything to a squatter.
- **Session by challenge.** On every page load the SPA fetches `GET /api/auth/challenge` (a nonce valid for 60 s and one session, MAC-signed with a secret of this server process; issuing stores nothing, so a flood of challenges cannot push out the owner's, and only answered nonces are remembered until they expire), signs `paneful-manager.session.v1\n<nonce>` and sends `POST /api/auth/session { deviceId, nonce, signature }`. The server verifies it against the registered key and returns a random session key valid for 15 minutes, held only in server memory (hashed) and in the page's memory. The page sends it as `X-Paneful-Key`; on `401 login_required` it signs a new challenge once and retries. The three login routes need neither key nor per-boot token; they still pass the Host and Origin checks and refuse `Sec-Fetch-Site: cross-site`.
- **The access key stays, for scripts only.** `$STATE/access-key` is still accepted as `X-Paneful-Key`, so shell access works as before (owner reads the `0600` file). No browser ever receives it.
- **WebSocket and mutations.** The per-boot token is fetched from `GET /api/session-token` with the session key and authenticates mutations and the WS subprotocol (ADR 0005). Like every API request, the WebSocket upgrade also needs a key: the access key as `X-Paneful-Key` (scripts) or the session key as a `key.<key>` subprotocol (browsers cannot set headers on a WebSocket). The per-boot token alone lives as long as the process, so a token taken out of a page must not open a terminal. A socket opened with a session key is closed at the next heartbeat (30 s) once its device is logged out.
- **Logout.** `pnpm login-url --reset` (or `rm ~/.local/state/paneful-manager/devices.json`) removes every device and a pending code. Every session key remembers its device, and every request checks that the device is still in the devices file (a `stat` per request, parsed again only when it changed), so a reset ends issued session keys at once, without a restart.
- **Migration.** On every start the SPA deletes `localStorage['paneful-manager.access-key.v1']`, which older builds wrote. Each browser needs one new login URL after the upgrade. A `#key=` fragment is ignored.
- `127.0.0.1` stays the only trusted host name (ADR 0013); elsewhere no login happens.

## Why this closes the reported attack

A squatting page can still sign with the stored device key, but only while it runs, and the only signatures that help are over nonces from the real server. The real server is down while the port is squatted, its nonces are bound to one process lifetime and expire after 60 s, and a session key is never stored by the browser. As long as the real server stays down while the page runs, the page can only take away what is useless later: a device id, a public key, a signature over a nonce it invented. A page that is still running once the real server is back is covered under Residual risk.

## Consequences

- Each browser profile and origin (installed app, Vite dev server) logs in once with its own login URL; a login URL works for one browser only. Clearing site data, or logging out, needs a new one.
- The login hint says whether the login URL was already used or has expired.
- After an upgrade from a build that stored the access key, every browser has to log in once more.
- e2e pages send the access key as an extra header (script path); `login.spec.ts` covers the device login, reload, one-time codes, logout and the removal of the old stored key.
- `install.sh` writes a login code only after an install or upgrade that changed something, and on `--login-url`.

### Residual risk

These need another local user who owns the origin while the owner's browser loads it; they are documented, not fixed:

- **Squatter code running while the real server is up.** The squatter's page stays loaded in its tab after the squatter frees the port, and it can register a service worker or put long-lived responses into the HTTP cache of `http://127.0.0.1:<port>`, so a later page load may run it again. Once the real server listens, that code is same-origin with it: it signs the real server's nonces and reads the session key and per-boot token the server returns, so it can act through the API and also hand both out. A session key taken out works for at most 15 minutes and only while its device is registered; the per-boot token alone opens neither the API nor the WebSocket, and an open socket is closed at the next heartbeat after a logout. No server-side check can tell such a page from the real one. If a squat is suspected: clear the site data of `http://127.0.0.1:<port>` in the browser, run `pnpm login-url --reset` (or delete `devices.json`) and restart the server (new per-boot token).
- **A login URL opened while squatted.** The squatter receives the code; if it registers before the code expires (10 minutes) while the real server runs, it owns a device. The owner sees "already used" on the real server. Log out every browser as above if that happens unexpectedly.
- **Dev and e2e origins.** A device registered on the Vite origin (`127.0.0.1:3000` or another dev port) can be used by a squatter on that port while the API server on its own port is up. This only applies to development setups (`NODE_ENV=development`); there the Vite port is a separate origin that can be down while the API runs.
- **Denial of service.** A squatting page can delete the IndexedDB device, so the owner has to log in again.
- Root, processes of the owner and script injection into the real page stay out of scope, as in ADR 0005 and 0013.

## Alternatives considered

- **Receiving a device secret and importing it as a non-extractable HMAC key:** the secret passes through page code once, in a response a squatter's proxy or a later login could see; a key pair generated in the browser never leaves it.
- **Keeping the access key in the login URL but not storing it:** the URL would still carry a permanent bearer credential, and any page that receives it (squatter, scrollback, screenshot) keeps it forever.
- **WebAuthn / passkeys:** require an RP ID, which an IP address (`127.0.0.1`) cannot be, and a user gesture on every session.
- **Holding the port while the server is down (systemd socket activation):** removes the squat window instead of limiting its effect, which also closes the residual risks above for installs under systemd. It does not cover the time before the user manager starts (with lingering: early boot) or setups started by hand without systemd. Recommended as a follow-up with its own ADR: an `paneful-manager.socket` unit holding `127.0.0.1:<port>` (and `[::1]:<port>`, so `localhost` cannot be squatted either), the server taking the listening socket from `LISTEN_FDS` and still checking the bound address.
- **Server-side kill switch for foreign service workers:** the browser only checks for a service worker update after the page it intercepted is already running, so it would not stop the first load.
