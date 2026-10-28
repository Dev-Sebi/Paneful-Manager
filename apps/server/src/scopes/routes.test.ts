import { API_ROUTES, DEFAULT_CONFIG, ScopesResponseSchema } from '@paneful-manager/shared'
import Fastify from 'fastify'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { registerScopes } from './routes.js'

describe('GET /api/scopes', () => {
  it('returns the discovered scopes', async () => {
    const app = Fastify()
    registerScopes(app, { getConfig: () => ({ ...DEFAULT_CONFIG, projects: [] }), env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    const response = await app.inject({ method: 'GET', url: API_ROUTES.scopes })
    expect(response.statusCode).toBe(200)
    expect(ScopesResponseSchema.parse(response.json()).scopes).toEqual([{ kind: 'global', path: '/cfg' }])
    await app.close()
  })

  it('answers 200 with fewer scopes when git fails', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scopes-route-')))
    const app = Fastify()
    const run = vi.fn().mockRejectedValue(new Error('no git'))
    registerScopes(app, { getConfig: () => ({ ...DEFAULT_CONFIG, projects: [dir] }), env: { CLAUDE_CONFIG_DIR: '/cfg' }, run })
    const response = await app.inject({ method: 'GET', url: API_ROUTES.scopes })
    expect(response.statusCode).toBe(200)
    expect(ScopesResponseSchema.parse(response.json()).scopes).toEqual([
      { kind: 'global', path: '/cfg' },
      { kind: 'project', path: dir },
    ])
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
