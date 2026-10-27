import { API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG, SessionTokenResponseSchema } from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

const TOKEN = 'per-boot-test-token'
const PORT = DEFAULT_CONFIG.port
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`

let app: FastifyInstance | undefined

function build(dev = false): FastifyInstance {
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, dev })
  app.post('/api/test-mutation', () => ({ done: true }))
  app.post(API_ROUTES.hooks, () => ({ received: true }))
  return app
}

function send(target: FastifyInstance, method: InjectOptions['method'], url: string, headers: Record<string, string | undefined>) {
  return target.inject({ method, url, headers: { host: HOST, ...headers } })
}

async function expectError(response: Awaited<ReturnType<typeof send>>, status: number, code: string): Promise<void> {
  expect(response.statusCode).toBe(status)
  expect(ApiErrorSchema.parse(response.json()).code).toBe(code)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await app?.close()
  app = undefined
})

describe('Host check', () => {
  it('rejects non-local Host headers on every route', async () => {
    const target = build()
    for (const host of ['evil.example', `evil.example:${PORT}`, '127.0.0.1', `localhost:${PORT + 1}`, `192.168.1.10:${PORT}`]) {
      await expectError(await send(target, 'GET', API_ROUTES.health, { host }), 403, 'forbidden')
    }
  })

  it('accepts the loopback names', async () => {
    const target = build()
    for (const host of [`localhost:${PORT}`, `LOCALHOST:${PORT}`, 'localhost', HOST, `[::1]:${PORT}`]) {
      expect((await send(target, 'GET', API_ROUTES.health, { host })).statusCode).toBe(200)
    }
  })
})

describe('Origin check', () => {
  it('allows GET without Origin', async () => {
    expect((await send(build(), 'GET', API_ROUTES.health, {})).statusCode).toBe(200)
  })

  it('rejects a foreign Origin, also on GET', async () => {
    const target = build()
    for (const origin of ['https://evil.example', 'null', `https://127.0.0.1:${PORT}`, `${ORIGIN}/`]) {
      await expectError(await send(target, 'GET', API_ROUTES.health, { origin }), 403, 'forbidden')
    }
    await expectError(
      await send(target, 'POST', '/api/test-mutation', { origin: 'https://evil.example', 'x-agent-hub-token': TOKEN }),
      403,
      'forbidden',
    )
  })

  it('allows the dev origin only in development', async () => {
    const prod = build(false)
    await expectError(await send(prod, 'GET', API_ROUTES.health, { origin: 'http://localhost:3000' }), 403, 'forbidden')
    await prod.close()
    const dev = build(true)
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      expect((await send(dev, 'GET', API_ROUTES.health, { origin })).statusCode).toBe(200)
    }
  })

  it('derives dev mode from NODE_ENV', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN })
    expect((await send(app, 'GET', API_ROUTES.health, { origin: 'http://localhost:3000' })).statusCode).toBe(200)
    await app.close()
    vi.stubEnv('NODE_ENV', 'production')
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN })
    expect((await send(app, 'GET', API_ROUTES.health, { origin: 'http://localhost:3000' })).statusCode).toBe(403)
  })
})

describe('per-boot token', () => {
  it('rejects mutating requests with a missing or wrong token', async () => {
    const target = build()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await expectError(await send(target, method, '/api/test-mutation', {}), 401, 'unauthorized')
    }
    await expectError(await send(target, 'POST', '/api/test-mutation', { 'x-agent-hub-token': 'wrong' }), 401, 'unauthorized')
    await expectError(await send(target, 'POST', '/api/test-mutation', { 'x-agent-hub-token': `${TOKEN}x` }), 401, 'unauthorized')
  })

  it('passes with the correct token, with or without an allowed Origin', async () => {
    const target = build()
    for (const headers of [{ 'x-agent-hub-token': TOKEN }, { 'x-agent-hub-token': TOKEN, origin: ORIGIN }]) {
      const response = await send(target, 'POST', '/api/test-mutation', headers)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ done: true })
    }
  })

  it('keeps health token-free', async () => {
    expect((await send(build(), 'GET', API_ROUTES.health, {})).statusCode).toBe(200)
  })

  it('generates a random base64url token when none is given', async () => {
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), dev: false })
    const { token } = SessionTokenResponseSchema.parse((await send(app, 'GET', API_ROUTES.sessionToken, {})).json())
    expect(token).toMatch(/^[\w-]{43}$/)
  })
})

describe('session token endpoint', () => {
  it('returns the token to same-origin requests', async () => {
    const target = build()
    for (const headers of [{}, { origin: ORIGIN }]) {
      const response = await send(target, 'GET', API_ROUTES.sessionToken, headers)
      expect(response.statusCode).toBe(200)
      expect(SessionTokenResponseSchema.parse(response.json())).toEqual({ token: TOKEN })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('rejects a bad Host or Origin without leaking the token', async () => {
    const target = build()
    for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }]) {
      const response = await send(target, 'GET', API_ROUTES.sessionToken, headers)
      await expectError(response, 403, 'forbidden')
      expect(response.body).not.toContain(TOKEN)
    }
  })
})

describe('hook route', () => {
  it('needs no per-boot token', async () => {
    const response = await send(build(), 'POST', API_ROUTES.hooks, {})
    expect(response.statusCode).toBe(200)
  })

  it('rejects any request with an Origin, even an allowed one', async () => {
    const target = build()
    for (const origin of [ORIGIN, 'https://evil.example']) {
      await expectError(await send(target, 'POST', API_ROUTES.hooks, { origin, 'x-agent-hub-token': TOKEN }), 403, 'forbidden')
    }
  })

  it('still enforces the Host check', async () => {
    await expectError(await send(build(), 'POST', API_ROUTES.hooks, { host: 'evil.example' }), 403, 'forbidden')
  })
})

describe('security headers', () => {
  it('sets nosniff, no-referrer and no-store on API responses, including errors', async () => {
    const target = build()
    for (const response of [
      await send(target, 'GET', API_ROUTES.health, {}),
      await send(target, 'GET', API_ROUTES.health, { host: 'evil.example' }),
      await send(target, 'GET', '/api/missing', {}),
    ]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['cache-control']).toBe('no-store')
    }
  })

  it('does not set no-store outside /api', async () => {
    const response = await send(build(), 'GET', '/index.html', {})
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['cache-control']).toBeUndefined()
  })
})
