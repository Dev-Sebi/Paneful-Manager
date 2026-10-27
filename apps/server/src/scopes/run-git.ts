import { execFile } from 'node:child_process'

export const GIT_TIMEOUT_MS = 5000
export const GIT_MAX_BUFFER_BYTES = 1024 * 1024

function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
}

export interface RunOptions {
  timeoutMs?: number
  maxBuffer?: number
}

export type RunFn = (file: string, args: readonly string[], opts?: RunOptions) => Promise<{ stdout: string }>

/** Thin `execFile` wrapper (no shell); swappable with the shared exec helper. */
export const runFile: RunFn = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: opts.maxBuffer ?? GIT_MAX_BUFFER_BYTES, encoding: 'utf8', env: gitEnv() },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve({ stdout })
        }
      },
    )
  })
