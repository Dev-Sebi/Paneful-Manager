import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tokenMatches } from './token.js'

/** Pending one-time login code: `<code> <expires at, unix seconds>`, mode 0600; `install.sh --login-url` writes the same format. */
export const LOGIN_CODE_FILE = 'login-code'

/** A login URL is meant to be opened right away; an unused code is worthless after this. */
export const LOGIN_CODE_TTL_SEC = 600

const CODE_PATTERN = /^[\w-]{32,128}$/

interface PendingCode {
  code: string
  expiresAtSec: number
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

function parse(content: string): PendingCode | undefined {
  const [code, expires] = content.trim().split(/\s+/)
  const expiresAtSec = Number(expires)
  return code !== undefined && CODE_PATTERN.test(code) && Number.isInteger(expiresAtSec) ? { code, expiresAtSec } : undefined
}

async function readPending(file: string): Promise<PendingCode | undefined> {
  try {
    return parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

const isValid = (pending: PendingCode | undefined, code: string, nowMs: number): boolean =>
  pending !== undefined && pending.expiresAtSec * 1000 > nowMs && tokenMatches(code, pending.code)

/** Writes a fresh code, replacing any pending one, and returns it. Needs no running server. */
export async function createLoginCode(stateDir: string, nowMs = Date.now()): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const code = randomBytes(32).toString('base64url')
  const temp = join(stateDir, `.${LOGIN_CODE_FILE}.${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, `${code} ${Math.floor(nowMs / 1000) + LOGIN_CODE_TTL_SEC}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temp, join(stateDir, LOGIN_CODE_FILE))
  return code
}

/**
 * True exactly once for the pending, unexpired code. A wrong guess leaves the pending code alone,
 * so other local users cannot void it; the claim by `rename` lets only one concurrent request win.
 */
export async function consumeLoginCode(stateDir: string, code: string, nowMs = Date.now()): Promise<boolean> {
  const file = join(stateDir, LOGIN_CODE_FILE)
  if (!isValid(await readPending(file), code, nowMs)) {
    return false
  }
  const claimed = join(stateDir, `.${LOGIN_CODE_FILE}.${randomBytes(6).toString('hex')}.used`)
  try {
    await rename(file, claimed)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
  try {
    return isValid(await readPending(claimed), code, nowMs)
  } finally {
    await rm(claimed, { force: true })
  }
}
