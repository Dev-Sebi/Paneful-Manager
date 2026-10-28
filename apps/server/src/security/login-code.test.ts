import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consumeLoginCode, createLoginCode, LOGIN_CODE_FILE, LOGIN_CODE_TTL_SEC } from './login-code.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-login-code-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('login code', () => {
  it('is written owner-only with its expiry and replaces a pending one', async () => {
    const now = 1_700_000_000_000
    const first = await createLoginCode(dir, now)
    const second = await createLoginCode(dir, now)
    expect(second).not.toBe(first)
    expect(second).toMatch(/^[\w-]{43}$/)
    const file = join(dir, LOGIN_CODE_FILE)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toBe(`${second} ${now / 1000 + LOGIN_CODE_TTL_SEC}\n`)
    expect(await consumeLoginCode(dir, first, now)).toBe(false)
  })

  it('works exactly once', async () => {
    const code = await createLoginCode(dir)
    expect(await consumeLoginCode(dir, code)).toBe(true)
    expect(await consumeLoginCode(dir, code)).toBe(false)
  })

  it('keeps the pending code when someone guesses wrong', async () => {
    const code = await createLoginCode(dir)
    for (const guess of ['x'.repeat(43), `${code}x`, code.slice(1), '']) {
      expect(await consumeLoginCode(dir, guess)).toBe(false)
    }
    expect(await consumeLoginCode(dir, code)).toBe(true)
  })

  it('expires', async () => {
    const now = Date.now()
    const code = await createLoginCode(dir, now)
    expect(await consumeLoginCode(dir, code, now + LOGIN_CODE_TTL_SEC * 1000)).toBe(false)
  })

  it('lets only one of several concurrent logins win', async () => {
    const code = await createLoginCode(dir)
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeLoginCode(dir, code)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('accepts the hex code install.sh writes and rejects malformed files', async () => {
    const hex = 'ab'.repeat(32)
    const expires = Math.floor(Date.now() / 1000) + 60
    await writeFile(join(dir, LOGIN_CODE_FILE), `${hex} ${expires}\n`, { mode: 0o600 })
    expect(await consumeLoginCode(dir, hex)).toBe(true)
    for (const content of ['', `${hex}\n`, `${hex} soon\n`, `short ${expires}\n`]) {
      await writeFile(join(dir, LOGIN_CODE_FILE), content, { mode: 0o600 })
      expect(await consumeLoginCode(dir, hex), content).toBe(false)
    }
  })

  it('fails without a pending code', async () => {
    expect(await consumeLoginCode(dir, 'a'.repeat(43))).toBe(false)
  })
})
