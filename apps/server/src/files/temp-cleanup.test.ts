import { mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeStaleTempFiles } from './temp-cleanup.js'

const PATTERN = /^\.x\.[0-9a-f]+\.tmp$/

describe('removeStaleTempFiles', () => {
  let dir: string
  let outside: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'paneful-manager-temp-'))
    outside = await mkdtemp(join(tmpdir(), 'paneful-manager-temp-outside-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('removes only old regular files matching the pattern and never judges a link by its target', async () => {
    const old = new Date(Date.now() - 120_000)
    await writeFile(join(dir, '.x.aa.tmp'), 'old')
    await utimes(join(dir, '.x.aa.tmp'), old, old)
    await writeFile(join(dir, '.x.bb.tmp'), 'fresh')
    await writeFile(join(dir, 'other.tmp'), 'other')
    await utimes(join(dir, 'other.tmp'), old, old)
    const target = join(outside, 'target')
    await writeFile(target, 'kept')
    await utimes(target, old, old)
    await symlink(target, join(dir, '.x.cc.tmp'))

    expect(await removeStaleTempFiles(dir, PATTERN)).toEqual(['.x.aa.tmp'])
    expect((await readdir(dir)).sort()).toEqual(['.x.bb.tmp', '.x.cc.tmp', 'other.tmp'])
    expect(await readdir(outside)).toEqual(['target'])
  })

  it('removes nothing when the directory is missing', async () => {
    expect(await removeStaleTempFiles(join(dir, 'missing'), PATTERN)).toEqual([])
  })
})
