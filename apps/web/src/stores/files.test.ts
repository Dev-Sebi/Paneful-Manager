import type { WsEvents } from '@/api/ws'
// @vitest-environment jsdom
import type { ServerMessage } from '@agent-hub/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HASH_A, HASH_B, HASH_C, makeClaudeMdEntry, makeSkillEntry, withContent } from '@/test/fixtures'
import { useFilesStore } from './files'

const api = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock('@/api/client', () => {
  class ApiClientError extends Error {
    status: number
    code: string
    details: unknown
    constructor (status: number, code: string, message: string, details?: unknown) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  return { api, ApiClientError }
})

const { ApiClientError } = await import('@/api/client')

const entry = makeSkillEntry('demo')
const file = withContent(entry, 'hello')

function fakeEvents () {
  let handler: ((message: never) => void) | undefined
  const events: WsEvents = {
    on: (_type, next) => {
      handler = next as (message: never) => void
      return () => {
        handler = undefined
      }
    },
  }
  return { events, emit: (message: ServerMessage) => handler?.(message as never) }
}

async function openFile () {
  api.readFile.mockResolvedValue({ file })
  const store = useFilesStore()
  await store.open(entry.path)
  return store
}

describe('files store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    api.listFiles.mockResolvedValue({ files: [entry] })
  })

  it('lists entries and groups them by scope', async () => {
    const store = useFilesStore()
    await store.load()
    expect(store.entries).toEqual([entry])
    expect(store.filesOf(entry.scope.path, 'skill')).toEqual([entry])
    expect(store.filesOf(entry.scope.path, 'claude-md')).toEqual([])
  })

  it('records a list error', async () => {
    api.listFiles.mockRejectedValue(new Error('down'))
    const store = useFilesStore()
    await store.load()
    expect(store.error).toBe('down')
  })

  it('opens a file and tracks the dirty state', async () => {
    const store = await openFile()
    expect(store.buffer).toBe('hello')
    expect(store.dirty).toBe(false)
    store.setBuffer('hello world')
    expect(store.dirty).toBe(true)
    store.setBuffer('hello')
    expect(store.dirty).toBe(false)
  })

  it('saves with the loaded hash and adopts the new hash', async () => {
    const store = await openFile()
    store.setBuffer('changed')
    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    expect(await store.save()).toBe(true)
    expect(api.writeFile).toHaveBeenCalledWith({ path: entry.path, content: 'changed', expectedHash: HASH_A })
    expect(store.current?.hash).toBe(HASH_B)
    expect(store.dirty).toBe(false)
  })

  it('exposes a 409 as conflict and keeps the buffer', async () => {
    const store = await openFile()
    store.setBuffer('mine')
    api.writeFile.mockRejectedValue(new ApiClientError(409, 'conflict', 'changed', { currentHash: HASH_C }))
    expect(await store.save()).toBe(false)
    expect(store.conflict).toEqual({ currentHash: HASH_C })
    expect(store.buffer).toBe('mine')
    expect(store.dirty).toBe(true)
  })

  it('overwrites with the hash from the conflict', async () => {
    const store = await openFile()
    store.setBuffer('mine')
    api.writeFile.mockRejectedValueOnce(new ApiClientError(409, 'conflict', 'changed', { currentHash: HASH_C }))
    await store.save()
    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    expect(await store.overwrite()).toBe(true)
    expect(api.writeFile).toHaveBeenLastCalledWith({ path: entry.path, content: 'mine', expectedHash: HASH_C })
    expect(store.conflict).toBeUndefined()
  })

  it('overwrites a missing file without an expected hash', async () => {
    const store = await openFile()
    store.setBuffer('mine')
    api.writeFile.mockRejectedValueOnce(new ApiClientError(409, 'conflict', 'gone', { currentHash: null }))
    await store.save()
    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    await store.overwrite()
    expect(api.writeFile).toHaveBeenLastCalledWith({ path: entry.path, content: 'mine', expectedHash: undefined })
  })

  it('reloads from disk and discards the buffer', async () => {
    const store = await openFile()
    store.setBuffer('mine')
    api.readFile.mockResolvedValue({ file: { ...file, content: 'disk', hash: HASH_B } })
    await store.reload()
    expect(store.buffer).toBe('disk')
    expect(store.current?.hash).toBe(HASH_B)
  })

  it('marks the open file as changed on disk without touching the buffer', async () => {
    const store = await openFile()
    store.setBuffer('mine')
    const { events, emit } = fakeEvents()
    store.bind(events)
    emit({ type: 'file.changed', path: entry.path, event: 'change', hash: HASH_B })
    expect(store.diskChange).toEqual({ removed: false, hash: HASH_B })
    expect(store.buffer).toBe('mine')
    expect(api.listFiles).toHaveBeenCalled()
  })

  it('ignores the echo of its own save and other files', async () => {
    const store = await openFile()
    const { events, emit } = fakeEvents()
    store.bind(events)
    emit({ type: 'file.changed', path: entry.path, event: 'change', hash: HASH_A })
    emit({ type: 'file.changed', path: '~/other.md', event: 'change', hash: HASH_B })
    expect(store.diskChange).toBeUndefined()
  })

  it('flags a file removed on disk', async () => {
    const store = await openFile()
    const { events, emit } = fakeEvents()
    store.bind(events)
    emit({ type: 'file.changed', path: entry.path, event: 'unlink' })
    expect(store.diskChange).toEqual({ removed: true })
  })

  it('creates a file, opens it and writes the starter content', async () => {
    const created = withContent(makeClaudeMdEntry(), '')
    api.createFile.mockResolvedValue({ file: created })
    api.writeFile.mockResolvedValue({ file: { ...created, hash: HASH_B } })
    const store = useFilesStore()
    await store.create({ scopePath: created.scope.path, kind: 'claude-md', template: 'empty' }, '<!-- hi -->\n')
    expect(api.writeFile).toHaveBeenCalledWith({ path: created.path, content: '<!-- hi -->\n', expectedHash: HASH_A })
    expect(store.current?.content).toBe('<!-- hi -->\n')
    expect(store.dirty).toBe(false)
  })

  it('deletes the open file and closes the editor', async () => {
    const store = await openFile()
    api.deleteFile.mockResolvedValue({ path: entry.path, deleted: true })
    expect(await store.remove(entry.path)).toBe(true)
    expect(store.current).toBeUndefined()
  })

  it('closes the editor when its skill folder is deleted', async () => {
    const store = await openFile()
    api.deleteFile.mockResolvedValue({ deleted: true })
    await store.remove(entry.path.replace('/SKILL.md', ''))
    expect(store.current).toBeUndefined()
  })

  it('reports a blocked skill folder delete', async () => {
    const store = await openFile()
    api.deleteFile.mockRejectedValue(new ApiClientError(409, 'conflict', 'blocked', { blocked: ['notes.bin'] }))
    expect(await store.remove(entry.path)).toBe(false)
    expect(store.error).toContain('notes.bin')
    expect(store.current).toBeDefined()
  })
})
