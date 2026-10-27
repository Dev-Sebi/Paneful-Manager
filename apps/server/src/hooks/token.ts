import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../sessions/store.js'

export const HOOK_TOKEN_FILE = 'hook-token'

const TOKEN_PATTERN = /^[\w-]{32,}$/

/**
 * Loads `<stateDir>/hook-token` (mode 0600) or creates it once. The token stays stable across restarts
 * because re-adopted tmux sessions keep the environment they were created with.
 */
export async function loadHookToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, HOOK_TOKEN_FILE)
  try {
    const token = (await readFile(file, 'utf8')).trim()
    if (TOKEN_PATTERN.test(token)) {
      await chmod(file, 0o600)
      return token
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  const token = randomBytes(32).toString('base64url')
  await writeFileAtomic(file, `${token}\n`, 0o600)
  return token
}
