import { ACCESS_KEY_HEADER, API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG, SessionTokenResponseSchema } from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'

const TOKEN = 'per-boot-test-token'
const KEY = 'persisted-access-key'
const PORT = DEFAULT_CONFIG.port
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://127.0.0.1:${PORT}`

let app: FastifyInstance | undefined

function build(dev = false, devOrigins: string[] = []): FastifyInstance {
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, accessKey: KEY, dev, devOrigins })
  app.get('/api/test-read', () => ({ secret: 'data' }))
  app.post('/api/test-mutation', () => ({ done: true }))
  app.post(API_ROUTES.hooks, () => ({ received: true }))
  app.delete(API_ROUTES.hooks, () => ({ deleted: true }))
  return app
}

/** Sends the access key unless `headers` overrides it (`undefined` drops it). */
function send(target: FastifyInstance, method: InjectOptions['method'], url: string, headers: Record<string, string | undefined>) {
  const merged = Object.entries({ host: HOST, [ACCESS_KEY_HEADER]: KEY, ...headers }).filter(([, value]) => value !== undefined)
  return target.inject({ method, url, headers: Object.fromEntries(merged) as Record<string, string> })
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

  it('accepts configured dev origins only in development and still rejects foreign ones', async () => {
    const extra = ['http://localhost:3001']
    const prod = build(false, extra)
    await expectError(await send(prod, 'GET', API_ROUTES.health, { origin: 'http://localhost:3001' }), 403, 'forbidden')
    await prod.close()
    const dev = build(true, extra)
    expect((await send(dev, 'GET', API_ROUTES.health, { origin: 'http://localhost:3001' })).statusCode).toBe(200)
    await expectError(await send(dev, 'GET', API_ROUTES.health, { origin: 'http://evil.example' }), 403, 'forbidden')
    await expectError(await send(dev, 'POST', '/api/test-mutation', { origin: 'http://evil.example', 'x-agent-hub-token': TOKEN }), 403, 'forbidden')
  })

  it('derives dev mode from NODE_ENV', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, accessKey: KEY })
    expect((await send(app, 'GET', API_ROUTES.health, { origin: 'http://localhost:3000' })).statusCode).toBe(200)
    await app.close()
    vi.stubEnv('NODE_ENV', 'production')
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, accessKey: KEY })
    expect((await send(app, 'GET', API_ROUTES.health, { origin: 'http://localhost:3000' })).statusCode).toBe(403)
  })
})

describe('per-boot token', () => {
  it('rejects mutating requests with a missing or wrong token', async () => {
    const target = build()
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await expectError(await send(target, method, '/api/test-mutation', { origin: ORIGIN }), 401, 'unauthorized')
    }
    for (const candidate of ['wrong', `${TOKEN}x`]) {
      const headers = { origin: ORIGIN, 'x-agent-hub-token': candidate }
      await expectError(await send(target, 'POST', '/api/test-mutation', headers), 401, 'unauthorized')
    }
  })

  it('rejects mutating requests without Origin even with the correct token', async () => {
    await expectError(await send(build(), 'POST', '/api/test-mutation', { 'x-agent-hub-token': TOKEN }), 401, 'unauthorized')
  })

  it('passes with the correct token and an allowed Origin', async () => {
    const response = await send(build(), 'POST', '/api/test-mutation', { 'x-agent-hub-token': TOKEN, origin: ORIGIN })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ done: true })
  })

  it('keeps health token-free', async () => {
    expect((await send(build(), 'GET', API_ROUTES.health, {})).statusCode).toBe(200)
  })

  it('generates a random base64url token when none is given', async () => {
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), accessKey: KEY, dev: false })
    const { token } = SessionTokenResponseSchema.parse((await send(app, 'GET', API_ROUTES.sessionToken, {})).json())
    expect(token).toMatch(/^[\w-]{43}$/)
  })
})

describe('access key', () => {
  it('rejects reads and mutations without the key or with a wrong one, before any route runs', async () => {
    const target = build()
    for (const key of [undefined, '', 'wrong', `${KEY}x`, TOKEN]) {
      const read = await send(target, 'GET', '/api/test-read', { [ACCESS_KEY_HEADER]: key })
      await expectError(read, 401, 'login_required')
      expect(read.body).not.toContain('data')
      const headers = { [ACCESS_KEY_HEADER]: key, origin: ORIGIN, 'x-agent-hub-token': TOKEN }
      await expectError(await send(target, 'POST', '/api/test-mutation', headers), 401, 'login_required')
    }
  })

  it('guards unknown API paths too, so they reveal nothing', async () => {
    await expectError(await send(build(), 'GET', '/api/missing', { [ACCESS_KEY_HEADER]: undefined }), 401, 'login_required')
  })

  it('keeps health and the hook route free of it', async () => {
    const target = build()
    expect((await send(target, 'GET', API_ROUTES.health, { [ACCESS_KEY_HEADER]: undefined })).statusCode).toBe(200)
    expect((await send(target, 'HEAD', API_ROUTES.health, { [ACCESS_KEY_HEADER]: undefined })).statusCode).toBe(200)
    expect((await send(target, 'POST', API_ROUTES.hooks, { [ACCESS_KEY_HEADER]: undefined })).statusCode).toBe(200)
  })

  it('serves reads with the key', async () => {
    const response = await send(build(), 'GET', '/api/test-read', {})
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ secret: 'data' })
  })
})

describe('session token endpoint', () => {
  it('never hands out the token without the access key', async () => {
    const target = build()
    for (const headers of [{ [ACCESS_KEY_HEADER]: undefined }, { [ACCESS_KEY_HEADER]: 'wrong', origin: ORIGIN }, { [ACCESS_KEY_HEADER]: undefined, 'sec-fetch-site': 'same-origin' }]) {
      const response = await send(target, 'GET', API_ROUTES.sessionToken, headers)
      await expectError(response, 401, 'login_required')
      expect(response.body).not.toContain(TOKEN)
    }
  })

  it('returns the token to same-origin requests', async () => {
    const target = build()
    for (const headers of [{}, { origin: ORIGIN }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }]) {
      const response = await send(target, 'GET', API_ROUTES.sessionToken, headers)
      expect(response.statusCode).toBe(200)
      expect(SessionTokenResponseSchema.parse(response.json())).toEqual({ token: TOKEN })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('rejects a bad Host, Origin or cross-site fetch without leaking the token', async () => {
    const target = build()
    for (const headers of [{ host: 'attacker.example' }, { origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await send(target, 'GET', API_ROUTES.sessionToken, headers)
      await expectError(response, 403, 'forbidden')
      expect(response.body).not.toContain(TOKEN)
    }
  })
})

describe('hook route', () => {
  it('needs no per-boot token and no Origin for POST', async () => {
    const response = await send(build(), 'POST', API_ROUTES.hooks, {})
    expect(response.statusCode).toBe(200)
  })

  it('exempts only POST from the per-boot token', async () => {
    const target = build()
    await expectError(await send(target, 'DELETE', API_ROUTES.hooks, {}), 401, 'unauthorized')
    const headers = { origin: ORIGIN, 'x-agent-hub-token': TOKEN }
    expect((await send(target, 'DELETE', API_ROUTES.hooks, headers)).statusCode).toBe(200)
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
