import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChangedMessage, Scope } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSandbox, silentLogger } from './test-helpers.js'
import { createFileWatcher, type FileWatcher } from './watcher.js'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const TIMEOUT_MS = 10_000

let base: string
let watcher: FileWatcher
let messages: FileChangedMessage[]
let broadcasts: FileChangedMessage[]

async function waitFor(predicate: (message: FileChangedMessage) => boolean): Promise<FileChangedMessage> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const found = messages.find(predicate)
    if (found) {
      return found
    }
    if (Date.now() > deadline) {
      throw new Error(`no matching event, got ${JSON.stringify(messages)}`)
    }
    await new Promise(done => setTimeout(done, 25))
  }
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hub-watch-')))
  mkdirSync(join(base, 'claude'))
  mkdirSync(join(base, 'project', 'src'), { recursive: true })
  const scopes: Scope[] = [
    { kind: 'global', path: join(base, 'claude') },
    { kind: 'project', path: join(base, 'project') },
  ]
  messages = []
  broadcasts = []
  watcher = createFileWatcher({ getScopes: async () => scopes, logger: silentLogger, broadcast: message => broadcasts.push(message), debounceMs: 50 })
  watcher.onChange(message => messages.push(message))
  await watcher.start()
})

afterEach(async () => {
  await watcher.close()
  rmSync(base, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('file watcher', () => {
  it('emits add, change and unlink for CLAUDE.md with hashes', { timeout: 30_000 }, async () => {
    const path = join(base, 'project', 'CLAUDE.md')
    writeFileSync(path, 'one')
    expect(await waitFor(message => message.event === 'add')).toEqual({ type: 'file.changed', path, event: 'add', hash: sha('one') })
    writeFileSync(path, 'two')
    expect(await waitFor(message => message.event === 'change')).toMatchObject({ path, hash: sha('two') })
    unlinkSync(path)
    expect(await waitFor(message => message.event === 'unlink')).toEqual({ type: 'file.changed', path, event: 'unlink' })
    expect(broadcasts).toEqual(messages)
  })

  it('picks up skills created later and ignores unmanaged files', { timeout: 30_000 }, async () => {
    writeFileSync(join(base, 'project', 'src', 'index.ts'), 'code')
    writeFileSync(join(base, 'project', 'README.md'), 'readme')
    const skillDir = join(base, 'claude', 'skills', 'new-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), 'skill')
    writeFileSync(join(skillDir, 'image.png'), 'png')
    const message = await waitFor(entry => entry.path.endsWith('SKILL.md'))
    expect(message).toMatchObject({ path: join(skillDir, 'SKILL.md'), event: 'add', hash: sha('skill') })
    await new Promise(done => setTimeout(done, 300))
    expect(messages.map(entry => entry.path)).toEqual([join(skillDir, 'SKILL.md')])
  })

  it('reports atomic writes of the file service as changes', { timeout: 30_000 }, async () => {
    const box = createSandbox({ watchDebounceMs: 50 })
    try {
      const path = join(box.project, 'CLAUDE.md')
      writeFileSync(path, 'before')
      const seen: FileChangedMessage[] = []
      const unsubscribe = await box.service.watch(message => seen.push(message))
      await box.service.write({ path, content: 'after', expectedHash: sha('before') })
      const deadline = Date.now() + TIMEOUT_MS
      while (!seen.some(message => message.hash === sha('after')) && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 25))
      }
      expect(seen.find(message => message.hash === sha('after'))).toMatchObject({ path, event: 'change' })
      unsubscribe()
    } finally {
      await box.cleanup()
    }
  })
})
