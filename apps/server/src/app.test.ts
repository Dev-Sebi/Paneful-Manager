import { ApiErrorSchema, PortSchema, API_ROUTES, DEFAULT_CONFIG, HealthResponseSchema } from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { AppError } from './errors.js'

let app: FastifyInstance

const TOKEN = 'test-token'

function build(): FastifyInstance {
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, dev: false })
  const inject = app.inject.bind(app)
  const local = (options: InjectOptions) =>
    inject({ ...options, headers: {
        host: `localhost:${DEFAULT_CONFIG.port}`,
        origin: `http://localhost:${DEFAULT_CONFIG.port}`,
        'x-agent-hub-token': TOKEN,
        ...options.headers,
      },
    })
  return Object.assign(app, { inject: local })
}

afterEach(async () => {
  await app.close()
})

describe('buildApp', () => {
  it('answers the health route with the shared shape', async () => {
    const response = await build().inject({ method: 'GET', url: API_ROUTES.health })
    expect(response.statusCode).toBe(200)
    const body = HealthResponseSchema.parse(response.json())
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(body.tmux).toBe('unavailable')
  })

  it('answers unknown routes with not_found', async () => {
    const response = await build().inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('not_found')
  })

  it('maps ZodError to validation_failed', async () => {
    build().get('/boom', () => PortSchema.parse('x'))
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(400)
    const body = ApiErrorSchema.parse(response.json())
    expect(body.code).toBe('validation_failed')
    expect(body.code === 'validation_failed' && body.details[0]?.path).toEqual([])
  })

  it('hides internal error details', async () => {
    build().get('/boom', () => {
      throw new Error('secret detail')
    })
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain('secret')
    expect(ApiErrorSchema.parse(response.json()).code).toBe('internal')
  })

  it('rejects bodies over 1 MiB', async () => {
    build().post('/echo', () => ({}))
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }),
    })
    expect(response.statusCode).toBe(413)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('bad_request')
  })

  it('does not echo messages of plain errors, even with a client status', async () => {
    build().get('/boom', () => {
      throw Object.assign(new Error('secret detail'), { statusCode: 400 })
    })
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain('secret')
  })

  it('maps AppError to its status and code and exposes its message', async () => {
    build().get('/boom', () => {
      throw new AppError('Name taken', 409, 'conflict')
    })
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({ code: 'conflict', message: 'Name taken' })
  })

  it('keeps the code and message of server-side AppErrors', async () => {
    build().get('/boom', () => {
      throw new AppError('tmux server is not running', 503, 'tmux_unavailable', { detail: 'no server' })
    })
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ code: 'tmux_unavailable', message: 'tmux server is not running', details: { detail: 'no server' } })
  })

  it('maps status codes to error codes', async () => {
    build().get('/m/:s', request => {
      throw Object.assign(new Error('x'), { statusCode: Number((request.params as { s: string }).s) })
    })
    const codes: Record<string, string> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 415: 'bad_request', 503: 'internal' }
    for (const [status, code] of Object.entries(codes)) {
      const response = await app.inject({ method: 'GET', url: `/m/${status}` })
      expect(response.statusCode).toBe(Number(status))
      expect(ApiErrorSchema.parse(response.json()).code).toBe(code)
    }
  })
})
