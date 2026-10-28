import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appError, createSandbox, type Sandbox } from './test-helpers.js'

const failRename = vi.hoisted(() => ({ active: false }))
const onTempOpen = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).includes('.paneful-manager-')) {
        onTempOpen.hook?.()
      }
      return actual.open(...args)
    },
    rename: async (from: string, to: string) => {
      if (failRename.active) {
        throw Object.assign(new Error('simulated crash before rename'), { code: 'EIO' })
      }
      return actual.rename(from, to)
    },
  }
})

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

let box: Sandbox

beforeEach(() => {
  box = createSandbox()
})

afterEach(async () => {
  failRename.active = false
  onTempOpen.hook = undefined
  await box.cleanup()
})

describe('atomic write', () => {
  it('leaves the old file and no temp file when the write fails after the temp file was written', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'old content')
    failRename.active = true
    await expect(box.service.write({ path, content: 'new content', expectedHash: sha('old content') })).rejects.toThrow('simulated crash')
    expect(readFileSync(path, 'utf8')).toBe('old content')
    expect(readdirSync(box.project)).toEqual(['CLAUDE.md'])
  })

  it('creates no partial file when a new file fails', async () => {
    const path = join(box.project, 'CLAUDE.local.md')
    failRename.active = true
    await expect(box.service.write({ path, content: 'x' })).rejects.toThrow('simulated crash')
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(box.project)).toEqual([])
  })

  it('maps a conflict found right before the rename to 409 without touching the target', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'old')
    onTempOpen.hook = () => writeFileSync(path, 'theirs')
    const error = await appError(box.service.write({ path, content: 'mine', expectedHash: sha('old') }))
    expect(error.details).toEqual({ currentHash: sha('theirs') })
    expect(error.statusCode).toBe(409)
    expect(readFileSync(path, 'utf8')).toBe('theirs')
    expect(readdirSync(box.project)).toEqual(['CLAUDE.md'])
  })
})
