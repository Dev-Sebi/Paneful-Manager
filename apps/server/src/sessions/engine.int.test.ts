import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROUTES,
  CreateSessionResponseSchema,
  DEFAULT_CONFIG,
  KillSessionResponseSchema,
  ListSessionsResponseSchema,
  SESSION_TOKEN_HEADER,
  WS_SUBPROTOCOL,
  WS_TOKEN_PROTOCOL_PREFIX,
  parseServerMessage,
  type ClientMessageInput,
  type ServerMessage,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { buildApp } from '../app.js'
import { Tmux } from '../tmux/tmux.js'
import { SessionEngine } from './engine.js'

function has(command: string, flag: string): boolean {
  try {
    execFileSync(command, [flag], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasTmux = (): boolean => has('tmux', '-V')

const WAIT_MS = 5000
const TOKEN = randomBytes(32).toString('hex')
const HOOK_TOKEN = randomBytes(32).toString('base64url')
const socketName = `agent-hub-test-${randomBytes(4).toString('hex')}`
const logger = pino({ level: 'silent' })
let dir: string
let stateDir: string
let engine: SessionEngine
let app: FastifyInstance
let baseUrl: string

function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', env: { ...process.env, TMUX: '' } })
}

function newEngine(): SessionEngine {
  const sessionEnv = (): Record<string, string> => ({ AGENT_HUB_HOOK_TOKEN: HOOK_TOKEN, AGENT_HUB_URL: baseUrl })
  return new SessionEngine({ stateDir, logger, sessionEnv, tmux: new Tmux({ socketName }), pollAttachedMs: 100, pollIdleMs: 100 })
}

async function waitFor<T>(check: () => T | undefined | false, label: string, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value !== undefined && value !== false) {
      return value
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

class Client {
  readonly messages: ServerMessage[] = []
  closeCode: number | undefined

  private constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      const parsed = parseServerMessage(String(raw))
      if (!parsed.success) {
        throw new Error(parsed.error)
      }
      this.messages.push(parsed.data)
    })
    ws.on('close', code => {
      this.closeCode = code
    })
  }

  static async connect(query = '?v=1'): Promise<Client> {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws${query}`, [WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${TOKEN}`], { origin: baseUrl })
    const client = new Client(ws)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return client
  }

  send(message: ClientMessageInput | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message))
  }

  terminal(sessionId: string): string {
    return this.messages
      .flatMap(m => ((m.type === 'output' || m.type === 'scrollback') && m.sessionId === sessionId ? [m.data] : []))
      .join('')
  }

  waitForText(sessionId: string, text: string): Promise<true> {
    return waitFor(() => this.terminal(sessionId).includes(text), `"${text}" in ${sessionId}`)
  }

  waitForMessage<T extends ServerMessage['type']>(type: T, match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = WAIT_MS): Promise<Extract<ServerMessage, { type: T }>> {
    return waitFor(
      () => this.messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type && match(m as Extract<ServerMessage, { type: T }>)),
      `${type} frame`,
      timeoutMs,
    )
  }

  close(): void {
    this.ws.close()
  }
}

function mutationHeaders(json = false): Record<string, string> {
  return { ...(json ? { 'content-type': 'application/json' } : {}), 'origin': baseUrl, 'x-agent-hub-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN }
}

async function createSession(body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${baseUrl}${API_ROUTES.sessions}`, {
    method: 'POST',
    headers: mutationHeaders(true),
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(201)
  return CreateSessionResponseSchema.parse(await response.json()).session.id
}

describe.skipIf(!hasTmux())('session engine with a real tmux server', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-hub-int-'))
    stateDir = join(dir, 'state')
    const conf = join(dir, 'tmux.conf')
    await writeFile(conf, 'set -g exit-empty off\nset -g remain-on-exit on\nset -g status off\nset -g history-limit 10000\n')
    tmux('-f', conf, 'start-server')
    engine = newEngine()
    await engine.start()
    app = buildApp({ config: DEFAULT_CONFIG, logger, engine, sessionToken: TOKEN, accessKey: TOKEN, hookToken: HOOK_TOKEN, dev: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  })

  afterAll(async () => {
    await app?.close()
    try {
      const socketPath = tmux('display-message', '-p', '#{socket_path}').trim()
      tmux('kill-server')
      await rm(socketPath, { force: true })
    } catch {
      // already gone
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('streams a shell over WebSocket, resizes, and replays scrollback after reattach', async () => {
    const id = await createSession({ cwd: dir, command: 'sh', cols: 80, rows: 24 })
    const client = await Client.connect()
    client.send({ type: 'attach', sessionId: id, cols: 80, rows: 24, scrollback: true })
    await client.waitForMessage('scrollback', m => m.sessionId === id)
    client.send({ type: 'input', sessionId: id, data: "echo hel''lo\r" })
    await client.waitForText(id, 'hello')
    expect(client.terminal(id)).not.toContain('\u001B[?1049h')
    await client.waitForText(id, 'hello')

    client.send({ type: 'resize', sessionId: id, cols: 100, rows: 40 })
    await waitFor(() => tmux('display-message', '-p', '-t', `=ah-${id}:`, '#{window_width}x#{window_height}').trim() === '100x40', 'resize')
    expect(engine.get(id)).toMatchObject({ cols: 100, rows: 40 })

    client.send({ type: 'input', sessionId: id, data: 'seq 1 80; echo do""ne\r' })
    await client.waitForText(id, 'done')
    client.send({ type: 'detach', sessionId: id })
    await waitFor(() => !engine.isAttached(id), 'pty closed after last detach')
    expect(tmux('list-sessions', '-F', '#{session_name}')).toContain(`ah-${id}`)

    const second = await Client.connect()
    second.send({ type: 'attach', sessionId: id, cols: 100, rows: 40, scrollback: true })
    const scrollback = await second.waitForMessage('scrollback', m => m.sessionId === id)
    expect(scrollback.data).toContain('hello')
    expect(second.messages.findIndex(m => m.type === 'scrollback')).toBeLessThan(
      Math.max(0, second.messages.findIndex(m => m.type === 'output')) + 1,
    )
    second.send({ type: 'input', sessionId: id, data: 'echo wor""ld\r' })
    await second.waitForText(id, 'world')
    client.close()
    second.close()
  })

  it('shares one pty between clients and answers protocol errors', async () => {
    const id = await createSession({ cwd: dir, command: 'sh' })
    const a = await Client.connect()
    const b = await Client.connect()
    a.send({ type: 'attach', sessionId: id, cols: 80, rows: 24, scrollback: false })
    b.send({ type: 'attach', sessionId: id, cols: 90, rows: 30 })
    await b.waitForMessage('scrollback', m => m.sessionId === id)
    a.send({ type: 'input', sessionId: id, data: 'echo sha""red\r' })
    await a.waitForText(id, 'shared')
    await b.waitForText(id, 'shared')
    expect(engine.get(id)).toMatchObject({ cols: 90, rows: 30 })

    a.send({ type: 'ping' })
    await a.waitForMessage('pong')
    a.send({ type: 'bogus' })
    await a.waitForMessage('error', m => m.code === 'bad_message')
    a.send({ type: 'attach', sessionId: 'missing', cols: 80, rows: 24 })
    await a.waitForMessage('error', m => m.code === 'unknown_session')
    const fresh = await Client.connect()
    fresh.send({ type: 'input', sessionId: id, data: 'x' })
    await fresh.waitForMessage('error', m => m.code === 'not_attached')
    a.close()
    b.close()
    fresh.close()
  })

  it('refuses upgrades without the token subprotocol or with a foreign origin', async () => {
    const attempt = (protocols: string[], origin: string): Promise<number | undefined> => new Promise(resolve => {
      const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?v=1`, protocols, { origin })
      ws.once('open', () => {
        ws.close()
        resolve(undefined)
      })
      ws.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    })
    expect(await attempt([WS_SUBPROTOCOL], baseUrl)).toBe(401)
    expect(await attempt([WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}wrong`], baseUrl)).toBe(401)
    expect(await attempt([WS_SUBPROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${TOKEN}`], 'http://evil.example')).toBe(403)
    const unauthenticated = await fetch(`${baseUrl}${API_ROUTES.sessions}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'origin': baseUrl },
      body: JSON.stringify({ cwd: dir, command: 'sh' }),
    })
    expect(unauthenticated.status).toBe(401)
  })

  it('rejects a protocol mismatch with 4001', async () => {
    const client = await Client.connect('?v=99')
    await client.waitForMessage('error', m => m.code === 'protocol_mismatch')
    await waitFor(() => client.closeCode === 4001, 'close 4001')
  })

  it('reports the exit code of a finished command', async () => {
    const watcher = await Client.connect()
    // A command that exits instantly can lose its status in tmux under load; the sleep keeps this test deterministic.
    const id = await createSession({ cwd: dir, command: 'sh', args: ['-c', 'sleep 0.3; exit 3'] })
    const state = await watcher.waitForMessage('state', m => m.sessionId === id && m.exitCode !== undefined)
    expect(state).toMatchObject({ lifecycle: 'exited', exitCode: 3 })
    expect(engine.get(id)).toMatchObject({ lifecycle: 'exited', exitCode: 3 })
    watcher.close()
  })

  it('runs four sessions in parallel, multiplexed on one socket', async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => createSession({ cwd: dir, command: 'sh' })))
    const client = await Client.connect()
    for (const id of ids) {
      client.send({ type: 'attach', sessionId: id, cols: 80, rows: 24, scrollback: false })
    }
    ids.forEach((id, index) => client.send({ type: 'input', sessionId: id, data: `echo par""allel-${index}\r` }))
    await Promise.all(ids.map((id, index) => client.waitForText(id, `parallel-${index}`)))
    ids.forEach((id, index) => {
      const others = [0, 1, 2, 3].filter(other => other !== index)
      expect(others.some(other => client.terminal(id).includes(`parallel-${other}`))).toBe(false)
    })
    client.close()
  }, 20_000)

  it('kills a session over REST and broadcasts session.removed', async () => {
    const id = await createSession({ cwd: dir, command: 'sh' })
    const watcher = await Client.connect()
    const response = await fetch(`${baseUrl}${API_ROUTES.sessions}/${id}`, { method: 'DELETE', headers: mutationHeaders() })
    expect(KillSessionResponseSchema.parse(await response.json())).toEqual({ id, killed: true })
    await watcher.waitForMessage('session.removed', m => m.sessionId === id)
    expect(tmux('list-sessions', '-F', '#{session_name}')).not.toContain(`ah-${id}`)
    expect(await readdir(join(stateDir, 'sessions'))).not.toContain(`${id}.json`)
    const again = await fetch(`${baseUrl}${API_ROUTES.sessions}/${id}`, { method: 'DELETE', headers: mutationHeaders() })
    expect(again.status).toBe(404)
    watcher.close()
  })

  it('starts in a cwd containing tmux format characters without expanding them', async () => {
    const cwd = join(dir, 'cwd-#{session_name}-#(true)')
    const out = join(dir, 'format-pwd.txt')
    await mkdir(cwd)
    await createSession({ cwd, command: 'sh', args: ['-c', 'pwd > "$1"', 'sh', out] })
    const written = await waitFor(() => (existsSync(out) ? readFileSync(out, 'utf8').trim() : undefined), 'pwd output')
    expect(written).toBe(cwd)
  })

  it('rejects a cwd that is not a directory', async () => {
    const response = await fetch(`${baseUrl}${API_ROUTES.sessions}`, {
      method: 'POST',
      headers: mutationHeaders(true),
      body: JSON.stringify({ cwd: join(dir, 'missing'), command: 'sh' }),
    })
    expect(response.status).toBe(400)
  })

  it('re-adopts sessions in a new engine, adopts orphans and prunes stale records', async () => {
    const kept = await createSession({ cwd: dir, command: 'sh', title: 'kept' })
    tmux('new-session', '-d', '-s', 'ah-orphan01', '-c', dir, 'sh')
    tmux('new-session', '-d', '-s', 'foreign', 'sh')
    await writeFile(join(stateDir, 'sessions', 'stale01.json'), JSON.stringify({ ...engine.get(kept), id: 'stale01', tmuxSession: 'ah-stale01' }))

    const second = newEngine()
    await second.start()
    try {
      const ids = second.list().map(s => s.id)
      expect(ids).toContain(kept)
      expect(ids).not.toContain('stale01')
      expect(ids.some(id => id.length === 0)).toBe(false)
      expect(second.get(kept)).toMatchObject({ title: 'kept', state: 'idle', lifecycle: 'running' })
      expect(second.get('orphan01')).toMatchObject({ title: 'Recovered', command: 'tmux', args: [], cwd: dir, cols: 80, rows: 24 })
      expect(second.list().every(s => s.tmuxSession.startsWith('ah-'))).toBe(true)
      const files = await readdir(join(stateDir, 'sessions'))
      expect(files).toContain('orphan01.json')
      expect(files).not.toContain('stale01.json')
      expect(tmux('list-sessions', '-F', '#{session_name}')).toContain('foreign')
    } finally {
      await second.close()
    }
    const response = await fetch(`${baseUrl}${API_ROUTES.sessions}`, { headers: { 'x-agent-hub-key': TOKEN } })
    expect(ListSessionsResponseSchema.parse(await response.json()).sessions.map(s => s.id)).toContain(kept)
  })

  it('leaves tmux sessions running when an engine closes', async () => {
    const id = await createSession({ cwd: dir, command: 'sh' })
    const other = newEngine()
    await other.start()
    await other.attach(id, { scrollback: () => undefined, output: () => undefined, lost: () => undefined }, { cols: 80, rows: 24, scrollback: false })
    expect(other.isAttached(id)).toBe(true)
    await other.close()
    expect(other.isAttached(id)).toBe(false)
    expect(tmux('list-sessions', '-F', '#{session_name}')).toContain(`ah-${id}`)
  })

  it.skipIf(!has('curl', '--version'))('turns hook requests sent with the injected environment into state frames', async () => {
    const post = (event: string): string =>
      `curl -s -X POST -H "X-Agent-Hub-Hook-Token: $AGENT_HUB_HOOK_TOKEN" -H "X-Agent-Hub-Session-Id: $AGENT_HUB_SESSION_ID" `
      + `-H "content-type: application/json" -d '{"hook_event_name":"${event}"}' "$AGENT_HUB_URL/api/hooks"`
    const gate = join(dir, 'hook-gate')
    const client = await Client.connect()
    const script = `${post('UserPromptSubmit')}; while [ ! -f '${gate}' ]; do sleep 0.05; done; ${post('Stop')}; sleep 30`
    const id = await createSession({ cwd: dir, command: 'sh', args: ['-c', script] })
    const working = await client.waitForMessage('state', m => m.sessionId === id && m.state === 'working')
    expect(working.stateSince).toBe(engine.get(id)?.stateSince)
    await writeFile(gate, '')
    await client.waitForMessage('state', m => m.sessionId === id && m.state === 'idle')
    expect(engine.get(id)?.state).toBe('idle')
    client.close()
  })

  // Runs last: it kills the shared tmux server.
  it('reports tmux_unavailable to attached clients when the tmux server dies', async () => {
    const health = async (): Promise<unknown> => (await (await fetch(`${baseUrl}${API_ROUTES.health}`)).json() as { tmux: unknown }).tmux
    expect(await health()).toBe('available')
    const id = await createSession({ cwd: dir, command: 'sh' })
    const client = await Client.connect()
    client.send({ type: 'attach', sessionId: id, cols: 80, rows: 24, scrollback: false })
    client.send({ type: 'input', sessionId: id, data: 'echo al""ive\r' })
    await client.waitForText(id, 'alive')
    const socketPath = tmux('display-message', '-p', '#{socket_path}').trim()
    tmux('kill-server')
    await rm(socketPath, { force: true })
    await client.waitForMessage('error', m => m.code === 'tmux_unavailable' && m.sessionId === id)
    expect(engine.isAttached(id)).toBe(false)
    expect(await health()).toBe('unavailable')
    client.send({ type: 'input', sessionId: id, data: 'x' })
    await client.waitForMessage('error', m => m.code === 'not_attached')
    client.close()
  })
})
