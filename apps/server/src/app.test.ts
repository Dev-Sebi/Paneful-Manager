import { ApiErrorSchema, API_ROUTES, DEFAULT_CONFIG, HealthResponseSchema } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildApp } from './app.js'

let app: FastifyInstance

function build(): FastifyInstance {
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }) })
  return app
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
  })

  it('answers unknown routes with not_found', async () => {
    const response = await build().inject({ method: 'GET', url: '/nope' })
    expect(response.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('not_found')
  })

  it('maps ZodError to validation_failed', async () => {
    build().get('/boom', () => z.object({ a: z.string() }).parse({}))
    const response = await app.inject({ method: 'GET', url: '/boom' })
    expect(response.statusCode).toBe(400)
    const body = ApiErrorSchema.parse(response.json())
    expect(body.code).toBe('validation_failed')
    expect(body.code === 'validation_failed' && body.details[0]?.path).toEqual(['a'])
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
})
