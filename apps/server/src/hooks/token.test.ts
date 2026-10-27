import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOOK_TOKEN_FILE, loadHookToken } from './token.js'

let dir: string

const PROCESSES = 8
const ROUNDS = 5
const TOKEN_MODULE = fileURLToPath(new URL('token.ts', import.meta.url))

/** Child script: imports the module, signals readiness, waits for the shared start signal, prints its token. */
function childCode(stateDir: string, barrier: string, index: number): string {
  return [
    `const { loadHookToken } = await import(${JSON.stringify(TOKEN_MODULE)})`,
    `const fs = await import('node:fs')`,
    `fs.writeFileSync(${JSON.stringify(join(barrier, `ready-${index}`))}, '')`,
    `while (!fs.existsSync(${JSON.stringify(join(barrier, 'go'))})) { await new Promise(r => setTimeout(r, 1)) }`,
    `process.stdout.write(await loadHookToken(${JSON.stringify(stateDir)}))`,
  ].join('\n')
}

/** Runs `loadHookToken` in a separate Node process (via the tsx loader) and returns the token it printed. */
function loadInChild(stateDir: string, barrier: string, index: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode(stateDir, barrier, index)], { timeout: 30_000 }, (error, stdout) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout)
      }
    })
  })
}

async function waitForReady(barrier: string): Promise<void> {
  while ((await readdir(barrier)).filter(name => name.startsWith('ready-')).length < PROCESSES) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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

  it('creates exactly one token when called concurrently', async () => {
    const tokens = await Promise.all([1, 2, 3, 4].map(() => loadHookToken(dir)))
    expect(new Set(tokens).size).toBe(1)
    expect((await readFile(join(dir, HOOK_TOKEN_FILE), 'utf8')).trim()).toBe(tokens[0])
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

  it.each(['EPERM', 'ENOTSUP'])('falls back to an exclusive create when link fails with %s', async code => {
    const link = vi.fn(() => Promise.reject(Object.assign(new Error(code), { code })))
    const token = await loadHookToken(dir, { link })
    expect(link).toHaveBeenCalledTimes(1)
    expect((await readFile(join(dir, HOOK_TOKEN_FILE), 'utf8')).trim()).toBe(token)
    expect((await stat(join(dir, HOOK_TOKEN_FILE))).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual([HOOK_TOKEN_FILE])
    expect(await loadHookToken(dir, { link })).toBe(token)
  })

  it('removes the temp file and rethrows other link errors', async () => {
    const link = vi.fn(() => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })))
    await expect(loadHookToken(dir, { link })).rejects.toThrow('EIO')
    expect(await readdir(dir)).toEqual([])
  })

  it('agrees on one token across separate processes starting on a fresh state dir', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const state = join(dir, `state-${round}`)
      const barrier = join(dir, `barrier-${round}`)
      await mkdir(barrier)
      const running = Promise.all(Array.from({ length: PROCESSES }, (_, index) => loadInChild(state, barrier, index)))
      await waitForReady(barrier)
      await writeFile(join(barrier, 'go'), '')
      const tokens = await running
      const onDisk = (await readFile(join(state, HOOK_TOKEN_FILE), 'utf8')).trim()
      expect(onDisk).toMatch(/^[\w-]{43}$/)
      expect(tokens).toEqual(Array.from({ length: PROCESSES }, () => onDisk))
      expect(await readdir(state)).toEqual([HOOK_TOKEN_FILE])
    }
  }, 120_000)
})
