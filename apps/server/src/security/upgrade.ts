import { ACCESS_KEY_HEADER, WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX, type ApiErrorCode } from '@paneful-manager/shared'
import type { IncomingHttpHeaders } from 'node:http'
import { isAllowedHost, isAllowedOrigin } from './origin.js'
import { tokenMatches } from './token.js'

export interface SecurityContext {
  port: number
  token: string
  dev: boolean
  devOrigins?: readonly string[]
}

/** A valid key: the access key (scripts) or a browser session, whose `revalidate` says whether that browser is still logged in. */
export interface KeyAuthentication {
  revalidate?: () => Promise<boolean>
}

/** Checks the key an upgrade offers; undefined when it is missing or invalid. */
export type AuthenticateKey = (key: string | undefined) => Promise<KeyAuthentication | undefined>

export type UpgradeDecision =
  | { ok: true; protocol: typeof WS_SUBPROTOCOL; revalidate?: () => Promise<boolean> }
  | { ok: false; status: 401 | 403; code: Extract<ApiErrorCode, 'unauthorized' | 'forbidden'>; message: string }

const deny = (status: 401 | 403, message: string): UpgradeDecision => ({
  ok: false,
  status,
  code: status === 401 ? 'unauthorized' : 'forbidden',
  message,
})

const offeredProtocols = (headers: IncomingHttpHeaders): string[] =>
  (headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim())

/** Key from `X-Paneful-Key` (scripts) or exactly one `key.<key>` subprotocol (browsers). */
export function upgradeKey(headers: IncomingHttpHeaders): string | undefined {
  const header = headers[ACCESS_KEY_HEADER]
  if (typeof header === 'string') {
    return header
  }
  const keys = offeredProtocols(headers).filter(part => part.startsWith(WS_KEY_PROTOCOL_PREFIX))
  return keys.length === 1 ? keys[0]?.slice(WS_KEY_PROTOCOL_PREFIX.length) : undefined
}

/**
 * Checks a WebSocket upgrade: Host and Origin (required, browsers always send it) must be allowed,
 * and `Sec-WebSocket-Protocol` must offer `paneful-manager.v1` plus `token.<token>`. Only `paneful-manager.v1` is echoed back.
 */
export function authorizeUpgrade(req: { headers: IncomingHttpHeaders }, { port, token, dev, devOrigins = [] }: SecurityContext): UpgradeDecision {
  if (!isAllowedHost(req.headers.host, port)) {
    return deny(403, 'Host not allowed')
  }
  if (!isAllowedOrigin(req.headers.origin, port, dev, devOrigins)) {
    return deny(403, 'Origin not allowed')
  }
  const offered = offeredProtocols(req.headers)
  if (!offered.includes(WS_SUBPROTOCOL)) {
    return deny(403, `Subprotocol ${WS_SUBPROTOCOL} required`)
  }
  const tokens = offered.filter(part => part.startsWith(WS_TOKEN_PROTOCOL_PREFIX))
  const candidate = tokens.length === 1 ? tokens[0]?.slice(WS_TOKEN_PROTOCOL_PREFIX.length) : undefined
  if (!tokenMatches(candidate, token)) {
    return deny(401, 'Missing or invalid token')
  }
  return { ok: true, protocol: WS_SUBPROTOCOL }
}

/**
 * `authorizeUpgrade` plus the access key or a browser session key, like every other API request:
 * the per-boot token alone, once taken out of a page, must not open a terminal for the rest of the process lifetime.
 */
export async function authorizeKeyedUpgrade(req: { headers: IncomingHttpHeaders }, context: SecurityContext, authenticate: AuthenticateKey): Promise<UpgradeDecision> {
  const decision = authorizeUpgrade(req, context)
  if (!decision.ok) {
    return decision
  }
  const authenticated = await authenticate(upgradeKey(req.headers))
  if (authenticated === undefined) {
    return deny(401, 'Missing or invalid key')
  }
  return authenticated.revalidate === undefined ? decision : { ...decision, revalidate: authenticated.revalidate }
}
