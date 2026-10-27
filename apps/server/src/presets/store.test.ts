import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspacePresetSchema, type WorkspacePreset } from '@agent-hub/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { createBackupStore } from '../files/backups.js'
import { createPresetStore, type PresetStore } from './store.js'

let root: string
let dir: string
let store: PresetStore

function preset(name: string, extra: Record<string, unknown> = {}): WorkspacePreset {
  return WorkspacePresetSchema.parse({ name, tabs: [{ title: 't', layout: 'row', panes: [{ cwd: '/work/app' }, { cwd: '/work/app', args: ['--x'] }] }], ...extra })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ah-presets-'))
  dir = join(root, 'workspaces')
  store = createPresetStore({ dir, logger: pino({ level: 'silent' }), backups: createBackupStore({ dir: join(root, 'backups') }) })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('preset store', () => {
  it('lists nothing before the directory exists', async () => {
    expect(await store.list()).toEqual([])
  })

  it('creates, reads, lists, updates and deletes a preset', async () => {
    await store.create(preset('alpha'))
    await store.create(preset('beta', { autostart: true }))
    expect((await store.list()).map(item => item.name)).toEqual(['alpha', 'beta'])
    expect((await store.get('beta')).autostart).toBe(true)

    await store.update('alpha', preset('alpha', { description: 'changed' }))
    expect((await store.get('alpha')).description).toBe('changed')

    await store.remove('alpha')
    await expect(store.get('alpha')).rejects.toMatchObject({ statusCode: 404 })
    expect(await readdir(dir)).toEqual(['beta.yaml'])
  })

  it('writes compact YAML without leftover temp files', async () => {
    await store.create(preset('alpha'))
    const text = await readFile(join(dir, 'alpha.yaml'), 'utf8')
    expect(parse(text)).toMatchObject({ name: 'alpha', tabs: [{ layout: 'row', panes: [{ cwd: '/work/app' }, { args: ['--x'] }] }] })
    expect(text).not.toContain('args: []')
    expect((await stat(join(dir, 'alpha.yaml'))).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the custom layout object form', async () => {
    const custom = WorkspacePresetSchema.parse({
      name: 'c',
      tabs: [{ layout: { kind: 'custom', root: { type: 'split', direction: 'row', children: [{ type: 'pane', pane: 0 }, { type: 'pane', pane: 1 }] } }, panes: [{ cwd: '/a' }, { cwd: '/b' }] }],
    })
    await store.create(custom)
    expect((await store.get('c')).tabs[0]?.layout).toEqual(custom.tabs[0]?.layout)
  })

  it('preserves unknown keys and top-level comments on update', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'alpha.yaml'), '# mine\nname: alpha\nnote: keep\ntabs:\n  - panes:\n      - cwd: /a\n')
    const current = await store.get('alpha')
    expect(current).toMatchObject({ note: 'keep' })
    await store.update('alpha', { ...current, description: 'd' })
    const text = await readFile(join(dir, 'alpha.yaml'), 'utf8')
    expect(text).toContain('# mine')
    expect(parse(text)).toMatchObject({ note: 'keep', description: 'd' })
  })

  it('removes keys that are absent from the replacement', async () => {
    await store.create(preset('alpha', { description: 'old', extra: 1 }))
    await store.update('alpha', preset('alpha'))
    const raw = parse(await readFile(join(dir, 'alpha.yaml'), 'utf8')) as Record<string, unknown>
    expect(raw).not.toHaveProperty('description')
    expect(raw).not.toHaveProperty('extra')
  })

  it('answers 409 when creating an existing name and 404 for missing ones', async () => {
    await store.create(preset('alpha'))
    await expect(store.create(preset('alpha'))).rejects.toMatchObject({ statusCode: 409 })
    await expect(store.update('nope', preset('nope'))).rejects.toMatchObject({ statusCode: 404 })
    await expect(store.remove('nope')).rejects.toMatchObject({ statusCode: 404 })
    await expect(store.get('nope')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses to rename through an update', async () => {
    await store.create(preset('alpha'))
    await expect(store.update('alpha', preset('beta'))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects names that could traverse the directory', async () => {
    for (const name of ['../evil', 'a/b', '..', '.hidden', 'a.b', '']) {
      await expect(store.get(name)).rejects.toThrow()
      await expect(store.remove(name)).rejects.toThrow()
    }
    expect(await readdir(root)).not.toContain('evil.yaml')
  })

  it('rejects a symlinked preset pointing outside the directory', async () => {
    await mkdir(dir, { recursive: true })
    const outside = join(root, 'outside.yaml')
    await writeFile(outside, 'name: alpha\ntabs:\n  - panes:\n      - cwd: /a\n')
    await symlink(outside, join(dir, 'alpha.yaml'))
    await expect(store.get('alpha')).rejects.toMatchObject({ statusCode: 400 })
    await expect(store.update('alpha', preset('alpha'))).rejects.toMatchObject({ statusCode: 400 })
    await expect(store.remove('alpha')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('reads through a symlink that stays inside the directory', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'real.yaml'), 'name: alpha\ntabs:\n  - panes:\n      - cwd: /a\n')
    await symlink(join(dir, 'real.yaml'), join(dir, 'alpha.yaml'))
    expect((await store.get('alpha')).name).toBe('alpha')
    expect((await lstat(join(dir, 'alpha.yaml'))).isSymbolicLink()).toBe(true)
  })

  it('refuses create and update through a link to another preset and removes only the link', async () => {
    await store.create(preset('beta'))
    await symlink(join(dir, 'beta.yaml'), join(dir, 'alpha.yaml'))
    await expect(store.create(preset('alpha'))).rejects.toMatchObject({ statusCode: 409 })
    await expect(store.update('alpha', preset('alpha'))).rejects.toMatchObject({ statusCode: 409 })
    await store.remove('alpha')
    expect(await readdir(dir)).toEqual(['beta.yaml'])
  })

  it('rejects names that are too long', async () => {
    await expect(store.get('a'.repeat(65))).rejects.toThrow()
  })

  it('skips invalid and mismatched files when listing but reports them on get', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.yaml'), 'name: [oops')
    await writeFile(join(dir, 'empty.yaml'), 'name: empty\ntabs: []\n')
    await writeFile(join(dir, 'wrong.yaml'), 'name: other\ntabs:\n  - panes:\n      - cwd: /a\n')
    await writeFile(join(dir, 'notes.txt'), 'x')
    await store.create(preset('good'))
    expect((await store.list()).map(item => item.name)).toEqual(['good'])
    for (const name of ['broken', 'empty', 'wrong']) {
      await expect(store.get(name)).rejects.toMatchObject({ statusCode: 409 })
    }
  })

  it('backs up the previous content before an update and a delete', async () => {
    await store.create(preset('alpha'))
    await store.update('alpha', preset('alpha', { description: 'v2' }))
    await store.remove('alpha')
    const folders = await readdir(join(root, 'backups'))
    expect(folders).toHaveLength(1)
    expect(await readdir(join(root, 'backups', folders[0] ?? ''))).toHaveLength(2)
  })

  it('serializes concurrent creates so only one wins', async () => {
    const results = await Promise.allSettled([store.create(preset('alpha')), store.create(preset('alpha'))])
    expect(results.map(result => result.status).toSorted()).toEqual(['fulfilled', 'rejected'])
  })

  it('leaves the old file intact when the atomic write fails', async () => {
    await store.create(preset('alpha'))
    const before = await readFile(join(dir, 'alpha.yaml'), 'utf8')
    const failing = createPresetStore({ dir, backups: { save: vi.fn().mockRejectedValue(new Error('disk full')) } })
    await expect(failing.update('alpha', preset('alpha', { description: 'x' }))).rejects.toThrow('disk full')
    expect(await readFile(join(dir, 'alpha.yaml'), 'utf8')).toBe(before)
  })
})
