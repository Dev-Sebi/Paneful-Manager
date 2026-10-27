import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, writeFileAtomic } from './store.js'

const base: Session = {
  id: 'a1',
  hostId: 'local',
  cwd: '/tmp',
  command: 'claude',
  args: [],
  tmuxSession: 'ah-a1',
  createdAt: '2026-10-27T10:00:00.000Z',
  state: 'idle',
  lifecycle: 'running',
  lastEventAt: '2026-10-27T10:00:00.000Z',
  cols: 120,
  rows: 30,
}

let dir: string
let store: SessionStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-store-'))
  store = new SessionStore(join(dir, 'state'))
  await store.init()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('replaces the target and leaves no temp file', async () => {
    const file = join(dir, 'x.json')
    await writeFile(file, 'old')
    await writeFileAtomic(file, 'new')
    expect(await readFile(file, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['state', 'x.json'])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('keeps the old target and removes the temp file when rename fails', async () => {
    const target = join(dir, 'target')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'x')
    await expect(writeFileAtomic(target, 'new')).rejects.toThrow()
    expect(await readdir(target)).toEqual(['keep'])
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('SessionStore', () => {
  it('creates the state dirs with mode 0700', async () => {
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700)
  })

  it('tightens an existing state dir to 0700', async () => {
    await chmod(join(dir, 'state'), 0o755)
    await chmod(store.dir, 0o777)
    await store.init()
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700)
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
  })

  it('saves, loads and removes records', async () => {
    await store.save(base)
    await store.save({ ...base, id: 'b2', tmuxSession: 'ah-b2', lifecycle: 'exited', exitCode: 3 })
    const loaded = await store.loadAll()
    expect(loaded.map(s => s.id).sort()).toEqual(['a1', 'b2'])
    expect(loaded.find(s => s.id === 'b2')?.exitCode).toBe(3)
    await store.remove('a1')
    expect((await store.loadAll()).map(s => s.id)).toEqual(['b2'])
  })

  it('serializes concurrent writes per id so the last one wins', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ ...base, cols: i + 1 })))
    const [loaded] = await store.loadAll()
    expect(loaded?.cols).toBe(20)
    expect(await readdir(store.dir)).toEqual(['a1.json'])
  })

  it('skips invalid, mismatched and temp files', async () => {
    await store.save(base)
    await writeFile(join(store.dir, 'broken.json'), '{')
    await writeFile(join(store.dir, 'b2.json'), JSON.stringify({ ...base, extra: 1 }))
    await writeFile(join(store.dir, 'c3.json'), JSON.stringify(base))
    await writeFile(join(store.dir, '.a1.json.agent-hub-1.tmp'), '{')
    expect((await store.loadAll()).map(s => s.id)).toEqual(['a1'])
  })

  it('prunes records that are not kept', async () => {
    await store.save(base)
    await store.save({ ...base, id: 'b2', tmuxSession: 'ah-b2' })
    expect(await store.prune(new Set(['b2']))).toEqual(['a1'])
    expect((await store.loadAll()).map(s => s.id)).toEqual(['b2'])
  })

  it('rejects ids that would escape the directory', async () => {
    expect(() => store.save({ ...base, id: '../x' })).toThrow()
    await expect(store.loadAll()).resolves.toEqual([])
  })
})
