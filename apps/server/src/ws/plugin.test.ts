import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WS_SUBPROTOCOL, type Session } from '@agent-hub/shared'
import Fastify, { type FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { RunError } from '../process/exec.js'
import { SessionEngine, type AttachOptions, type EngineClient, type SessionEngineOptions } from '../sessions/engine.js'
import { Tmux } from '../tmux/tmux.js'
import { MAX_PAYLOAD_BYTES, registerWs, type AuthorizeUpgrade } from './plugin.js'

const logger = pino({ level: 'silent' })
const allowTestClients: AuthorizeUpgrade = () => ({ ok: true })
let dir: string
let app: FastifyInstance
let url: string

/** Engine whose `attach` waits for `release()`; records detach and input calls. */
class GatedEngine extends SessionEngine {
  readonly calls: string[] = []
  private readonly gate: Promise<void>
  private releaseGate: (() => void) | undefined

  constructor(options: SessionEngineOptions) {
    super(options)
    this.gate = new Promise(resolve => {
      this.releaseGate = resolve
    })
  }

  release(): void {
    this.releaseGate?.()
  }

  override get(id: string): Session | undefined {
    return { id, hostId: 'local', cwd: '/tmp', command: 'sh', args: [], tmuxSession: `ah-${id}`, createdAt: '2026-10-27T10:00:00.000Z', state: 'idle', lifecycle: 'running', lastEventAt: '2026-10-27T10:00:00.000Z', cols: 80, rows: 24 }
  }

  override async attach(id: string, _client: EngineClient, _options: AttachOptions): Promise<void> {
    this.calls.push(`attach:${id}`)
    await this.gate
    this.calls.push(`attached:${id}`)
  }

  override detach(id: string): void {
    this.calls.push(`detach:${id}`)
  }

  override input(id: string): boolean {
    this.calls.push(`input:${id}`)
    return true
  }
}

function engineOptions(): SessionEngineOptions {
  const tmux = new Tmux({ run: async () => {
    throw new RunError('failed', 'exit', 1, '', 'no server running on /tmp/tmux-1000/agent-hub\n')
  } })
  return { stateDir: join(dir, 'state'), logger, tmux }
}

async function start(authorizeUpgrade: AuthorizeUpgrade = allowTestClients, engine: SessionEngine = new SessionEngine(engineOptions()), heartbeatMs?: number): Promise<void> {
  await engine.start()
  app = Fastify()
  registerWs(app, { engine, authorizeUpgrade, ...(heartbeatMs === undefined ? {} : { heartbeatMs }) })
  app.addHook('onClose', async () => engine.close())
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  url = `ws://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

function connect(path: string, protocols: string[] = [WS_SUBPROTOCOL]): Promise<{ ws: WebSocket, status?: number }> {
  return new Promise(resolve => {
    const ws = new WebSocket(`${url}${path}`, protocols)
    ws.once('open', () => resolve({ ws }))
    ws.once('unexpected-response', (_request, response) => resolve({ ws, status: response.statusCode }))
    ws.once('error', () => resolve({ ws }))
  })
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise(resolve => ws.once('close', code => resolve(code)))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-ws-'))
})

afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

describe('registerWs', () => {
  it('echoes only the agent-hub subprotocol', async () => {
    await start()
    const { ws } = await connect('/ws?v=1', [WS_SUBPROTOCOL, 'token.secret'])
    expect(ws.protocol).toBe(WS_SUBPROTOCOL)
    ws.close()
  })

  it('refuses rejected upgrades with the authorizer status and opens no socket', async () => {
    await start(request => (request.headers.origin === 'http://127.0.0.1' ? { ok: true } : { ok: false, status: 401 }))
    const refused = await connect('/ws?v=1')
    expect(refused.status).toBe(401)
    expect(refused.ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('passes a 403 decision through', async () => {
    await start(() => ({ ok: false, status: 403 }))
    expect((await connect('/ws?v=1')).status).toBe(403)
  })

  it('answers other upgrade paths with 404', async () => {
    await start()
    expect((await connect('/other?v=1')).status).toBe(404)
  })

  it('closes connections that send frames above maxPayload with 1009', async () => {
    await start()
    const { ws } = await connect('/ws?v=1')
    const closed = nextClose(ws)
    ws.send('x'.repeat(MAX_PAYLOAD_BYTES + 1))
    expect(await closed).toBe(1009)
  })

  it('stops dispatching after close and detaches an attach that finishes late', async () => {
    const engine = new GatedEngine(engineOptions())
    await start(allowTestClients, engine)
    const { ws } = await connect('/ws?v=1')
    const closed = nextClose(ws)
    ws.send(JSON.stringify({ type: 'attach', sessionId: 's1', cols: 80, rows: 24 }))
    ws.send(JSON.stringify({ type: 'input', sessionId: 's1', data: 'ls\r' }))
    await expect.poll(() => engine.calls).toEqual(['attach:s1'])
    ws.close()
    await closed
    await expect.poll(() => engine.calls).toContain('detach:s1')
    engine.release()
    await expect.poll(() => engine.calls.at(-1)).toBe('detach:s1')
    expect(engine.calls).toContain('attached:s1')
    expect(engine.calls).not.toContain('input:s1')
  })

  it('terminates a socket that missed its pong', async () => {
    await start(allowTestClients, undefined, 50)
    const ws = new WebSocket(`${url}/ws?v=1`, [WS_SUBPROTOCOL], { autoPong: false })
    await new Promise(resolve => ws.once('open', resolve))
    expect(await nextClose(ws)).toBe(1006)
  })

  it('closes open sockets with 1001 on shutdown', async () => {
    await start()
    const { ws } = await connect('/ws?v=1')
    const closed = nextClose(ws)
    await app.close()
    expect(await closed).toBe(1001)
  })
})
