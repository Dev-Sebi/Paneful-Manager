import { execFile } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  timeoutMs: number
  /** Max bytes per stream; the child is killed when exceeded. */
  maxBuffer: number
  /** Replaces the inherited environment when given. */
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type RunFailure = 'exit' | 'timeout' | 'max-buffer' | 'spawn'

export class RunError extends Error {
  override readonly name = 'RunError'

  constructor(
    message: string,
    readonly reason: RunFailure,
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface ExecFileError extends Error {
  code?: number | string | null
  killed?: boolean
  signal?: NodeJS.Signals | null
}

function toRunError(file: string, error: ExecFileError, stdout: string, stderr: string, timeoutMs: number): RunError {
  const detail = stderr.trim()
  const suffix = detail === '' ? '' : `: ${detail}`
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new RunError(`${file} exceeded the output limit`, 'max-buffer', null, stdout, stderr, { cause: error })
  }
  if (typeof error.code === 'number') {
    return new RunError(`${file} exited with code ${error.code}${suffix}`, 'exit', error.code, stdout, stderr, { cause: error })
  }
  if (error.killed === true && error.signal !== null && error.signal !== undefined) {
    return new RunError(`${file} timed out after ${timeoutMs} ms`, 'timeout', null, stdout, stderr, { cause: error })
  }
  return new RunError(`${file} could not be started: ${error.message}`, 'spawn', null, stdout, stderr, { cause: error })
}

/** Runs a binary with an argument array, never through a shell; rejects with `RunError` unless it exits 0. */
export function run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const { cwd, timeoutMs, maxBuffer, env } = options
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL', shell: false, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr })
        } else {
          reject(toRunError(file, error, stdout, stderr, timeoutMs))
        }
      },
    )
  })
}
