import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_ROUTES, ApiErrorSchema, DEFAULT_CONFIG, ListMcpServersResponseSchema, McpHealthListResponseSchema, McpHealthResultSchema } from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { silentLogger } from '../files/test-helpers.js'
import type { HealthRunner, HealthTarget } from './health.js'
import { createMcpService } from './service.js'
import { createMcpSandbox, type McpSandbox } from './test-helpers.js'

const FIXTURE = fileURLToPath(new URL('./test-fixtures/fake-mcp-stdio.mjs', import.meta.url))
const TOKEN = 'health-route-token'
const PORT = DEFAULT_CONFIG.port
const SECRET = 'sk-route-0123456789'

let box: McpSandbox
let app: FastifyInstance
let checked: HealthTarget[]

const fakeRunner: HealthRunner = {
  check: async entry => {
    checked.push(entry)
    return { name: entry.name, scope: entry.scope, status: 'ok' }
  },
}

function send(options: InjectOptions, token = TOKEN) {
  return app.inject({
    ...options,
    headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, ...(token ? { 'x-agent-hub-token': token } : {}), ...options.headers },
  })
}

const marker = (name: string): string => join(box.base, `${name}.marker`)
/** Approval as Claude Code stores it: the project's entry in `~/.claude.json`, trust dialog accepted. */
const approve = (value: Record<string, unknown>): void => {
  writeFileSync(join(box.home, '.claude.json'), JSON.stringify({ projects: { [box.project]: { hasTrustDialogAccepted: true, ...value } } }))
}
const writeLocalSettings = (value: unknown): void => {
  mkdirSync(join(box.project, '.claude'), { recursive: true })
  writeFileSync(join(box.project, '.claude', 'settings.local.json'), JSON.stringify(value))
}

function start(health?: HealthRunner): void {
  const service = createMcpService({ getScopes: async () => box.scopes, env: {}, backupDir: join(box.state, 'backups'), logger: silentLogger, mode: 'file', home: box.home })
  app = buildApp({ config: DEFAULT_CONFIG, logger: silentLogger, sessionToken: TOKEN, dev: false, mcp: { service, ...(health ? { health } : {}) } })
}

beforeEach(() => {
  checked = []
  box = createMcpSandbox()
  const stdio = (env: Record<string, string>) => ({ type: 'stdio', command: process.execPath, args: [FIXTURE], env })
  writeFileSync(
    join(box.project, '.mcp.json'),
    JSON.stringify({ mcpServers: { good: stdio({ API_KEY: SECRET, FAKE_MCP_DUMP: marker('good') }), broken: stdio({ API_KEY: SECRET, FAKE_MCP_FAIL: '1', FAKE_MCP_STDERR: `rejected ${SECRET}` }) } }),
  )
  start()
})

afterEach(async () => {
  await app.close()
  box.cleanup()
})

const scope = () => ({ kind: 'project', projectPath: box.project })

describe('MCP health routes', () => {
  it('reports unapproved project entries as unsupported without running them', async () => {
    const one = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } })
    expect(McpHealthResultSchema.parse(one.json())).toMatchObject({ status: 'unsupported', error: 'not approved in Claude Code' })
    const all = await send({ method: 'POST', url: API_ROUTES.mcpHealthAll, payload: { projectPath: box.project } })
    const { results } = McpHealthListResponseSchema.parse(all.json())
    expect(results.map(result => result.status)).toEqual(['unsupported', 'unsupported'])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(marker('good'))).toBe(false)
    const listed = ListMcpServersResponseSchema.parse((await send({ method: 'GET', url: API_ROUTES.mcp })).json())
    expect(listed.servers.map(server => server.approved)).toEqual([false, false])
  })

  it('runs entries approved through enabledMcpjsonServers or enableAllProjectMcpServers', async () => {
    approve({ enabledMcpjsonServers: ['good'] })
    const ok = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } })
    expect(McpHealthResultSchema.parse(ok.json())).toMatchObject({ name: 'good', status: 'ok', serverInfo: { name: 'fake-mcp' } })
    expect(ok.body).not.toContain(SECRET)
    expect(existsSync(marker('good'))).toBe(true)
    const stillBlocked = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'broken', scope: scope() } })
    expect(McpHealthResultSchema.parse(stillBlocked.json()).status).toBe('unsupported')

    approve({ enableAllProjectMcpServers: true })
    const broken = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'broken', scope: scope() } })
    expect(McpHealthResultSchema.parse(broken.json())).toMatchObject({ status: 'error' })
    expect(broken.body).toContain('***')
    expect(broken.body).not.toContain(SECRET)
  })

  it('does not run an entry in disabledMcpjsonServers', async () => {
    approve({ enableAllProjectMcpServers: true })
    writeLocalSettings({ disabledMcpjsonServers: ['good'] })
    const { results } = McpHealthListResponseSchema.parse((await send({ method: 'POST', url: API_ROUTES.mcpHealthAll, payload: { projectPath: box.project } })).json())
    expect(results.map(result => [result.name, result.status]).toSorted()).toEqual([['broken', 'error'], ['good', 'unsupported']])
    expect(existsSync(marker('good'))).toBe(false)
  })

  it('does not take approvals from project settings or without the trust dialog', async () => {
    writeLocalSettings({ enableAllProjectMcpServers: true, enabledMcpjsonServers: ['good'] })
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } })).json()).toMatchObject({ status: 'unsupported' })
    writeFileSync(join(box.home, '.claude.json'), JSON.stringify({ projects: { [box.project]: { enabledMcpjsonServers: ['good'] } } }))
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } })).json()).toMatchObject({ status: 'unsupported' })
    expect(existsSync(marker('good'))).toBe(false)
  })

  it('always allows user and local scope entries', async () => {
    writeFileSync(join(box.home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { type: 'stdio', command: process.execPath, args: [FIXTURE], env: {} } } }))
    await app.close()
    start(fakeRunner)
    const response = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'mine', scope: { kind: 'user' } } })
    expect(response.statusCode).toBe(200)
    expect(checked.map(entry => [entry.name, entry.approved])).toEqual([['mine', true]])
  })

  it('hands the approval flag and unmasked config to an injected runner', async () => {
    await app.close()
    start(fakeRunner)
    await send({ method: 'POST', url: API_ROUTES.mcpHealthAll, payload: {} })
    expect(checked.map(entry => [entry.name, entry.approved])).toEqual([['good', false], ['broken', false]])
    expect(checked[0]?.config).toMatchObject({ env: { API_KEY: SECRET } })
  })

  it('answers 404 for unknown servers and projects and 400 for bad input', async () => {
    const missing = await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'nope', scope: scope() } })
    expect(missing.statusCode).toBe(404)
    expect(ApiErrorSchema.parse(missing.json()).code).toBe('not_found')
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: { kind: 'project', projectPath: box.home } } })).statusCode).toBe(404)
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: '-s', scope: scope() } })).statusCode).toBe(400)
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealthAll, payload: { projectPath: '/nowhere' } })).statusCode).toBe(404)
  })

  it('needs the token on both POST routes and has no GET', async () => {
    approve({ enableAllProjectMcpServers: true })
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealth, payload: { name: 'good', scope: scope() } }, '')).statusCode).toBe(401)
    expect((await send({ method: 'POST', url: API_ROUTES.mcpHealthAll, payload: {} }, '')).statusCode).toBe(401)
    expect((await send({ method: 'GET', url: API_ROUTES.mcpHealth, query: { projectPath: box.project } })).statusCode).toBe(404)
    expect((await send({ method: 'GET', url: API_ROUTES.mcpHealthAll })).statusCode).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(marker('good'))).toBe(false)
  })
})
