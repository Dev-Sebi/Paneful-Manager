import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { CONTENT_SECURITY_POLICY, HASHED_ASSET_CACHE_CONTROL, resolveWebDist, WEB_DIST_ENV_VAR } from './static.js'

const INDEX = '<!doctype html><title>Agent Hub</title>'
let root: string
let app: FastifyInstance

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-hub-web-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), INDEX)
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(root, 'favicon.svg'), '<svg/>')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(async () => {
  await app.close()
})

function get(url: string) {
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: 't', dev: false, webDist: root })
  return app.inject({ method: 'GET', url, headers: { host: `127.0.0.1:${DEFAULT_CONFIG.port}` } })
}

describe('static web app', () => {
  it('serves index.html at / with the CSP and no-cache', async () => {
    const response = await get('/')
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(INDEX)
    expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })

  it('falls back to index.html for client routes', async () => {
    const response = await get('/workspaces/demo?tab=1')
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe(INDEX)
    expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
  })

  it('caches hashed assets immutably and sends no CSP for them', async () => {
    const response = await get('/assets/index-abc123.js')
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe(HASHED_ASSET_CACHE_CONTROL)
    expect(response.headers['content-security-policy']).toBeUndefined()
    expect((await get('/favicon.svg')).headers['cache-control']).toBe('no-cache')
  })

  it('answers missing files with 404 instead of index.html', async () => {
    const response = await get('/assets/missing-123.js')
    expect(response.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(response.json()).code).toBe('not_found')
  })

  it('does not shadow /api routes', async () => {
    expect((await get(API_ROUTES.health)).json()).toMatchObject({ status: 'ok' })
    const unknown = await get('/api/nope')
    expect(unknown.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(unknown.json()).code).toBe('not_found')
    expect((await get('/api')).statusCode).toBe(404)
  })

  it('still applies the Host check', async () => {
    app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: 't', dev: false, webDist: root })
    const response = await app.inject({ method: 'GET', url: '/', headers: { host: 'evil.example:7337' } })
    expect(response.statusCode).toBe(403)
  })
})

describe('resolveWebDist', () => {
  it('uses AGENT_HUB_WEB_DIST when it holds an index.html', () => {
    expect(resolveWebDist({ [WEB_DIST_ENV_VAR]: root }, '/nonexistent')).toBe(root)
  })

  it('falls back to the packaged path and returns undefined without a build', () => {
    expect(resolveWebDist({}, root)).toBe(root)
    expect(resolveWebDist({}, '/nonexistent')).toBeUndefined()
    expect(resolveWebDist({ [WEB_DIST_ENV_VAR]: '/nonexistent' }, root)).toBeUndefined()
  })
})
