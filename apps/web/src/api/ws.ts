import type { ClientMessageInput, ServerMessage, ServerMessageType } from '@agent-hub/shared'
import { parseServerMessage, WS_PATH, WS_PROTOCOL_VERSION, WS_SUBPROTOCOL, WS_TOKEN_PROTOCOL_PREFIX } from '@agent-hub/shared'
import { connection } from './connection'
import { getToken, refreshToken } from './token'

export const RECONNECT_MIN_MS = 500
export const RECONNECT_MAX_MS = 10_000
export const JITTER_RATIO = 0.25
export const PING_INTERVAL_MS = 25_000
export const PONG_TIMEOUT_MS = 10_000
/** Close code sent by the server on a protocol version mismatch; reconnecting cannot help. */
export const CLOSE_PROTOCOL_MISMATCH = 4001
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
  /** Returns a value in [0, 1); injectable for tests. */
  random?: () => number
}

export interface WsClient extends WsEvents {
  connect: () => void
  close: () => void
  send: (message: ClientMessageInput) => boolean
  /** Fires when reconnecting is pointless (protocol mismatch). */
  onFatal: (handler: (reason: 'protocol_mismatch') => void) => () => void
}

function defaultUrl (): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${WS_PATH}?v=${WS_PROTOCOL_VERSION}`
}

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling up to 10 s. */
export function backoffDelay (attempt: number): number {
  return Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS)
}

/** Backoff with +-25 % jitter, never above the maximum. */
export function jitteredDelay (attempt: number, random: () => number = Math.random): number {
  const factor = 1 + (random() * 2 - 1) * JITTER_RATIO
  return Math.min(Math.round(backoffDelay(attempt) * factor), RECONNECT_MAX_MS)
}

/** Single reconnecting WebSocket; the token is refetched before every reconnect. */
export function createWsClient (options: WsClientOptions = {}): WsClient {
  const fetchToken = options.getToken ?? getToken
  const renewToken = options.refreshToken ?? refreshToken
  const createSocket = options.createSocket ?? ((url, protocols) => new WebSocket(url, protocols))
  const random = options.random ?? Math.random
  const handlers = new Map<ServerMessageType, Set<(message: never) => void>>()
  const fatalHandlers = new Set<(reason: 'protocol_mismatch') => void>()

  let socket: WebSocket | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let pongTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let stopped = true
  /** Bumped by connect() and close(); stale async work and socket events compare against it. */
  let generation = 0

  function stopHeartbeat (): void {
    clearInterval(pingTimer)
    clearTimeout(pongTimer)
    pingTimer = undefined
    pongTimer = undefined
  }

  function startHeartbeat (ws: WebSocket, gen: number): void {
    stopHeartbeat()
    pingTimer = setInterval(() => {
      if (gen !== generation || ws.readyState !== OPEN_STATE) {
        return
      }
      ws.send(JSON.stringify({ type: 'ping' }))
      clearTimeout(pongTimer)
      pongTimer = setTimeout(() => {
        if (gen === generation && socket === ws) {
          dropSocket(ws)
          scheduleReconnect()
        }
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  function dropSocket (ws: WebSocket): void {
    stopHeartbeat()
    socket = undefined
    connection.value = 'disconnected'
    ws.close()
  }

  async function open (renew: boolean): Promise<void> {
    const gen = generation
    connection.value = 'connecting'
    let token: string
    try {
      token = await (renew ? renewToken() : fetchToken())
    } catch {
      if (gen === generation) {
        connection.value = 'disconnected'
        scheduleReconnect()
      }
      return
    }
    if (stopped || gen !== generation) {
      return
    }
    const ws = createSocket(options.url ?? defaultUrl(), [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${token}`])
    socket = ws
    ws.addEventListener('open', () => {
      if (gen !== generation || socket !== ws) {
        return
      }
      attempt = 0
      connection.value = 'connected'
      startHeartbeat(ws, gen)
    })
    ws.addEventListener('message', event => {
      if (gen === generation && socket === ws && typeof event.data === 'string') {
        dispatch(event.data)
      }
    })
    ws.addEventListener('close', event => {
      if (gen !== generation || socket !== ws) {
        return
      }
      stopHeartbeat()
      socket = undefined
      connection.value = 'disconnected'
      if (event.code === CLOSE_PROTOCOL_MISMATCH) {
        stopped = true
        for (const handler of fatalHandlers) {
          handler('protocol_mismatch')
        }
        return
      }
      scheduleReconnect()
    })
  }

  function scheduleReconnect (): void {
    if (stopped || timer !== undefined) {
      return
    }
    const delay = jitteredDelay(attempt, random)
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      void open(true)
    }, delay)
  }

  function dispatch (raw: string): void {
    const result = parseServerMessage(raw)
    if (!result.success) {
      console.warn('[ws] dropped invalid frame:', result.error)
      return
    }
    if (result.data.type === 'pong') {
      clearTimeout(pongTimer)
      pongTimer = undefined
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
      generation += 1
      void open(false)
    },
    close () {
      stopped = true
      generation += 1
      clearTimeout(timer)
      timer = undefined
      stopHeartbeat()
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
    onFatal (handler) {
      fatalHandlers.add(handler)
      return () => {
        fatalHandlers.delete(handler)
      }
    },
  }
}

/** App-wide client; started by the shell. */
export const wsClient = createWsClient()
