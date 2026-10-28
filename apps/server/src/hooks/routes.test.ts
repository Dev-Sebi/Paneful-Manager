import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  ACCESS_KEY_HEADER,
  API_ROUTES,
  HOOK_SESSION_HEADER,
  HOOK_TOKEN_HEADER,
  HookChangeResponseSchema,
  HookStatusSchema,
  SESSION_TOKEN_HEADER,
  type SessionState,
} from '@paneful-manager/shared'
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type InjectOptions } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackupStore } from '../files/backups.js'
import { createLogger } from '../logger.js'
import { registerSecurity } from '../security/register-security.js'
import { createHookSettings } from './install.js'
import { StaleHookSessions } from './stale.js'
import { HOOK_BODY_LIMIT_BYTES, registerHooks, type HookTarget } from './routes.js'

const PORT = 7337
const HOOK_TOKEN = 'h'.repeat(43)
const SESSION_TOKEN = 'per-boot-token'
const ACCESS_KEY = 'persisted-access-key'
const SESSION_ID = 'abcDEF123_-x'
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`

class FakeEngine implements HookTarget {
  readonly known = new Set([SESSION_ID])
  readonly applied: [string, SessionState][] = []
  polls = 0

  applyHookState(sessionId: string, state: SessionState): boolean {
    if (!this.known.has(sessionId)) {
      return false
    }
    this.applied.push([sessionId, state])
    return true
  }

  poll(): Promise<void> {
    this.polls++
    return Promise.resolve()
  }
}

let dir: string
let app: FastifyInstance
let engine: FakeEngine

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paneful-manager-hooks-routes-'))
  engine = new FakeEngine()
  const logger: FastifyBaseLogger = pino({ level: 'silent' })
  app = Fastify({ loggerInstance: logger })
  registerSecurity(app, { getPort: () => PORT, token: SESSION_TOKEN, accessKey: ACCESS_KEY, dev: false })
  registerHooks(app, {
    getPort: () => PORT,
    engine,
    token: HOOK_TOKEN,
    settings: createHookSettings({ settingsPath: join(dir, 'settings.json'), backups: createBackupStore({ dir: join(dir, 'backups') }), managedDir: join(dir, 'managed') }),
  })
})

afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

function hook(body: unknown, headers: Record<string, string> = {}, options: Partial<InjectOptions> = {}) {
  return app.inject({
    method: 'POST',
    url: API_ROUTES.hooks,
    headers: { host: HOST, 'content-type': 'application/json', [HOOK_TOKEN_HEADER]: HOOK_TOKEN, [HOOK_SESSION_HEADER]: SESSION_ID, ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  })
}

describe('POST /api/hooks', () => {
  it('applies a mapped event and answers 204 without a body', async () => {
    const response = await hook({ hook_event_name: 'PermissionRequest', session_id: 'claude-1', tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
    expect(engine.applied).toEqual([[SESSION_ID, 'waiting']])
  })

  it('maps Notification by type and ignores unmapped events', async () => {
    await hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' })
    await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })
    await hook({ hook_event_name: 'Notification', notification_type: 'auth_success' })
    await hook({ hook_event_name: 'SubagentStop' })
    await hook({ hook_event_name: 'PreCompact' })
    expect(engine.applied).toEqual([[SESSION_ID, 'waiting'], [SESSION_ID, 'idle']])
  })

  it('polls after SessionEnd', async () => {
    expect((await hook({ hook_event_name: 'SessionEnd', reason: 'other' })).statusCode).toBe(204)
    expect(engine.applied).toEqual([[SESSION_ID, 'idle']])
    expect(engine.polls).toBe(1)
  })

  it('requires the hook token', async () => {
    for (const token of ['', 'wrong']) {
      const response = await hook({ hook_event_name: 'Stop' }, { [HOOK_TOKEN_HEADER]: token })
      expect(response.statusCode).toBe(401)
    }
    expect((await hook({ hook_event_name: 'Stop' }, { [HOOK_TOKEN_HEADER]: SESSION_TOKEN })).statusCode).toBe(401)
    expect(engine.applied).toEqual([])
  })

  it('ignores sessions not started by Paneful Manager, which send both headers empty', async () => {
    const response = await hook({ hook_event_name: 'Stop' }, { [HOOK_TOKEN_HEADER]: '', [HOOK_SESSION_HEADER]: '' })
    expect(response.statusCode).toBe(204)
    expect(engine.applied).toEqual([])
  })

  it('answers 204 for unknown sessions, invalid ids and invalid payloads', async () => {
    const debug = vi.spyOn(app.log, 'debug')
    expect((await hook({ hook_event_name: 'Stop' }, { [HOOK_SESSION_HEADER]: 'unknownid' })).statusCode).toBe(204)
    expect((await hook({ hook_event_name: 'Stop' }, { [HOOK_SESSION_HEADER]: 'bad id!' })).statusCode).toBe(204)
    expect((await hook('not json')).statusCode).toBe(204)
    expect((await hook({ session_id: 'x' })).statusCode).toBe(204)
    expect((await hook('', {}, { headers: { host: HOST, [HOOK_TOKEN_HEADER]: HOOK_TOKEN, [HOOK_SESSION_HEADER]: SESSION_ID } })).statusCode).toBe(204)
    expect(engine.applied).toEqual([])
    debug.mockRestore()
  })

  it('rejects requests with an Origin header through the security plugin', async () => {
    const response = await hook({ hook_event_name: 'Stop' }, { origin: ORIGIN })
    expect(response.statusCode).toBe(403)
    expect(engine.applied).toEqual([])
  })

  it('accepts payloads above the global body limit', async () => {
    const response = await hook({ hook_event_name: 'PostToolUse', tool_response: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.statusCode).toBe(204)
    expect(engine.applied).toEqual([[SESSION_ID, 'working']])
    expect(HOOK_BODY_LIMIT_BYTES).toBeGreaterThan(2 * 1024 * 1024)
  })
})

describe('hook settings routes', () => {
  const browser = { host: HOST, origin: ORIGIN, [ACCESS_KEY_HEADER]: ACCESS_KEY, [SESSION_TOKEN_HEADER]: SESSION_TOKEN }

  it('installs, reports and uninstalls', async () => {
    const before = await app.inject({ method: 'GET', url: API_ROUTES.hooksStatus, headers: { host: HOST, [ACCESS_KEY_HEADER]: ACCESS_KEY } })
    expect(HookStatusSchema.parse(before.json())).toMatchObject({ installed: false, statusAvailable: false })

    const installed = await app.inject({ method: 'POST', url: API_ROUTES.hooksInstall, headers: browser })
    expect(installed.statusCode).toBe(200)
    expect(HookChangeResponseSchema.parse(installed.json())).toMatchObject({ changed: true, status: { installed: true, statusAvailable: true } })

    const removed = await app.inject({ method: 'POST', url: API_ROUTES.hooksUninstall, headers: browser, payload: {} })
    expect(HookChangeResponseSchema.parse(removed.json())).toMatchObject({ changed: true, status: { installed: false } })
  })

  it('needs the per-boot token and an Origin like every mutation', async () => {
    expect((await app.inject({ method: 'POST', url: API_ROUTES.hooksInstall, headers: { host: HOST, [ACCESS_KEY_HEADER]: ACCESS_KEY } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'POST', url: API_ROUTES.hooksInstall, headers: { host: HOST, origin: ORIGIN, [ACCESS_KEY_HEADER]: ACCESS_KEY } })).statusCode).toBe(401)
  })
})

describe('hook token rotation', () => {
  const browser = { host: HOST, origin: ORIGIN, [ACCESS_KEY_HEADER]: ACCESS_KEY, [SESSION_TOKEN_HEADER]: SESSION_TOKEN }
  const NEW_TOKEN = 'n'.repeat(43)
  let rotating: FastifyInstance
  let current: string
  let stale: StaleHookSessions

  beforeEach(() => {
    current = HOOK_TOKEN
    const logger: FastifyBaseLogger = pino({ level: 'silent' })
    stale = new StaleHookSessions(id => engine.known.has(id))
    rotating = Fastify({ loggerInstance: logger })
    registerSecurity(rotating, { getPort: () => PORT, token: SESSION_TOKEN, accessKey: ACCESS_KEY, dev: false })
    registerHooks(rotating, {
      getPort: () => PORT,
      engine,
      token: () => current,
      stale,
      settings: createHookSettings({
        settingsPath: join(dir, 'rotating.json'),
        backups: createBackupStore({ dir: join(dir, 'backups') }),
        managedDir: join(dir, 'managed'),
        staleSessions: () => stale.list(),
        onChange: () => {
          current = NEW_TOKEN
          stale.mark(engine.known)
          return Promise.resolve()
        },
      }),
    })
  })

  afterEach(() => rotating.close())

  function send(token: string, sessionId = SESSION_ID) {
    return rotating.inject({
      method: 'POST',
      url: API_ROUTES.hooks,
      headers: { host: HOST, 'content-type': 'application/json', [HOOK_TOKEN_HEADER]: token, [HOOK_SESSION_HEADER]: sessionId },
      payload: JSON.stringify({ hook_event_name: 'Stop' }),
    })
  }

  it('rejects the old token after an install, lists the session as stale and clears it on the new token', async () => {
    expect((await send(HOOK_TOKEN)).statusCode).toBe(204)
    const installed = HookChangeResponseSchema.parse((await rotating.inject({ method: 'POST', url: API_ROUTES.hooksInstall, headers: browser })).json())
    expect(installed.status.staleSessions).toEqual([SESSION_ID])

    expect((await send(HOOK_TOKEN)).statusCode).toBe(401)
    expect(engine.applied).toEqual([[SESSION_ID, 'idle']])

    expect((await send(NEW_TOKEN)).statusCode).toBe(204)
    const status = await rotating.inject({ method: 'GET', url: API_ROUTES.hooksStatus, headers: { host: HOST, [ACCESS_KEY_HEADER]: ACCESS_KEY } })
    expect(HookStatusSchema.parse(status.json()).staleSessions).toEqual([])
  })

  it('marks a known session that sends an old token, never an unknown one', async () => {
    current = NEW_TOKEN
    expect((await send(HOOK_TOKEN, 'unknown-session')).statusCode).toBe(401)
    expect(stale.list()).toEqual([])
    expect((await send(HOOK_TOKEN)).statusCode).toBe(401)
    expect(stale.list()).toEqual([SESSION_ID])
    engine.known.delete(SESSION_ID)
    expect(stale.list()).toEqual([])
  })
})

describe('hook request logging', () => {
  it('logs hook requests without the hook token', async () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    const logger: FastifyBaseLogger = createLogger('debug', {}, stream)
    const logged = Fastify({ loggerInstance: logger })
    registerSecurity(logged, { getPort: () => PORT, token: SESSION_TOKEN, accessKey: ACCESS_KEY, dev: false })
    registerHooks(logged, { getPort: () => PORT, engine, token: HOOK_TOKEN })
    const headers = { host: HOST, 'content-type': 'application/json', [HOOK_TOKEN_HEADER]: HOOK_TOKEN, [HOOK_SESSION_HEADER]: 'unknownid' }
    const accepted = await logged.inject({ method: 'POST', url: API_ROUTES.hooks, headers, payload: { hook_event_name: 'Stop' } })
    const rejected = await logged.inject({ method: 'POST', url: API_ROUTES.hooks, headers: { ...headers, [HOOK_TOKEN_HEADER]: `${HOOK_TOKEN}x` }, payload: {} })
    logged.log.info({ req: { headers } }, 'explicit header log')
    await logged.close()
    expect([accepted.statusCode, rejected.statusCode]).toEqual([204, 401])
    const output = chunks.join('')
    expect(output).toContain(API_ROUTES.hooks)
    expect(output).toContain('Ignoring hook for an unknown session')
    expect(output).toContain('explicit header log')
    expect(output).not.toContain(HOOK_TOKEN)
  })
})
