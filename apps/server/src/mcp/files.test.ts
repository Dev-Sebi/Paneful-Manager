import { readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appError } from '../files/test-helpers.js'
import { createMcpFileStore, resolveClaudeJsonPath, type McpFileStore } from './files.js'
import { fromNative, toNative } from './native.js'
import { createMcpSandbox, type McpSandbox } from './test-helpers.js'

let box: McpSandbox
let store: McpFileStore
let claudeJson: string

/** Unrelated keys with fake values around the MCP sections, written the way Claude Code formats the file. */
function fixture(project: string): Record<string, unknown> {
  return {
    numStartups: 42,
    oauthAccount: { accountUuid: '00000000-0000-0000-0000-000000000000', emailAddress: 'user@example.com' },
    mcpServers: {
      existing: { type: 'stdio', command: 'node', args: ['server.js'], env: { API_KEY: 'fake-key' }, timeout: 5000 },
    },
    projects: {
      [project]: { allowedTools: [], hasTrustDialogAccepted: true, nested: { deeper: { list: [1, { a: null }] } } },
      '/other/project': { mcpServers: { theirs: { type: 'http', url: 'https://other.example/mcp' } } },
    },
    zLast: { unknown: true },
  }
}

function keyOrder(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(keyOrder)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, inner]) => [key, keyOrder(inner)])
  }
  return value
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => {
  box = createMcpSandbox()
  store = createMcpFileStore({ env: {}, backupDir: join(box.state, 'backups'), home: box.home })
  claudeJson = join(box.home, '.claude.json')
})

afterEach(() => box.cleanup())

describe('resolveClaudeJsonPath', () => {
  it('uses HOME, or CLAUDE_CONFIG_DIR when set', () => {
    expect(resolveClaudeJsonPath({}, '/home/u')).toBe('/home/u/.claude.json')
    expect(resolveClaudeJsonPath({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/home/u')).toBe('/home/u/cfg/.claude.json')
    expect(resolveClaudeJsonPath({ CLAUDE_CONFIG_DIR: '  ' }, '/home/u')).toBe('/home/u/.claude.json')
  })
})

describe('~/.claude.json round trip', () => {
  it('adds and removes a user server without touching anything else', async () => {
    const original = `${JSON.stringify(fixture(box.project), null, 2)}\n`
    writeFileSync(claudeJson, original, { mode: 0o644 })

    await store.write({ kind: 'user' }, 'added', { type: 'http', url: 'https://a.example/mcp' })
    const expected = fixture(box.project)
    ;(expected.mcpServers as Record<string, unknown>).added = { type: 'http', url: 'https://a.example/mcp' }
    expect(keyOrder(read(claudeJson))).toEqual(keyOrder(expected))
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600)

    await store.write({ kind: 'user' }, 'added', undefined)
    expect(keyOrder(read(claudeJson))).toEqual(keyOrder(fixture(box.project)))
    expect(readFileSync(claudeJson, 'utf8')).toBe(original)
  })

  it('writes local servers into the project section only', async () => {
    writeFileSync(claudeJson, JSON.stringify(fixture(box.project), null, 2))
    const scope = { kind: 'local', projectPath: box.project } as const
    await store.write(scope, 'mine', { type: 'stdio', command: 'npx', args: [], env: {} })

    const after = read(claudeJson) as ReturnType<typeof fixture>
    const expected = fixture(box.project)
    ;(expected.projects as Record<string, Record<string, unknown>>)[box.project]!.mcpServers = {
      mine: { type: 'stdio', command: 'npx', args: [], env: {} },
    }
    expect(keyOrder(after)).toEqual(keyOrder(expected))
    expect((await store.read(scope)).entries.map(entry => entry.name)).toEqual(['mine'])

    await store.write(scope, 'mine', undefined)
    const removed = fixture(box.project)
    ;(removed.projects as Record<string, Record<string, unknown>>)[box.project]!.mcpServers = {}
    expect(keyOrder(read(claudeJson))).toEqual(keyOrder(removed))
  })

  it('keeps tab indentation and backs up the previous content', async () => {
    const original = JSON.stringify({ a: 1, mcpServers: {} }, null, '\t')
    writeFileSync(claudeJson, original)
    await store.write({ kind: 'user' }, 'x', { type: 'sse', url: 'https://a.example/sse' })
    expect(readFileSync(claudeJson, 'utf8')).toContain('\n\t\t"x": {\n\t\t\t"type": "sse"')
    const backupDirs = readdirSync(join(box.state, 'backups'))
    expect(backupDirs).toHaveLength(1)
    const [backup] = readdirSync(join(box.state, 'backups', backupDirs[0]!))
    expect(readFileSync(join(box.state, 'backups', backupDirs[0]!, backup!), 'utf8')).toBe(original)
  })

  it('creates the file with mode 0600 when it does not exist', async () => {
    await store.write({ kind: 'user' }, 'x', { type: 'http', url: 'https://a.example' })
    expect(read(claudeJson)).toEqual({ mcpServers: { x: { type: 'http', url: 'https://a.example' } } })
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600)
  })

  it('refuses invalid JSON and non-object sections without writing', async () => {
    for (const content of ['{ "a": 1, // comment\n}', '[1]', '{"mcpServers": []}']) {
      writeFileSync(claudeJson, content)
      const error = await appError(store.write({ kind: 'user' }, 'x', { type: 'http', url: 'https://a.example' }))
      expect(error.statusCode).toBe(409)
      expect(error.code).toBe('conflict')
      expect(readFileSync(claudeJson, 'utf8')).toBe(content)
    }
    expect(await appError(store.read({ kind: 'user' }))).toMatchObject({ statusCode: 409 })
  })

  it('answers 404 when removing a server that does not exist', async () => {
    writeFileSync(claudeJson, '{}')
    expect(await appError(store.write({ kind: 'user' }, 'nope', undefined))).toMatchObject({ statusCode: 404 })
  })
})

describe('.mcp.json', () => {
  it('preserves unknown top-level keys and key order', async () => {
    const path = join(box.project, '.mcp.json')
    const original = { $schema: 'https://example.com/schema.json', mcpServers: { a: { command: 'x' } }, extra: { keep: [1, 2] } }
    writeFileSync(path, JSON.stringify(original, null, 4))
    const scope = { kind: 'project', projectPath: box.project } as const

    await store.write(scope, 'b', { type: 'http', url: 'https://b.example/mcp', headers: { Authorization: 'Bearer x' } })
    expect(keyOrder(read(path))).toEqual(keyOrder({ ...original, mcpServers: { ...original.mcpServers, b: { type: 'http', url: 'https://b.example/mcp', headers: { Authorization: 'Bearer x' } } } }))
    expect(readFileSync(path, 'utf8')).toContain('\n        "b": {')

    await store.write(scope, 'b', undefined)
    expect(keyOrder(read(path))).toEqual(keyOrder(original))
    expect((await store.read(scope)).entries).toEqual([{ name: 'a', config: { transport: 'stdio', command: 'x', args: [], env: {} } }])
  })

  it('creates a missing .mcp.json and rejects a link to another file', async () => {
    const scope = { kind: 'project', projectPath: box.project } as const
    await store.write(scope, 'a', { type: 'stdio', command: 'x', args: [], env: {} })
    expect(read(join(box.project, '.mcp.json'))).toEqual({ mcpServers: { a: { type: 'stdio', command: 'x', args: [], env: {} } } })

    const worktreeScope = { kind: 'project', projectPath: box.worktree } as const
    writeFileSync(join(box.worktree, 'package.json'), '{}')
    symlinkSync('package.json', join(box.worktree, '.mcp.json'))
    expect(await appError(store.read(worktreeScope))).toMatchObject({ statusCode: 403 })
  })

  it('skips entries with unsupported transports or names but keeps them raw', async () => {
    writeFileSync(join(box.project, '.mcp.json'), JSON.stringify({
      mcpServers: { ws: { type: 'ws', url: 'wss://a.example' }, 'bad name': { command: 'x' }, ok: { type: 'streamable-http', url: 'https://a.example' } },
    }))
    const result = await store.read({ kind: 'project', projectPath: box.project })
    expect(result.entries).toEqual([{ name: 'ok', config: { transport: 'http', url: 'https://a.example', headers: {} } }])
    expect([...result.raw.keys()]).toEqual(['ws', 'bad name', 'ok'])
  })
})

describe('native conversion', () => {
  it('keeps unknown keys and their order within the same transport family', () => {
    const existing = { type: 'http', url: 'https://old.example', oauth: { clientId: 'id' }, headers: { A: '1' }, timeout: 3 }
    expect(Object.entries(toNative({ transport: 'http', url: 'https://new.example', headers: {} }, existing))).toEqual([
      ['type', 'http'],
      ['url', 'https://new.example'],
      ['oauth', { clientId: 'id' }],
      ['timeout', 3],
    ])
    expect(toNative({ transport: 'stdio', command: 'x', args: [], env: {} }, existing)).toEqual({ type: 'stdio', command: 'x', args: [], env: {} })
  })

  it('reads entries without type as stdio and rejects broken ones', () => {
    expect(fromNative({ command: 'x' })).toEqual({ transport: 'stdio', command: 'x', args: [], env: {} })
    expect(fromNative({ url: 'https://a.example' })).toBeUndefined()
    expect(fromNative({ type: 'stdio', command: 'x', env: { A: 1 } })).toBeUndefined()
    expect(fromNative('x')).toBeUndefined()
  })
})
