import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG, ListSessionsResponseSchema, SESSION_TOKEN_HEADER } from '@paneful-manager/shared'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { RunError } from '../process/exec.js'
import { Tmux } from '../tmux/tmux.js'
import { SessionEngine } from './engine.js'

const logger = pino({ level: 'silent' })
let dir: string
let app: FastifyInstance
const TOKEN = 'test-token'
const local = {
  host: `127.0.0.1:${DEFAULT_CONFIG.port}`,
  origin: `http://127.0.0.1:${DEFAULT_CONFIG.port}`,
  'x-paneful-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN,
}

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { ...local, ...options.headers } })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paneful-manager-routes-'))
  const tmux = new Tmux({ run: async () => {
    throw new RunError('failed', 'exit', 1, '', 'no server running on /tmp/tmux-1000/paneful-manager\n')
  } })
  const engine = new SessionEngine({ stateDir: join(dir, 'state'), logger, tmux })
  await engine.start()
  app = buildApp({ config: DEFAULT_CONFIG, logger, engine, sessionToken: TOKEN, accessKey: TOKEN, dev: false })
})

afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

describe('session routes', () => {
  it('lists sessions', async () => {
    const response = await inject({ method: 'GET', url: API_ROUTES.sessions })
    expect(ListSessionsResponseSchema.parse(response.json())).toEqual({ sessions: [] })
  })

  it('validates the create body', async () => {
    const response = await inject({ method: 'POST', url: API_ROUTES.sessions, payload: { cwd: dir, cols: 0, extra: true } })
    expect(response.statusCode).toBe(400)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('validation_failed')
  })

  it('answers tmux_unavailable when the tmux server is missing', async () => {
    const response = await inject({ method: 'POST', url: API_ROUTES.sessions, payload: { cwd: dir, command: 'sh' } })
    expect(response.statusCode).toBe(503)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('tmux_unavailable')
  })

  it('requires the session token for mutations', async () => {
    const response = await inject({ method: 'DELETE', url: `${API_ROUTES.sessions}/abc123`, headers: { [SESSION_TOKEN_HEADER]: 'wrong' } })
    expect(response.statusCode).toBe(401)
  })

  it('answers not_found for unknown ids and validation_failed for invalid ids', async () => {
    const unknown = await inject({ method: 'DELETE', url: `${API_ROUTES.sessions}/abc123` })
    expect(unknown.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(unknown.json()).code).toBe('not_found')
    const invalid = await inject({ method: 'DELETE', url: `${API_ROUTES.sessions}/a.b` })
    expect(invalid.statusCode).toBe(400)
  })
})
