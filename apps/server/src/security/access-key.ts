import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ACCESS_KEY_FRAGMENT_PARAM, resolveStateDir } from '@agent-hub/shared'
import { loadConfig } from '../config/load-config.js'
import { expandHome } from '../paths.js'
import { loadSecretFile } from './secret-file.js'

/** Persisted access key in the state directory; only its owner can read it. */
export const ACCESS_KEY_FILE = 'access-key'

/** Loads `<stateDir>/access-key` (mode 0600) or creates it once; it survives restarts, so a browser logs in only once. */
export function loadAccessKey(stateDir: string): Promise<string> {
  return loadSecretFile(stateDir, ACCESS_KEY_FILE)
}

/** Login URL that hands the key to the browser in the fragment, which is never sent to the server or logged. */
export function loginUrl(port: number, key: string): string {
  return `http://localhost:${port}/#${ACCESS_KEY_FRAGMENT_PARAM}=${key}`
}

/** Port given as `--port <n>`, e.g. the Vite dev server; undefined when absent. */
export function portArgument(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--port')
  if (index === -1) {
    return undefined
  }
  const port = Number(argv[index + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port needs a port between 1 and 65535')
  }
  return port
}

/** Login URL from the access key the server wrote; fails when the server never ran. Reads, never creates the key. */
export async function resolveLoginUrl(env: Record<string, string | undefined>, argv: readonly string[]): Promise<string> {
  const file = join(expandHome(resolveStateDir(env)), ACCESS_KEY_FILE)
  let key: string
  try {
    key = (await readFile(file, 'utf8')).trim()
  } catch {
    throw new Error(`No access key in ${file}; start Agent Hub once, it creates the key`)
  }
  const port = portArgument(argv) ?? (await loadConfig({ env })).port
  return loginUrl(port, key)
}
