import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { removeStaleTempFiles } from '../files/temp-cleanup.js'

export const HOOK_TOKEN_FILE = 'hook-token'
/** Held while the token file is created or replaced, so concurrent server starts agree on one token. */
export const HOOK_TOKEN_LOCK_FILE = 'hook-token.lock'
/** A lock older than this, or held by a process that no longer exists, is left over from a crash. */
export const LOCK_STALE_MS = 10_000
/** How long a server start waits for another process holding the lock. */
export const LOCK_TIMEOUT_MS = 15_000
const LOCK_RETRY_MS = 20

const TOKEN_PATTERN = /^[\w-]{32,}$/
/** Temp files of interrupted token writes and broken locks. */
const TEMP_PATTERN = /^(\.hook-token\.[0-9a-f]+\.tmp|hook-token\.lock\.[0-9a-f]+\.stale)$/

export interface HookTokenOptions {
  lockStaleMs?: number
  lockTimeoutMs?: number
  /** Age after which temp files count as left over; tests lower it. */
  tempMaxAgeMs?: number
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function readText(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

const isToken = (value: string | undefined): value is string => value !== undefined && TOKEN_PATTERN.test(value)

/** Writes `content` to a temp file (0600) and renames it over `name`, so readers never see a partial file. */
async function writeAtomic(dir: string, name: string, content: string): Promise<void> {
  const temp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
    await rename(temp, join(dir, name))
  } finally {
    await rm(temp, { force: true })
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errnoCode(error) === 'EPERM'
  }
}

async function lockIsStale(file: string, content: string | undefined, staleMs: number): Promise<boolean> {
  try {
    if (Date.now() - (await stat(file)).mtimeMs > staleMs) {
      return true
    }
  } catch {
    return false
  }
  const pid = Number.parseInt(content?.split(':')[0] ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 && !processAlive(pid)
}

/** Moves a stale lock aside; if a fresh lock was taken meanwhile and moved by mistake, it is linked back. */
async function breakLock(file: string, judged: string | undefined): Promise<void> {
  const grave = `${file}.${randomBytes(6).toString('hex')}.stale`
  try {
    await rename(file, grave)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return
    }
    throw error
  }
  try {
    if ((await readText(grave)) !== judged) {
      await link(grave, file).catch(() => undefined)
    }
  } finally {
    await rm(grave, { force: true })
  }
}

/** Runs `task` while holding `<stateDir>/hook-token.lock` (exclusive create, holder `pid:nonce`). */
export async function withHookTokenLock<T>(stateDir: string, task: () => Promise<T>, { lockStaleMs = LOCK_STALE_MS, lockTimeoutMs = LOCK_TIMEOUT_MS }: HookTokenOptions = {}): Promise<T> {
  const file = join(stateDir, HOOK_TOKEN_LOCK_FILE)
  const holder = `${process.pid}:${randomBytes(6).toString('hex')}`
  const deadline = Date.now() + lockTimeoutMs
  for (;;) {
    try {
      await writeFile(file, `${holder}\n`, { flag: 'wx', mode: 0o600 })
      break
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error
      }
    }
    const content = await readText(file)
    if (await lockIsStale(file, content, lockStaleMs)) {
      await breakLock(file, content)
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${file}; remove it if no Agent Hub server is starting`)
    }
    await sleep(LOCK_RETRY_MS)
  }
  try {
    return await task()
  } finally {
    if ((await readText(file).catch(() => undefined)) === holder) {
      await rm(file, { force: true })
    }
  }
}

/** Returns the valid token in `file` with its mode tightened to 0600, or undefined. */
async function existingToken(file: string): Promise<string | undefined> {
  const token = await readText(file)
  if (!isToken(token)) {
    return undefined
  }
  try {
    await chmod(file, 0o600)
    return token
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Loads `<stateDir>/hook-token` (mode 0600) or creates it with 32 random bytes in base64url.
 * Creating or replacing a missing or corrupt file happens under a lock file, so concurrent server starts agree on
 * one token. Temp files left by interrupted writes (they may hold a token) are removed first.
 */
export async function loadHookToken(stateDir: string, options: HookTokenOptions = {}): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, HOOK_TOKEN_FILE)
  await removeStaleTempFiles(stateDir, TEMP_PATTERN, options.tempMaxAgeMs === undefined ? {} : { maxAgeMs: options.tempMaxAgeMs })
  const fast = await existingToken(file)
  if (fast !== undefined) {
    return fast
  }
  return withHookTokenLock(stateDir, async () => {
    const current = await existingToken(file)
    if (current !== undefined) {
      return current
    }
    const token = randomBytes(32).toString('base64url')
    await writeAtomic(stateDir, HOOK_TOKEN_FILE, `${token}\n`)
    return token
  }, options)
}
