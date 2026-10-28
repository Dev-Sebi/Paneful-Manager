import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackupStore, encodeBackupPath } from './backups.js'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'paneful-manager-backups-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('backup store', () => {
  it('encodes paths into one directory name, hashing very long ones', () => {
    expect(encodeBackupPath('/home/user/CLAUDE.md')).toBe('%2Fhome%2Fuser%2FCLAUDE.md')
    const long = encodeBackupPath(`/${'deep/'.repeat(80)}SKILL.md`)
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long).toMatch(/^[0-9a-f]{16}-/)
    expect(encodeBackupPath(`/${'deep/'.repeat(81)}SKILL.md`)).not.toBe(long)
  })

  it('keeps timestamped copies with unique names and mode 0600', async () => {
    const store = createBackupStore({ dir })
    const first = await store.save('/p/CLAUDE.md', Buffer.from('a'))
    const second = await store.save('/p/CLAUDE.md', Buffer.from('b'))
    expect(first).not.toBe(second)
    expect(readFileSync(first, 'utf8')).toBe('a')
    expect(statSync(second).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('prunes per file down to the limit, oldest first', async () => {
    const store = createBackupStore({ dir, perFile: 20 })
    for (let index = 0; index < 21; index++) {
      await store.save('/p/CLAUDE.md', Buffer.from(`v${index}`))
    }
    const fileDir = join(dir, encodeBackupPath('/p/CLAUDE.md'))
    const names = readdirSync(fileDir).toSorted()
    expect(names).toHaveLength(20)
    expect(readFileSync(join(fileDir, names[0] ?? ''), 'utf8')).toBe('v1')
  })

  it('prunes the oldest backups across files when the total cap is exceeded', async () => {
    const store = createBackupStore({ dir, totalBytes: 250 })
    await store.save('/p/a.md', Buffer.alloc(100, 'a'))
    await store.save('/p/b.md', Buffer.alloc(100, 'b'))
    await store.save('/p/c.md', Buffer.alloc(100, 'c'))
    const remaining = ['/p/a.md', '/p/b.md', '/p/c.md'].map(path => readdirSync(join(dir, encodeBackupPath(path))).length)
    expect(remaining).toEqual([0, 1, 1])
  })

  it('never prunes the backup it just wrote', async () => {
    const store = createBackupStore({ dir, totalBytes: 10 })
    const backup = await store.save('/p/big.md', Buffer.alloc(100, 'x'))
    expect(readFileSync(backup, 'utf8')).toHaveLength(100)
  })
})
