import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOOK_TOKEN_FILE, loadHookToken } from './token.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-hook-token-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadHookToken', () => {
  it('creates the token once with mode 0600 and reuses it', async () => {
    const state = join(dir, 'state')
    const token = await loadHookToken(state)
    expect(token).toMatch(/^[\w-]{43}$/)
    const file = join(state, HOOK_TOKEN_FILE)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(state)).mode & 0o777).toBe(0o700)
    expect(await loadHookToken(state)).toBe(token)
    expect((await readFile(file, 'utf8')).trim()).toBe(token)
  })

  it('tightens the mode of an existing token and replaces an invalid one', async () => {
    const file = join(dir, HOOK_TOKEN_FILE)
    const existing = 'a'.repeat(43)
    await writeFile(file, `${existing}\n`, { mode: 0o644 })
    expect(await loadHookToken(dir)).toBe(existing)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, 'short')
    const replaced = await loadHookToken(dir)
    expect(replaced).not.toBe('short')
    expect((await readFile(file, 'utf8')).trim()).toBe(replaced)
  })
})
