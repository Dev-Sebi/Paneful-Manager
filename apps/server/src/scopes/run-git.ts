import { run } from '../process/exec.js'

export const GIT_TIMEOUT_MS = 5000
export const GIT_MAX_BUFFER_BYTES = 1024 * 1024

/** `run()` inherits no `GIT_*` variables (only `BASE_ENV_KEYS`); this pins prompts off and a stable locale. */
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } as const

export interface RunOptions {
  timeoutMs?: number
  maxBuffer?: number
}

export type RunFn = (file: string, args: readonly string[], opts?: RunOptions) => Promise<{ stdout: string }>

/** Default runner for scope discovery, backed by the shared `run()` helper (no shell). */
export const runFile: RunFn = (file, args, opts = {}) =>
  run(file, args, {
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER_BYTES,
    env: GIT_ENV,
  })
