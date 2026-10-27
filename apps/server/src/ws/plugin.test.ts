import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../app.js'
import { ExecError } from '../process/exec.js'
import { SessionEngine } from '../sessions/engine.js'
import { Tmux } from '../tmux/tmux.js'
import { MAX_PAYLOAD_BYTES, WS_SUBPROTOCOL, type AuthorizeUpgrade } from './plugin.js'

const logger = pino({ level: 'silent' })
let dir: string
let app: FastifyInstance
let url: string

async function start(authorizeUpgrade?: AuthorizeUpgrade): Promise<void> {
  const tmux = new Tmux({ run: async () => {
    throw new ExecError('failed', 1, 'no server running on /tmp/tmux-1000/agent-hub\n')
  } })
  const engine = new SessionEngine({ stateDir: join(dir, 'state'), logger, tmux })
  await engine.start()
  app = buildApp({ config: DEFAULT_CONFIG, logger, engine, ...(authorizeUpgrade === undefined ? {} : { authorizeUpgrade }) })
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

  it('rejects unauthorized upgrades with 403 and other paths with 404', async () => {
    await start(request => request.headers.origin === 'http://127.0.0.1')
    expect((await connect('/ws?v=1')).status).toBe(403)
    expect((await connect('/other?v=1')).status).toBe(404)
  })

  it('closes connections that send frames above maxPayload with 1009', async () => {
    await start()
    const { ws } = await connect('/ws?v=1')
    const closed = nextClose(ws)
    ws.send('x'.repeat(MAX_PAYLOAD_BYTES + 1))
    expect(await closed).toBe(1009)
  })

  it('closes open sockets with 1001 on shutdown', async () => {
    await start()
    const { ws } = await connect('/ws?v=1')
    const closed = nextClose(ws)
    await app.close()
    expect(await closed).toBe(1001)
  })
})
