import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const TOKEN_PATTERN = /^[\w-]{32,}$/
/** Bounded retries for races with other server processes creating or replacing the file. */
const MAX_ATTEMPTS = 10
const RETRY_DELAY_MS = 20

export type LinkFn = (existingPath: string, newPath: string) => Promise<void>

export interface LoadSecretFileOptions {
  /** Hard-link function; injectable for tests of filesystems without hard links. */
  link?: LinkFn
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code

async function readToken(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** Returns the valid token on disk with mode 0600, or undefined when it vanished meanwhile. */
async function validToken(file: string, token: string | undefined): Promise<string | undefined> {
  if (token === undefined || !TOKEN_PATTERN.test(token)) {
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
 * Publishes `token` as `file`: the full content is written to a temp file first, so `file` never exists partially.
 * A missing file is created with `link` (fails atomically with EEXIST); only a corrupt file is replaced by `rename`.
 */
async function publish(dir: string, file: string, token: string, replace: boolean, linkFile: LinkFn): Promise<void> {
  const temp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const content = `${token}\n`
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
    if (replace) {
      await rename(temp, file)
    } else {
      await linkFile(temp, file).catch(async (error: unknown) => {
        // Filesystems without hard links: exclusive create, accepting a short window with a partial file.
        if (errnoCode(error) !== 'EPERM' && errnoCode(error) !== 'ENOTSUP') {
          throw error
        }
        await writeFile(file, content, { flag: 'wx', mode: 0o600 })
      })
    }
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') {
      throw error
    }
  } finally {
    await rm(temp, { force: true })
  }
}

/**
 * Loads `<stateDir>/<fileName>` (mode 0600) or creates it once with 32 random bytes in base64url;
 * concurrent server processes agree on one value. The value stays stable across restarts.
 */
export async function loadSecretFile(stateDir: string, fileName: string, { link: linkFile = link }: LoadSecretFileOptions = {}): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, fileName)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await readToken(file)
    const valid = await validToken(file, existing)
    if (valid !== undefined) {
      return valid
    }
    if (existing === '' && attempt < MAX_ATTEMPTS - 1) {
      // An empty file may come from an older version mid-write; only replace it once it stays empty.
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
      continue
    }
    await publish(stateDir, file, randomBytes(32).toString('base64url'), existing !== undefined, linkFile)
    const published = await validToken(file, await readToken(file))
    if (published !== undefined) {
      return published
    }
  }
  throw new Error(`Could not create a valid ${file}`)
}
