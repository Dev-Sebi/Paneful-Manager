import { describe, expect, it } from 'vitest'
import { API_ROUTES } from './api.js'
import {
  ListMcpServersResponseSchema,
  McpServerConfigSchema,
  McpServerEntrySchema,
  McpServerNameSchema,
  RemoveMcpServerRequestSchema,
  UpsertMcpServerRequestSchema,
  maskMcpEntry,
  toMcpScope,
  type McpServerEntry,
} from './mcp.js'
import { issuePaths } from './test-utils.js'

describe('McpServerConfigSchema', () => {
  it('parses a stdio server with default args and env', () => {
    expect(McpServerConfigSchema.parse({ transport: 'stdio', command: 'npx' })).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
    })
  })

  it('parses http and sse servers, also with a ${VAR} url', () => {
    for (const transport of ['http', 'sse'] as const) {
      const server = McpServerConfigSchema.parse({ transport, url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } })
      expect(server.transport).toBe(transport)
    }
    expect(McpServerConfigSchema.parse({ transport: 'http', url: '${API_BASE:-https://a.example}/mcp' })).toMatchObject({ headers: {} })
  })

  it('rejects missing fields, bad urls, unknown transports and unknown keys', () => {
    expect(issuePaths(McpServerConfigSchema, { transport: 'stdio' })).toEqual(['command'])
    expect(issuePaths(McpServerConfigSchema, { transport: 'http', url: 'not a url' })).toEqual(['url'])
    expect(issuePaths(McpServerConfigSchema, { transport: 'http', url: 'file:///etc/passwd' })).toEqual(['url'])
    expect(issuePaths(McpServerConfigSchema, { transport: 'ws', url: 'wss://a.example' })).toEqual(['transport'])
    expect(issuePaths(McpServerConfigSchema, { transport: 'stdio', command: 'x', cwd: '/' })).toEqual([''])
  })
})

describe('McpServerNameSchema', () => {
  it('accepts letters, digits, dash and underscore up to 64 chars', () => {
    for (const name of ['files', 'my-server_2', 'a'.repeat(64), '_x']) {
      expect(McpServerNameSchema.safeParse(name).success).toBe(true)
    }
    for (const name of ['', '-s', 'a b', 'a/b', 'a'.repeat(65), 'x;rm', '../x']) {
      expect(McpServerNameSchema.safeParse(name).success).toBe(false)
    }
  })
})

describe('toMcpScope', () => {
  it('maps global to user and project/worktree to project or local', () => {
    expect(toMcpScope({ kind: 'global', path: '/home/u/.claude' }, true)).toEqual({ kind: 'user' })
    expect(toMcpScope({ kind: 'project', path: '/p' }, true)).toEqual({ kind: 'project', projectPath: '/p' })
    expect(toMcpScope({ kind: 'project', path: '/p' }, false)).toEqual({ kind: 'local', projectPath: '/p' })
    expect(toMcpScope({ kind: 'worktree', path: '/w', projectPath: '/p' }, false)).toEqual({ kind: 'local', projectPath: '/w' })
  })
})

describe('maskMcpEntry', () => {
  it('masks env and header values except the plain keys', () => {
    const stdio: McpServerEntry = McpServerEntrySchema.parse({
      name: 'files',
      scope: { kind: 'user' },
      source: 'file',
      config: { transport: 'stdio', command: 'node', env: { API_KEY: 'secret', EMPTY: '', PATH: '/bin', NODE_ENV: 'production' } },
    })
    expect(maskMcpEntry(stdio).config).toEqual({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: { API_KEY: { masked: true, set: true }, EMPTY: { masked: true, set: false }, PATH: '/bin', NODE_ENV: 'production' },
    })
    const http = McpServerEntrySchema.parse({
      name: 'remote',
      scope: { kind: 'project', projectPath: '/p' },
      source: 'cli',
      config: { transport: 'http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer secret' } },
    })
    expect(JSON.stringify(maskMcpEntry(http))).not.toContain('secret')
  })
})

describe('requests and responses', () => {
  it('accepts keep sentinels on upsert and rejects them elsewhere', () => {
    const request = UpsertMcpServerRequestSchema.parse({
      name: 'files',
      scope: { kind: 'local', projectPath: '/p' },
      config: { transport: 'stdio', command: 'node', env: { API_KEY: { keep: true }, OTHER: 'v' } },
    })
    expect(request.config).toMatchObject({ env: { API_KEY: { keep: true }, OTHER: 'v' } })
    expect(issuePaths(McpServerConfigSchema, { transport: 'stdio', command: 'x', env: { A: { keep: true } } })).toEqual(['env.A'])
    expect(issuePaths(UpsertMcpServerRequestSchema, { name: 'x', scope: { kind: 'project' }, config: { transport: 'stdio', command: 'x' } })).toEqual([
      'scope.projectPath',
    ])
  })

  it('validates remove requests and list responses', () => {
    expect(RemoveMcpServerRequestSchema.parse({ name: 'x', scope: { kind: 'user' } })).toEqual({ name: 'x', scope: { kind: 'user' } })
    expect(issuePaths(RemoveMcpServerRequestSchema, { name: 'x', scope: { kind: 'team' } })).toEqual(['scope.kind'])
    expect(ListMcpServersResponseSchema.parse({ servers: [], mode: 'file' })).toEqual({ servers: [], mode: 'file' })
    expect(API_ROUTES.mcp).toBe('/api/mcp')
  })
})
