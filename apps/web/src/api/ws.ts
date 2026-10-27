import type { ClientMessageInput, ServerMessage, ServerMessageType } from '@agent-hub/shared'
import { parseServerMessage, WS_PATH, WS_PROTOCOL_VERSION, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '@agent-hub/shared'
import { connection } from './connection'
import { getToken, refreshToken } from './token'

export const RECONNECT_MIN_MS = 500
export const RECONNECT_MAX_MS = 10_000
const OPEN_STATE = 1

type MessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>
type Handler<T extends ServerMessageType> = (message: MessageOf<T>) => void

export interface WsEvents {
  on: <T extends ServerMessageType>(type: T, handler: Handler<T>) => () => void
}

export interface WsClientOptions {
  createSocket?: (url: string, protocols: string[]) => WebSocket
  getToken?: () => Promise<string>
  refreshToken?: () => Promise<string>
  url?: string
}

export interface WsClient extends WsEvents {
  connect: () => void
  close: () => void
  send: (message: ClientMessageInput) => boolean
}

function defaultUrl (): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${WS_PATH}?v=${WS_PROTOCOL_VERSION}`
}

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling up to 10 s. */
export function backoffDelay (attempt: number): number {
  return Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
}

/** Single reconnecting WebSocket; the token is refetched before every reconnect. */
export function createWsClient (options: WsClientOptions = {}): WsClient {
  const fetchToken = options.getToken ?? getToken
  const renewToken = options.refreshToken ?? refreshToken
  const createSocket = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols))
  const handlers = new Map<ServerMessageType, Set<(message: never) => void>>()

  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let stopped = true

  async function open (renew: boolean): Promise<void> {
    let token: string
    try {
      token = await (renew ? renewToken() : fetchToken())
    } catch {
      connection.value = 'offline'
      scheduleReconnect()
      return
    }
    if (stopped) {
      return
    }
    const ws = createSocket(options.url ?? defaultUrl(), [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${token}`])
    socket = ws
    ws.addEventListener('open', () => {
      attempt = 0
      connection.value = 'online'
    })
    ws.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        dispatch(event.data)
      }
    })
    ws.addEventListener('close', () => {
      if (socket === ws) {
        socket = undefined
        connection.value = 'offline'
        scheduleReconnect()
      }
    })
  }

  function scheduleReconnect (): void {
    if (stopped || timer !== undefined) {
      return
    }
    const delay = backoffDelay(attempt)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void open(true)
    }, delay)
  }

  function dispatch (raw: string): void {
    const result = parseServerMessage(raw)
    if (!result.success) {
      return
    }
    for (const handler of handlers.get(result.data.type) ?? []) {
      handler(result.data as never)
    }
  }

  return {
    connect () {
      if (!stopped) {
        return
      }
      stopped = false
      void open(false)
    },
    close () {
      stopped = true
      clearTimeout(timer)
      timer = undefined
      const current = socket
      socket = undefined
      current?.close()
    },
    send (message) {
      if (socket?.readyState !== OPEN_STATE) {
        return false
      }
      socket.send(JSON.stringify(message))
      return true
    },
    on (type, handler) {
      const set = handlers.get(type) ?? new Set()
      set.add(handler as (message: never) => void)
      handlers.set(type, set)
      return () => {
        set.delete(handler as (message: never) => void)
      }
    },
  }
}

/** App-wide client; started by the shell. */
export const wsClient = createWsClient()
