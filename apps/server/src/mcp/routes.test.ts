import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_ROUTES,
  ApiErrorSchema,
  DEFAULT_CONFIG,
  ListMcpServersResponseSchema,
  RemoveMcpServerResponseSchema,
  UpsertMcpServerResponseSchema,
} from '@agent-hub/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { silentLogger } from '../files/test-helpers.js'
import { RunError } from '../process/exec.js'
import { createMcpService, type McpServiceOptions } from './service.js'
import { captureLogger, createFakeRun, createMcpSandbox, type FakeRun, type McpSandbox } from './test-helpers.js'

const TOKEN = 'mcp-route-token'
const PORT = DEFAULT_CONFIG.port
const SECRET = 'sk-test-0123456789'

let box: McpSandbox
let app: FastifyInstance | undefined

function start(fake: FakeRun, overrides: Partial<McpServiceOptions> & { logger?: Logger } = {}): FastifyInstance {
  const service = createMcpService({
    getScopes: async () => box.scopes,
    env: {},
    backupDir: join(box.state, 'backups'),
    logger: silentLogger,
    run: fake.run,
    home: box.home,
    ...overrides,
  })
  app = buildApp({ config: DEFAULT_CONFIG, logger: overrides.logger ?? silentLogger, sessionToken: TOKEN, dev: false, mcp: service })
  return app
}

function send(target: FastifyInstance, options: InjectOptions) {
  return target.inject({
    ...options,
    headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, 'x-agent-hub-token': TOKEN, ...options.headers },
  })
}

const claudeJson = (): string => join(box.home, '.claude.json')
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

beforeEach(() => {
  box = createMcpSandbox()
})

afterEach(async () => {
  await app?.close()
  app = undefined
  box.cleanup()
})

describe('MCP routes in file mode', () => {
  it('upserts stdio and http servers, lists them masked, updates with keep and removes', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ oauthAccount: { accountUuid: 'fake' }, projects: {} }, null, 2))
    const target = start(createFakeRun(null))
    const local = { kind: 'local', projectPath: box.project }
    const shared = { kind: 'project', projectPath: box.worktree }

    const stdio = await send(target, {
      method: 'PUT',
      url: API_ROUTES.mcp,
      payload: { name: 'files', scope: local, config: { transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { API_KEY: SECRET, NODE_ENV: 'production' } } },
    })
    expect(stdio.statusCode).toBe(200)
    expect(UpsertMcpServerResponseSchema.parse(stdio.json())).toMatchObject({
      created: true,
      server: { source: 'file', config: { env: { API_KEY: { masked: true, set: true }, NODE_ENV: 'production' } } },
    })
    expect(stdio.body).not.toContain(SECRET)

    const http = await send(target, {
      method: 'PUT',
      url: API_ROUTES.mcp,
      payload: { name: 'remote', scope: shared, config: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } } },
    })
    expect(http.statusCode).toBe(200)
    expect(readJson(join(box.worktree, '.mcp.json'))).toEqual({
      mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } } },
    })

    const listed = await send(target, { method: 'GET', url: API_ROUTES.mcp })
    expect(listed.statusCode).toBe(200)
    expect(listed.body).not.toContain(SECRET)
    const list = ListMcpServersResponseSchema.parse(listed.json())
    expect(list.mode).toBe('file')
    expect(list.servers.map(server => [server.name, server.scope])).toEqual([
      ['files', local],
      ['remote', shared],
    ])

    const updated = await send(target, {
      method: 'PUT',
      url: API_ROUTES.mcp,
      payload: { name: 'files', scope: local, config: { transport: 'stdio', command: 'node', env: { API_KEY: { keep: true }, EXTRA: 'e' } } },
    })
    expect(UpsertMcpServerResponseSchema.parse(updated.json()).created).toBe(false)
    const projects = readJson(claudeJson()).projects as Record<string, { mcpServers: Record<string, unknown> }>
    expect(projects[box.project]?.mcpServers.files).toEqual({ type: 'stdio', command: 'node', args: [], env: { API_KEY: SECRET, EXTRA: 'e' } })
    expect(readJson(claudeJson()).oauthAccount).toEqual({ accountUuid: 'fake' })

    const removed = await send(target, { method: 'DELETE', url: API_ROUTES.mcp, payload: { name: 'remote', scope: shared } })
    expect(RemoveMcpServerResponseSchema.parse(removed.json())).toEqual({ name: 'remote', scope: shared, removed: true })
    expect(readJson(join(box.worktree, '.mcp.json'))).toEqual({ mcpServers: {} })

    const filtered = ListMcpServersResponseSchema.parse((await send(target, { method: 'GET', url: API_ROUTES.mcp, query: { projectPath: box.worktree } })).json())
    expect(filtered.servers).toEqual([])
  })

  it('rejects invalid input, unknown projects, keep without a stored value and missing servers', async () => {
    const target = start(createFakeRun(null))
    const invalid = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'ws', url: 'wss://a.example' } } })
    expect(invalid.statusCode).toBe(400)
    expect(ApiErrorSchema.parse(invalid.json()).code).toBe('validation_failed')

    const badName = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: '-s', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x' } } })
    expect(badName.statusCode).toBe(400)

    const unknown = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'project', projectPath: box.home }, config: { transport: 'stdio', command: 'x' } } })
    expect(unknown.statusCode).toBe(404)
    expect((await send(target, { method: 'GET', url: API_ROUTES.mcp, query: { projectPath: '/nowhere' } })).statusCode).toBe(404)

    const keep = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x', env: { K: { keep: true } } } } })
    expect(keep.statusCode).toBe(400)
    expect(existsSync(claudeJson())).toBe(false)

    const missing = await send(target, { method: 'DELETE', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' } } })
    expect(missing.statusCode).toBe(404)
  })

  it('needs the token on writes', async () => {
    const target = start(createFakeRun(null))
    const response = await send(target, { method: 'DELETE', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' } }, headers: { 'x-agent-hub-token': 'wrong' } })
    expect(response.statusCode).toBe(401)
  })

  it('answers 409 for a broken ~/.claude.json and leaves it alone', async () => {
    writeFileSync(claudeJson(), '{ broken')
    const target = start(createFakeRun(null))
    const response = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x' } } })
    expect(response.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(response.json()).message).toContain('is not valid JSON')
    expect(readFileSync(claudeJson(), 'utf8')).toBe('{ broken')
    expect((await send(target, { method: 'GET', url: API_ROUTES.mcp })).statusCode).toBe(200)
  })

  it('reports a broken file by position only, without quoting its content', async () => {
    const token = 'sk-live-ABCDEF0123456789'
    writeFileSync(claudeJson(), `{\n  "oauthAccount": { "token": "${token}" oops },\n  "a": 1\n}\n`)
    const { logger, output } = captureLogger()
    const target = start(createFakeRun(null), { logger })
    const response = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x' } } })
    expect(response.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(response.json()).message).toMatch(/\(InvalidSymbol at line 2, column 57\)/)
    expect((await send(target, { method: 'GET', url: API_ROUTES.mcp })).statusCode).toBe(200)
    expect(output()).toContain('Skipping MCP scope')
    expect(response.body).not.toContain(token)
    expect(output()).not.toContain(token)
  })

  it('never logs env or header values', async () => {
    const { logger, output } = captureLogger()
    const target = start(createFakeRun(null), { logger })
    await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'http', url: 'https://a.example', headers: { Authorization: SECRET } } } })
    await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'x', scope: { kind: 'user' }, config: { transport: 'http', url: 'https://a.example', headers: { Authorization: { keep: true } } } } })
    expect(output()).toContain('MCP server saved')
    expect(output()).not.toContain(SECRET)
  })
})

const failingAdd = (onRemove?: () => void) => createFakeRun('2.1.311', call => {
  if (call.args[1] === 'remove') {
    onRemove?.()
    return { code: 0, stdout: '', stderr: '' }
  }
  throw new RunError('claude exited with code 1', 'exit', 1, '', 'boom')
})

describe('MCP routes in CLI mode', () => {
  it('restores through the file when the CLI restore fails too', async () => {
    const old = { type: 'stdio', command: 'old', args: [], env: { K: SECRET } }
    const fake = failingAdd(() => writeFileSync(claudeJson(), JSON.stringify({ a: 1, mcpServers: {} })))
    writeFileSync(claudeJson(), JSON.stringify({ a: 1, mcpServers: { srv: old } }))
    const response = await send(start(fake), { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'srv', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'new' } } })
    expect(response.statusCode).toBe(409)
    expect(readJson(claudeJson())).toEqual({ a: 1, mcpServers: { srv: old } })
  })

  it('answers 500 without secrets when no restore works', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { srv: { type: 'stdio', command: 'old', args: [], env: { K: SECRET } } } }))
    const fake = failingAdd(() => writeFileSync(claudeJson(), '{ broken'))
    const response = await send(start(fake), { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'srv', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'new', env: { K: { keep: true } } } } })
    expect(response.statusCode).toBe(500)
    expect(ApiErrorSchema.parse(response.json())).toEqual({ code: 'internal', message: 'MCP server "srv" update failed and the entry was removed; re-add it manually' })
    expect(response.body).not.toContain(SECRET)
  })

  it('adds, updates and removes through claude mcp with exact argv', async () => {
    writeFileSync(join(box.project, '.mcp.json'), JSON.stringify({ mcpServers: { srv: { type: 'http', url: 'https://old.example', oauth: { clientId: 'id' }, headers: { Authorization: SECRET } } } }))
    const fake = createFakeRun('2.1.311')
    const target = start(fake)
    const scope = { kind: 'project', projectPath: box.project }

    const list = ListMcpServersResponseSchema.parse((await send(target, { method: 'GET', url: API_ROUTES.mcp })).json())
    expect(list).toMatchObject({ mode: 'cli', cliVersion: '2.1.311' })
    expect(JSON.stringify(list)).not.toContain(SECRET)

    const created = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'new_1', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'npx', args: ['a b'], env: { K: 'v' } } } })
    expect(UpsertMcpServerResponseSchema.parse(created.json())).toMatchObject({ created: true, server: { source: 'cli' } })

    const updated = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'srv', scope, config: { transport: 'http', url: 'https://new.example', headers: { Authorization: { keep: true } } } } })
    expect(updated.statusCode).toBe(200)

    await send(target, { method: 'DELETE', url: API_ROUTES.mcp, payload: { name: 'srv', scope } })

    expect(fake.mcpCalls()).toEqual([
      ['mcp', 'add-json', '-s', 'user', 'new_1', '{"type":"stdio","command":"npx","args":["a b"],"env":{"K":"v"}}'],
      ['mcp', 'remove', '-s', 'project', 'srv'],
      ['mcp', 'add-json', '-s', 'project', 'srv', JSON.stringify({ type: 'http', url: 'https://new.example', oauth: { clientId: 'id' }, headers: { Authorization: SECRET } })],
      ['mcp', 'remove', '-s', 'project', 'srv'],
    ])
    const cwds = fake.calls.filter(call => call.args[0] === 'mcp').map(call => call.options.cwd)
    expect(cwds).toEqual([box.home, box.project, box.project, box.project])
    expect(fake.calls.filter(call => call.args[0] === '--version')).toHaveLength(1)
  })

  it('validates the name before any CLI call', async () => {
    const fake = createFakeRun('2.1.311')
    const target = start(fake)
    for (const name of ['--help', 'a;b', 'x'.repeat(65), '']) {
      const response = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name, scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x' } } })
      expect(response.statusCode).toBe(400)
    }
    expect(fake.calls).toEqual([])
  })

  it('restores the old entry when the add of an update fails', async () => {
    writeFileSync(claudeJson(), JSON.stringify({ mcpServers: { srv: { type: 'stdio', command: 'old', args: [], env: {} } } }))
    let adds = 0
    const fake = createFakeRun('2.1.311', call => {
      if (call.args[1] === 'add-json' && adds++ === 0) {
        throw new RunError('claude exited with code 1', 'exit', 1, '', 'boom')
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const target = start(fake)
    const response = await send(target, { method: 'PUT', url: API_ROUTES.mcp, payload: { name: 'srv', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'new' } } })
    expect(response.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(response.json()).message).toBe('claude mcp add-json failed: boom')
    expect(fake.mcpCalls().map(args => args.slice(1, 2))).toEqual([['remove'], ['add-json'], ['add-json']])
    expect(fake.mcpCalls()[2]?.[5]).toBe('{"type":"stdio","command":"old","args":[],"env":{}}')
  })
})
