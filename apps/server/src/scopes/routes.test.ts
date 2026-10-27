import { API_ROUTES, DEFAULT_CONFIG, ScopesResponseSchema } from '@agent-hub/shared'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerScopes } from './routes.js'

describe('GET /api/scopes', () => {
  it('returns the discovered scopes', async () => {
    const app = Fastify()
    registerScopes(app, { config: { ...DEFAULT_CONFIG, projects: [] }, env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    const response = await app.inject({ method: 'GET', url: API_ROUTES.scopes })
    expect(response.statusCode).toBe(200)
    expect(ScopesResponseSchema.parse(response.json()).scopes).toEqual([{ kind: 'global', path: '/cfg' }])
    await app.close()
  })
})
