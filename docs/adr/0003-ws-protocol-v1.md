# ADR 0003: WebSocket protocol v1 (string output, no flow control)

- Status: accepted
- Date: 2026-10-27

## Context

The browser shows several terminals per tab and needs live state updates. Terminal output is mostly text and xterm.js consumes strings. Flow control adds protocol and client complexity that v1 does not need for a few local sessions.

## Decision

- One WebSocket per browser tab at `/ws?v=1`, multiplexing all sessions by `sessionId`; JSON text frames with a `type` discriminator, validated by `ClientMessageSchema` / `ServerMessageSchema` in `packages/shared`.
- Terminal data is a UTF-8 string, decoded on the server with a streaming decoder; no base64.
- No flow-control frames. The server coalesces output above a `bufferedAmount` threshold and closes slow consumers with `4008`; the client reconnects and re-attaches with scrollback.
- `attach` sends `scrollback` once before any `output`; the last `attach`/`resize` sets the session size.
- `maxPayload` caps incoming frames; WebSocket ping/pong plus app-level `ping`/`pong` detect dead connections.
- Breaking changes bump `WS_PROTOCOL_VERSION`; a mismatch is answered with `protocol_mismatch` and close `4001`. v2 reserves `pause`/`resume`.

## Consequences

- Simple client and server, easy to debug in browser dev tools.
- Rare non-UTF-8 output is replaced with U+FFFD.
- A very slow client loses its connection instead of slowing others down, and resyncs from scrollback.

## Alternatives considered

- Binary frames or base64 payloads: about a third more bytes (base64) or a custom framing layer, for no benefit with text terminals.
- One WebSocket per pane: more connections, duplicated broadcast traffic for state frames.
- Credit-based flow control in v1: correct but not needed at local speeds; deferred to v2.
