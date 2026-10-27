import { execFile } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  timeoutMs: number
  maxBuffer: number
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  stdout: string
  stderr: string
}

export type RunFn = (file: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>

/** Non-zero exit, timeout or spawn failure; `stderr` is kept for callers that classify errors. */
export class ExecError extends Error {
  override readonly name = 'ExecError'

  constructor(
    message: string,
    readonly exitCode: number | string | null,
    readonly stderr: string,
  ) {
    super(message)
  }
}

/** Runs a program with an argument array via `execFile`; never through a shell. */
export const run: RunFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code ?? null
          reject(new ExecError(`${file} failed: ${stderr.trim() || error.message}`, code, stderr))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
  })
