import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { removeStaleTempFiles } from '../files/temp-cleanup.js'

export const HOOK_TOKEN_FILE = 'hook-token'
/** Server version that wrote the token; a different or missing one renews it (older builds exposed it in argv). */
export const HOOK_TOKEN_VERSION_FILE = 'hook-token.version'
/** Held while the token file is created or replaced, so concurrent server starts agree on one token. */
export const HOOK_TOKEN_LOCK_FILE = 'hook-token.lock'
/** A lock its holder has not refreshed for this long, or one held by a process that no longer exists, is left over from a crash. */
export const LOCK_STALE_MS = 10_000
/** How long a server start waits for another process holding the lock. */
export const LOCK_TIMEOUT_MS = 15_000
const LOCK_RETRY_MS = 20

const TOKEN_PATTERN = /^[\w-]{32,}$/
/** Temp files of interrupted token writes and broken locks. */
const TEMP_PATTERN = /^(\.hook-token(\.version)?\.[0-9a-f]+\.tmp|hook-token\.lock(\.break)?\.[0-9a-f]+\.stale)$/

export interface HookTokenOptions {
  /** Installed server version; when given, a token written by another version (or none recorded) is renewed. */
  version?: string
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

/** Holder `pid:nonce` whose process is gone, or a lock its holder stopped refreshing for `staleMs`. */
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

/**
 * Removes `file` only while it still holds `expected`: it is renamed to a unique name first, and put back when the
 * renamed file turns out to belong to someone else.
 */
async function removeIfHeldBy(file: string, expected: string | undefined): Promise<void> {
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
    if ((await readText(grave)) !== expected) {
      await link(grave, file).catch(() => undefined)
    }
  } finally {
    await rm(grave, { force: true })
  }
}

/**
 * Breaks a stale lock under `<lock>.break`, so only one starter judges and removes it at a time; a break lock older
 * than `staleMs` is left over from a crash and removed.
 */
async function breakLock(file: string, judged: string | undefined, staleMs: number): Promise<boolean> {
  const breaker = `${file}.break`
  const ticket = `${process.pid}:${randomBytes(6).toString('hex')}`
  try {
    await writeFile(breaker, `${ticket}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') {
      throw error
    }
    const other = await readText(breaker)
    const age = await stat(breaker).then(info => Date.now() - info.mtimeMs, () => 0)
    if (age > staleMs) {
      await removeIfHeldBy(breaker, other)
    }
    return false
  }
  try {
    const content = await readText(file)
    if (content === judged && await lockIsStale(file, content, staleMs)) {
      await removeIfHeldBy(file, judged)
    }
    return true
  } finally {
    await removeIfHeldBy(breaker, ticket)
  }
}

/** Touches the lock while its holder runs, so a live holder never looks stale to other starters. */
function keepLockFresh(file: string, holder: string, staleMs: number): () => void {
  const timer = setInterval(() => {
    void readText(file)
      .then(async content => {
        if (content === holder) {
          const now = new Date()
          await utimes(file, now, now)
        }
      })
      .catch(() => undefined)
  }, Math.max(1, Math.floor(staleMs / 3)))
  timer.unref()
  return () => clearInterval(timer)
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
      if (!(await breakLock(file, content, lockStaleMs))) {
        await sleep(LOCK_RETRY_MS)
      }
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${file}; remove it if no Paneful Manager server is starting`)
    }
    await sleep(LOCK_RETRY_MS)
  }
  const stopRefresh = keepLockFresh(file, holder, lockStaleMs)
  try {
    return await task()
  } finally {
    stopRefresh()
    if ((await readText(file).catch(() => undefined)) === holder) {
      await removeIfHeldBy(file, holder)
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

export interface LoadedHookToken {
  token: string
  /** A new token was written: the file was missing or corrupt, or it came from another version. */
  renewed: boolean
}

async function versionMatches(stateDir: string, version: string | undefined): Promise<boolean> {
  return version === undefined || (await readText(join(stateDir, HOOK_TOKEN_VERSION_FILE))) === version
}

/** Writes a fresh token, then the version; a crash in between only renews the token once more on the next start. */
async function writeNewToken(stateDir: string, version: string | undefined): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await writeAtomic(stateDir, HOOK_TOKEN_FILE, `${token}\n`)
  if (version !== undefined) {
    await writeAtomic(stateDir, HOOK_TOKEN_VERSION_FILE, `${version}\n`)
  }
  return token
}

function cleanupOptions(options: HookTokenOptions): { maxAgeMs?: number } {
  return options.tempMaxAgeMs === undefined ? {} : { maxAgeMs: options.tempMaxAgeMs }
}

/**
 * Loads `<stateDir>/hook-token` (mode 0600) or writes a new one with 32 random bytes in base64url.
 * A missing or corrupt file, or one written by another `version`, is replaced under a lock file, so concurrent server
 * starts agree on one token. Temp files left by interrupted writes (they may hold a token) are removed first.
 */
export async function loadHookToken(stateDir: string, options: HookTokenOptions = {}): Promise<LoadedHookToken> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, HOOK_TOKEN_FILE)
  await removeStaleTempFiles(stateDir, TEMP_PATTERN, cleanupOptions(options))
  const fast = await existingToken(file)
  if (fast !== undefined && await versionMatches(stateDir, options.version)) {
    return { token: fast, renewed: false }
  }
  return withHookTokenLock(stateDir, async () => {
    const current = await existingToken(file)
    if (current !== undefined && await versionMatches(stateDir, options.version)) {
      return { token: current, renewed: false }
    }
    return { token: await writeNewToken(stateDir, options.version), renewed: true }
  }, options)
}

/** Replaces the token unconditionally (explicit hook install or uninstall); sessions holding the old one get 401. */
export async function rotateHookToken(stateDir: string, options: HookTokenOptions = {}): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  return withHookTokenLock(stateDir, () => writeNewToken(stateDir, options.version), options)
}
