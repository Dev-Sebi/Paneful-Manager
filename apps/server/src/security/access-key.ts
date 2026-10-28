import { BIND_HOST, LOGIN_FRAGMENT_PARAM, resolveStateDir } from '@agent-hub/shared'
import { loadConfig } from '../config/load-config.js'
import { expandHome } from '../paths.js'
import { resetDevices } from './device-auth.js'
import { createLoginCode } from './login-code.js'
import { loadSecretFile } from './secret-file.js'

/** Persisted access key in the state directory for scripts; only its owner can read it, and no browser ever gets it. */
export const ACCESS_KEY_FILE = 'access-key'

/** Loads `<stateDir>/access-key` (mode 0600) or creates it once; it survives restarts. */
export function loadAccessKey(stateDir: string): Promise<string> {
  return loadSecretFile(stateDir, ACCESS_KEY_FILE)
}

/**
 * Login URL that hands a one-time code to the browser in the fragment, which is never sent to the server or logged.
 * Uses the bound address: `localhost` may resolve to `::1`, where another local user can listen on the same port.
 */
export function loginUrl(port: number, code: string): string {
  return `http://${BIND_HOST}:${port}/#${LOGIN_FRAGMENT_PARAM}=${code}`
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

/** Writes a new one-time login code to the state directory (replacing a pending one) and returns its login URL. */
export async function resolveLoginUrl(env: Record<string, string | undefined>, argv: readonly string[]): Promise<string> {
  const port = portArgument(argv) ?? (await loadConfig({ env })).port
  return loginUrl(port, await createLoginCode(expandHome(resolveStateDir(env))))
}

/** `--reset`: logs every browser out. */
export function logOutAllDevices(env: Record<string, string | undefined>): Promise<void> {
  return resetDevices(expandHome(resolveStateDir(env)))
}
