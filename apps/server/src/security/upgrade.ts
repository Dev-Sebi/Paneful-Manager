import { WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX, type ApiErrorCode } from '@agent-hub/shared'
import type { IncomingHttpHeaders } from 'node:http'
import { isAllowedHost, isAllowedOrigin } from './origin.js'
import { tokenMatches } from './token.js'

export interface SecurityContext {
  port: number
  token: string
  dev: boolean
}

export type UpgradeDecision =
  | { ok: true; protocol: typeof WS_SUBPROTOCOL }
  | { ok: false; status: 401 | 403; code: Extract<ApiErrorCode, 'unauthorized' | 'forbidden'>; message: string }

const deny = (status: 401 | 403, message: string): UpgradeDecision => ({
  ok: false,
  status,
  code: status === 401 ? 'unauthorized' : 'forbidden',
  message,
})

/**
 * Checks a WebSocket upgrade: Host and Origin (required, browsers always send it) must be allowed,
 * and `Sec-WebSocket-Protocol` must offer `agent-hub.v1` plus `token.<token>`. Only `agent-hub.v1` is echoed back.
 */
export function authorizeUpgrade(req: { headers: IncomingHttpHeaders }, { port, token, dev }: SecurityContext): UpgradeDecision {
  if (!isAllowedHost(req.headers.host, port)) {
    return deny(403, 'Host not allowed')
  }
  if (!isAllowedOrigin(req.headers.origin, port, dev)) {
    return deny(403, 'Origin not allowed')
  }
  const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim())
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
