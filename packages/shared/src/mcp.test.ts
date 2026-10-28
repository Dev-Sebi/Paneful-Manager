import { describe, expect, it } from 'vitest'
import { API_ROUTES } from './api.js'
import {
  ListMcpServersResponseSchema,
  McpHealthAllRequestSchema,
  McpHealthRequestSchema,
  McpHealthResultSchema,
  McpServerConfigSchema,
  McpServerEntrySchema,
  McpServerNameSchema,
  RESERVED_MCP_NAMES,
  MCP_MASKED_PLACEHOLDER as M,
  RemoveMcpServerRequestSchema,
  UpsertMcpServerRequestSchema,
  maskMcpArgs,
  maskMcpEntry,
  maskMcpUrl,
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

  it('rejects the reserved built-in names in any case', () => {
    for (const name of [...RESERVED_MCP_NAMES, 'Workspace', 'COMPUTER-USE']) {
      expect(McpServerNameSchema.safeParse(name).success).toBe(false)
    }
    expect(McpServerNameSchema.safeParse('workspace-tools').success).toBe(true)
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
  it('carries the approval flag', () => {
    const entry: McpServerEntry = { name: 'x', scope: { kind: 'user' }, source: 'file', config: { transport: 'stdio', command: 'x', args: [], env: {} } }
    expect(maskMcpEntry(entry, false).approved).toBe(false)
  })

  it('masks env and header values except the plain keys', () => {
    const stdio: McpServerEntry = McpServerEntrySchema.parse({
      name: 'files',
      scope: { kind: 'user' },
      source: 'file',
      config: { transport: 'stdio', command: 'node', env: { API_KEY: 'secret', EMPTY: '', PATH: '/bin', NODE_ENV: 'production' } },
    })
    expect(maskMcpEntry(stdio, true).config).toEqual({
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
    expect(JSON.stringify(maskMcpEntry(http, true))).not.toContain('secret')
  })
})

describe('maskMcpArgs', () => {
  const token = `ghp_${'a'.repeat(36)}`

  it.each([
    [['--token=abc123'], ['--token=' + M]],
    [['--api-key', 'abc123', '--port', '3000'], ['--api-key', M, '--port', '3000']],
    [['-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=abc123'], ['-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=' + M]],
    [['--env=GITHUB_TOKEN=abc123', '-e=API_KEY=abc123'], ['--env=GITHUB_TOKEN=' + M, '-e=API_KEY=' + M]],
    [['--header', 'Authorization: Bearer abc123'], ['--header', 'Authorization: Bearer ' + M]],
    [['--header=X-Api-Key: abc123'], ['--header=X-Api-Key: ' + M]],
    [['postgresql://app:pa55@db.local:5432/main'], [`postgresql://app:${M}@db.local:5432/main`]],
    [['--db=postgresql://app:pa55@db.local/main'], [`--db=postgresql://app:${M}@db.local/main`]],
    [[token], [M]],
    [['--password'], ['--password']],
    [['--api-key', '--verbose'], ['--api-key', '--verbose']],
  ])('masks %j', (args, expected) => {
    expect(maskMcpArgs(args)).toEqual(expected)
  })

  it('keeps references, ordinary arguments and empty values visible', () => {
    const args = ['-y', '@modelcontextprotocol/server-github', '--token=${GITHUB_TOKEN}', '--api-key', '$API_KEY', 'TOKEN=', '/home/user/project', 'https://example.com/docs']
    expect(maskMcpArgs(args)).toEqual(args)
  })

  it('is stable when applied to masked output', () => {
    const once = maskMcpArgs(['--token', 'abc123', 'Authorization: Bearer x1'])
    expect(maskMcpArgs(once)).toEqual(once)
  })
})

describe('maskMcpUrl', () => {
  it.each([
    ['https://user:pa55@mcp.example.com/sse', `https://user:${M}@mcp.example.com/sse`],
    ['https://abc123token@mcp.example.com/', `https://${M}@mcp.example.com/`],
    ['https://mcp.example.com/mcp?api_key=abc&region=eu&token=x#top', `https://mcp.example.com/mcp?api_key=${M}&region=eu&token=${M}#top`],
    [`https://mcp.example.com/u/sk-${'b'.repeat(30)}/sse`, `https://mcp.example.com/u/${M}/sse`],
  ])('masks %s', (url, expected) => {
    expect(maskMcpUrl(url)).toBe(expected)
  })

  it.each(['https://mcp.example.com/mcp?region=eu', 'https://mcp.example.com/?token=${TOKEN}', '${BASE_URL}/mcp', 'https://${USER}:${PASS}@h/'])('keeps %s', url => {
    expect(maskMcpUrl(url)).toBe(url)
  })

  it('masks args and url in entries', () => {
    const stdio = McpServerEntrySchema.parse({ name: 's', scope: { kind: 'user' }, source: 'file', config: { transport: 'stdio', command: 'npx', args: ['--token', 'abc123'] } })
    expect(JSON.stringify(maskMcpEntry(stdio, true))).not.toContain('abc123')
    const http = McpServerEntrySchema.parse({ name: 'r', scope: { kind: 'user' }, source: 'file', config: { transport: 'http', url: 'https://mcp.example.com/?key=abc123' } })
    expect(maskMcpEntry(http, true).config).toMatchObject({ url: `https://mcp.example.com/?key=${M}` })
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

describe('health check schemas', () => {
  it('parses requests and results', () => {
    expect(McpHealthRequestSchema.parse({ name: 'x', scope: { kind: 'user' } })).toEqual({ name: 'x', scope: { kind: 'user' } })
    expect(issuePaths(McpHealthRequestSchema, { name: '-s', scope: { kind: 'user' } })).toEqual(['name'])
    const result = { name: 'x', scope: { kind: 'user' }, status: 'ok', latencyMs: 12, serverInfo: { name: 's', version: '1' }, protocolVersion: '2025-06-18' }
    expect(McpHealthResultSchema.parse(result)).toEqual(result)
    expect(API_ROUTES.mcpHealth).toBe('/api/mcp/health')
    expect(API_ROUTES.mcpHealthAll).toBe('/api/mcp/health/all')
    expect(McpHealthAllRequestSchema.parse({})).toEqual({})
  })

  it('rejects unknown statuses and over-long errors', () => {
    const base = { name: 'x', scope: { kind: 'user' } }
    expect(issuePaths(McpHealthResultSchema, { ...base, status: 'bad' })).toEqual(['status'])
    expect(issuePaths(McpHealthResultSchema, { ...base, status: 'error', error: 'e'.repeat(201) })).toEqual(['error'])
  })
})
