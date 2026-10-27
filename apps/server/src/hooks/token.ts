import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HOOK_TOKEN_FILE = 'hook-token'

const TOKEN_PATTERN = /^[\w-]{32,}$/

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

/**
 * Loads `<stateDir>/hook-token` (mode 0600) or creates it once with `wx`, so an existing file is never truncated.
 * The token stays stable across restarts because re-adopted tmux sessions keep their environment.
 */
export async function loadHookToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, HOOK_TOKEN_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await readToken(file)
    if (existing !== undefined && TOKEN_PATTERN.test(existing)) {
      await chmod(file, 0o600)
      return existing
    }
    if (existing !== undefined) {
      // Unusable content: removed, then created exclusively like a missing file.
      await rm(file, { force: true })
    }
    const token = randomBytes(32).toString('base64url')
    try {
      await writeFile(file, `${token}\n`, { flag: 'wx', mode: 0o600 })
      return token
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error
      }
    }
  }
  throw new Error(`Could not create ${file}`)
}
