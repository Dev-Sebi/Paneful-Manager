import { loadSecretFile, type LoadSecretFileOptions } from '../security/secret-file.js'

export type { LinkFn } from '../security/secret-file.js'

export const HOOK_TOKEN_FILE = 'hook-token'

/**
 * Loads `<stateDir>/hook-token` (mode 0600) or creates it once.
 * The token stays stable across restarts because re-adopted tmux sessions keep their environment.
 */
export function loadHookToken(stateDir: string, options: LoadSecretFileOptions = {}): Promise<string> {
  return loadSecretFile(stateDir, HOOK_TOKEN_FILE, options)
}
