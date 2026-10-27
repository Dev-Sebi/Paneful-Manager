import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG, McpHealthListResponseSchema, McpHealthResultSchema } from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { silentLogger } from '../files/test-helpers.js'
import { createMcpService } from './service.js'
import { createMcpSandbox, type McpSandbox } from './test-helpers.js'

const FIXTURE = fileURLToPath(new URL('./test-fixtures/fake-mcp-stdio.mjs', import.meta.url))
const TOKEN = 'health-route-token'
const PORT = DEFAULT_CONFIG.port
const SECRET = 'sk-route-0123456789'

let box: McpSandbox
let app: FastifyInstance

function send(options: InjectOptions, token = TOKEN) {
  return app.inject({
    ...options,
    headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, ...(token ? { 'x-agent-hub-token': token } : {}), ...options.headers },
  })
}

beforeEach(() => {
  box = createMcpSandbox()
  const stdio = (env: Record<string, string>) => ({ type: 'stdio', command: process.execPath, args: [FIXTURE], env })
  writeFileSync(
    join(box.project, '.mcp.json'),
    JSON.stringify({ mcpServers: { good: stdio({ API_KEY: SECRET }), broken: stdio({ API_KEY: SECRET, FAKE_MCP_FAIL: '1', FAKE_MCP_STDERR: `rejected ${SECRET}` }) } }),
  )
  const service = createMcpService({ getScopes: async () => box.scopes, env: {}, backupDir: join(box.state, 'backups'), logger: silentLogger, mode: 'file', home: box.home })
  app = buildApp({ config: DEFAULT_CONFIG, logger: silentLogger, sessionToken: TOKEN, dev: false, mcp: service })
})

afterEach(async () => {
  await app.close()
  box.cleanup()
})

const scope = () => ({ kind: 'project', projectPath: box.project })

describe('MCP health routes', () => {
  it('checks one entry without exposing env values', async () => {
    const ok = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } })
    expect(ok.statusCode).toBe(200)
    expect(McpHealthResultSchema.parse(ok.json())).toMatchObject({ name: 'good', status: 'ok', serverInfo: { name: 'fake-mcp' } })
    expect(ok.body).not.toContain(SECRET)

    const broken = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'broken', scope: scope() } })
    expect(McpHealthResultSchema.parse(broken.json())).toMatchObject({ status: 'error' })
    expect(broken.body).toContain('***')
    expect(broken.body).not.toContain(SECRET)
  })

  it('answers 404 for unknown servers and projects and 400 for bad input', async () => {
    const missing = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'nope', scope: scope() } })
    expect(missing.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(missing.json()).code).toBe('not_found')
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: { kind: 'project', projectPath: box.home } } })).statusCode).toBe(404)
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: '-s', scope: scope() } })).statusCode).toBe(400)
  })

  it('needs the token on POST', async () => {
    const response = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } }, '')
    expect(response.statusCode).toBe(401)
  })

  it('checks all entries of a project with GET', async () => {
    const response = await send({ method: 'GET', url: API_ROUTES.mcpHealth, query: { projectPath: box.project } })
    expect(response.statusCode).toBe(200)
    const { results } = McpHealthListResponseSchema.parse(response.json())
    expect(results.map(result => [result.name, result.status]).toSorted()).toEqual([['broken', 'error'], ['good', 'ok']])
    expect(response.body).not.toContain(SECRET)
    expect((await send({ method: 'GET', url: API_ROUTES.mcpHealth, query: { projectPath: '/nowhere' } })).statusCode).toBe(404)
  })
})
