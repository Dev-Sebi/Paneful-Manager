import { describe, expect, it } from 'vitest'
import { McpServerSchema } from './mcp.js'
import { issuePaths } from './test-utils.js'

describe('McpServerSchema', () => {
  it('parses a stdio server with default args', () => {
    const server = McpServerSchema.parse({ name: 'files', transport: 'stdio', command: 'npx', scope: 'project' })
    expect(server).toEqual({ name: 'files', transport: 'stdio', command: 'npx', args: [], scope: 'project' })
  })

  it('parses http and sse servers', () => {
    for (const transport of ['http', 'sse'] as const) {
      const server = McpServerSchema.parse({
        name: 'remote',
        transport,
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        scope: 'global',
      })
      expect(server.transport).toBe(transport)
    }
  })

  it('rejects missing transport-specific fields', () => {
    expect(issuePaths(McpServerSchema, { name: 'x', transport: 'stdio', scope: 'global' })).toEqual(['command'])
    expect(issuePaths(McpServerSchema, { name: 'x', transport: 'http', url: 'not a url', scope: 'global' })).toEqual([
      'url',
    ])
    expect(issuePaths(McpServerSchema, { name: 'x', transport: 'ws', scope: 'global' })).toEqual(['transport'])
    expect(issuePaths(McpServerSchema, { name: 'x', transport: 'sse', url: 'https://a.example', scope: 'team' })).toEqual([
      'scope',
    ])
  })

  it('round-trips through JSON', () => {
    const server = McpServerSchema.parse({ name: 'w', transport: 'stdio', command: 'node', env: { A: '1' }, scope: 'worktree' })
    expect(McpServerSchema.parse(JSON.parse(JSON.stringify(server)))).toEqual(server)
  })
})
