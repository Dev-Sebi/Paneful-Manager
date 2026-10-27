// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMcpEntry } from '@/test/fixtures'
import { entryKey, useMcpStore } from './mcp'
import { useScopesStore } from './scopes'

const mcpApi = vi.hoisted(() => ({ list: vi.fn(), upsert: vi.fn(), remove: vi.fn() }))
vi.mock('@/api/client', () => ({ api: { mcp: mcpApi } }))

const PROJECT = '/work/app'

describe('mcp store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const fn of Object.values(mcpApi)) {
      fn.mockReset()
    }
  })

  it('groups entries by user, project and local scope', async () => {
    mcpApi.list.mockResolvedValue({
      mode: 'cli',
      cliVersion: '2.1.0',
      servers: [
        makeMcpEntry('a'),
        makeMcpEntry('b', { scope: { kind: 'project', projectPath: PROJECT } }),
        makeMcpEntry('c', { scope: { kind: 'local', projectPath: PROJECT } }),
        makeMcpEntry('d', { scope: { kind: 'local', projectPath: '/other' } }),
      ],
    })
    const scopes = useScopesStore()
    scopes.scopes = [
      { kind: 'global', path: '~/.claude' },
      { kind: 'project', path: PROJECT },
      { kind: 'worktree', path: '/work/app-wt', branch: 'feature/x', projectPath: PROJECT },
    ]
    const store = useMcpStore()
    await store.reload()

    expect(store.mode).toBe('cli')
    expect(store.groups.map(group => group.key)).toEqual(['user', `project:${PROJECT}`, 'worktree:/work/app-wt', 'project:/other'])
    expect(store.groups[0]?.sections[0]?.servers.map(server => server.name)).toEqual(['a'])
    const [project, local] = store.groups[1]?.sections ?? []
    expect(project?.servers.map(server => server.name)).toEqual(['b'])
    expect(local?.servers.map(server => server.name)).toEqual(['c'])
    expect(store.groups[2]?.branch).toBe('feature/x')
    expect(store.groups[3]?.sections[1]?.servers.map(server => server.name)).toEqual(['d'])
  })

  it('lists the user group even without servers or scopes', () => {
    const store = useMcpStore()
    expect(store.groups).toHaveLength(1)
    expect(store.groups[0]?.sections[0]?.servers).toEqual([])
  })

  it('records the error when loading fails', async () => {
    mcpApi.list.mockRejectedValue(new Error('down'))
    const store = useMcpStore()
    await store.reload()
    expect(store.error).toBe('down')
    expect(store.loading).toBe(false)
  })

  it('upserts through the API and reloads', async () => {
    mcpApi.list.mockResolvedValue({ mode: 'file', servers: [makeMcpEntry('a')] })
    mcpApi.upsert.mockResolvedValue({ server: makeMcpEntry('a'), created: true })
    const store = useMcpStore()
    const request = { name: 'a', scope: { kind: 'user' as const }, config: { transport: 'stdio' as const, command: 'x' } }
    await store.upsert(request)
    expect(mcpApi.upsert).toHaveBeenCalledWith(request)
    expect(store.entries).toHaveLength(1)
  })

  it('does not reload when the upsert is rejected', async () => {
    mcpApi.upsert.mockRejectedValue(new Error('conflict'))
    const store = useMcpStore()
    await expect(store.upsert({ name: 'a', scope: { kind: 'user' }, config: { transport: 'stdio', command: 'x' } })).rejects.toThrow('conflict')
    expect(mcpApi.list).not.toHaveBeenCalled()
  })

  it('removes through the API and reloads', async () => {
    mcpApi.list.mockResolvedValue({ mode: 'cli', servers: [] })
    mcpApi.remove.mockResolvedValue({ name: 'a', scope: { kind: 'user' }, removed: true })
    const store = useMcpStore()
    store.entries = [makeMcpEntry('a')]
    await store.remove({ name: 'a', scope: { kind: 'user' } })
    expect(mcpApi.remove).toHaveBeenCalledWith({ name: 'a', scope: { kind: 'user' } })
    expect(store.entries).toEqual([])
  })

  it('builds distinct entry keys per scope', () => {
    expect(entryKey(makeMcpEntry('a'))).not.toBe(entryKey(makeMcpEntry('a', { scope: { kind: 'local', projectPath: PROJECT } })))
  })
})
