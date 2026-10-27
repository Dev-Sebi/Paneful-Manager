import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  WS_PATH,
  WS_PROTOCOL_VERSION,
  WS_SUBPROTOCOL,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
  type Session,
  type WsErrorCode,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { EngineClient, SessionEngine, StateChange } from '../sessions/engine.js'
import { OutputQueue, type OutputQueueOptions } from './backpressure.js'

export const MAX_PAYLOAD_BYTES = 1024 * 1024
export const HEARTBEAT_MS = 30_000
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_PROTOCOL_MISMATCH = 4001

export type UpgradeAuthorization = { ok: true } | { ok: false, status: 401 | 403 }

/** Decides whether an upgrade may proceed (Host, Origin, token); there is no default, so the endpoint fails closed. */
export type AuthorizeUpgrade = (request: IncomingMessage) => UpgradeAuthorization | Promise<UpgradeAuthorization>

export interface WsPluginOptions {
  engine: SessionEngine
  authorizeUpgrade: AuthorizeUpgrade
  heartbeatMs?: number
  output?: OutputQueueOptions
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** One browser-tab connection: multiplexes attached sessions over one socket. */
class Connection implements EngineClient {
  readonly queue: OutputQueue
  readonly attached = new Set<string>()
  alive = true
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly socket: WebSocket,
    private readonly engine: SessionEngine,
    private readonly log: FastifyInstance['log'],
    outputOptions?: OutputQueueOptions,
  ) {
    this.queue = new OutputQueue(socket, outputOptions)
  }

  scrollback(sessionId: string, data: string): void {
    this.queue.send({ type: 'scrollback', sessionId, data })
  }

  output(sessionId: string, data: string): void {
    this.queue.output(sessionId, data)
  }

  error(code: WsErrorCode, message: string, sessionId?: string): void {
    this.queue.send({ type: 'error', code, message, ...(sessionId === undefined ? {} : { sessionId }) })
  }

  /** Frames are handled strictly in arrival order. */
  handle(raw: string): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const parsed = parseClientMessage(raw)
        if (!parsed.success) {
          this.error('bad_message', parsed.error)
          return
        }
        await this.dispatch(parsed.data)
      })
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'WebSocket message handling failed')
        this.error('internal', 'Internal error')
      })
    return this.chain
  }

  detach(sessionId: string): void {
    this.attached.delete(sessionId)
    this.queue.drop(sessionId)
    this.engine.detach(sessionId, this)
  }

  /** The session is gone: forget it without touching the engine again. */
  forget(sessionId: string): void {
    this.attached.delete(sessionId)
    this.queue.drop(sessionId)
  }

  dispose(): void {
    for (const sessionId of [...this.attached]) {
      this.detach(sessionId)
    }
    this.queue.dispose()
  }

  private async dispatch(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ping': {
        this.queue.send({ type: 'pong' })
        return
      }
      case 'attach': {
        const { sessionId, cols, rows, scrollback } = message
        if (this.engine.get(sessionId) === undefined) {
          this.error('unknown_session', `Unknown session ${sessionId}`, sessionId)
          return
        }
        this.queue.drop(sessionId)
        this.attached.add(sessionId)
        try {
          await this.engine.attach(sessionId, this, { cols, rows, scrollback })
        } catch (error) {
          this.attached.delete(sessionId)
          this.engine.detach(sessionId, this)
          this.log.warn({ err: error, sessionId }, 'Attach failed')
          this.error('internal', 'Attach failed', sessionId)
        }
        return
      }
      case 'detach': {
        this.detach(message.sessionId)
        return
      }
      case 'input': {
        if (!this.attached.has(message.sessionId) || !this.engine.input(message.sessionId, message.data)) {
          this.error('not_attached', `Not attached to ${message.sessionId}`, message.sessionId)
        }
        return
      }
      case 'resize': {
        const { sessionId, cols, rows } = message
        if (!this.attached.has(sessionId) || !this.engine.resize(sessionId, cols, rows)) {
          this.error('not_attached', `Not attached to ${sessionId}`, sessionId)
        }
      }
    }
  }
}

/** WebSocket endpoint `/ws` (protocol v1): terminal I/O plus broadcast of session events. */
export function registerWs(app: FastifyInstance, options: WsPluginOptions): void {
  const { engine } = options
  const authorize = options.authorizeUpgrade
  const connections = new Set<Connection>()
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    handleProtocols: protocols => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  })

  const broadcast = (send: (connection: Connection) => void): void => {
    for (const connection of connections) {
      send(connection)
    }
  }
  const onCreated = (session: Session): void => broadcast(c => c.queue.send({ type: 'session.created', session }))
  const onRemoved = (sessionId: string): void => broadcast(c => {
    c.forget(sessionId)
    c.queue.send({ type: 'session.removed', sessionId })
  })
  const onState = (change: StateChange): void => broadcast(c => c.queue.send({ type: 'state', ...change }))
  engine.on('session.created', onCreated)
  engine.on('session.removed', onRemoved)
  engine.on('state', onState)

  const onConnection = (socket: WebSocket, request: IncomingMessage): void => {
    const version = new URL(request.url ?? '/', 'http://localhost').searchParams.get('v')
    if (version !== String(WS_PROTOCOL_VERSION)) {
      const mismatch: ServerMessage = { type: 'error', code: 'protocol_mismatch', message: `Server speaks protocol v${WS_PROTOCOL_VERSION}` }
      socket.send(JSON.stringify(mismatch))
      socket.close(CLOSE_PROTOCOL_MISMATCH, 'protocol mismatch')
      return
    }
    const connection = new Connection(socket, engine, app.log, options.output)
    connections.add(connection)
    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        connection.error('bad_message', 'Binary frames are not supported')
        return
      }
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as Uint8Array).toString('utf8')
      void connection.handle(text)
    })
    socket.on('close', () => {
      connections.delete(connection)
      connection.dispose()
    })
    socket.on('error', error => {
      app.log.debug({ err: error }, 'WebSocket error')
    })
  }
  wss.on('connection', onConnection)

  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) {
        connection.socket.terminate()
        continue
      }
      connection.alive = false
      connection.socket.ping()
    }
  }, options.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost')
    if (pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }
    Promise.resolve(authorize(request)).then(
      decision => {
        if (!decision.ok) {
          rejectUpgrade(socket, decision.status, decision.status === 401 ? 'Unauthorized' : 'Forbidden')
          return
        }
        wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
      },
      (error: unknown) => {
        app.log.warn({ err: error }, 'Upgrade authorization failed')
        rejectUpgrade(socket, 403, 'Forbidden')
      },
    )
  }
  app.server.on('upgrade', onUpgrade)

  app.addHook('preClose', done => {
    clearInterval(heartbeat)
    app.server.off('upgrade', onUpgrade)
    engine.off('session.created', onCreated)
    engine.off('session.removed', onRemoved)
    engine.off('state', onState)
    for (const connection of connections) {
      connection.socket.close(CLOSE_GOING_AWAY, 'server shutdown')
      connection.dispose()
    }
    connections.clear()
    wss.close(() => done())
  })
}
