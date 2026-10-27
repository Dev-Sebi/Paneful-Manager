import { spawn } from 'node:child_process'

/** Server env vars every child inherits; everything else must be passed explicitly. */
export const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR', 'SHELL'] as const

export interface RunOptions {
  cwd?: string
  timeoutMs: number
  /** Max bytes per stream; the process group is killed when exceeded. */
  maxBuffer: number
  /** Merged over `BASE_ENV_KEYS` taken from the server env; no other server variables are inherited. */
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type RunFailure = 'exit' | 'signal' | 'timeout' | 'max-buffer' | 'spawn'

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

function baseEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(BASE_ENV_KEYS.flatMap(key => (process.env[key] === undefined ? [] : [[key, process.env[key]]])))
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // The group is already gone.
  }
}

interface Outcome {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  overflow: boolean
  timedOut: boolean
}

function toRunError(file: string, timeoutMs: number, out: Outcome): RunError {
  const { stdout, stderr } = out
  const detail = stderr.trim()
  const suffix = detail === '' ? '' : `: ${detail}`
  const fail = (message: string, reason: RunFailure): RunError => new RunError(message, reason, out.code, stdout, stderr)
  if (out.timedOut) {
    return fail(`${file} timed out after ${timeoutMs} ms`, 'timeout')
  }
  if (out.overflow) {
    return fail(`${file} exceeded the output limit`, 'max-buffer')
  }
  if (out.signal !== null) {
    return fail(`${file} was killed by ${out.signal}${suffix}`, 'signal')
  }
  return fail(`${file} exited with code ${out.code}${suffix}`, 'exit')
}

/**
 * Runs a binary with an argument array, never through a shell, in its own process group.
 * On timeout or output overflow the whole group is killed; rejects with `RunError` unless it exits 0.
 */
export function run(file: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const { cwd, timeoutMs, maxBuffer, env } = options
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...baseEnv(), ...env },
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false
    let overflow = false
    let settled = false
    const collect = (stream: NodeJS.ReadableStream): (() => string) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        if (size + chunk.length > maxBuffer) {
          chunks.push(chunk.subarray(0, maxBuffer - size))
          size = maxBuffer
          overflow = true
          killGroup(child.pid)
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })
      return () => Buffer.concat(chunks).toString('utf8')
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid)
    }, timeoutMs)
    child.once('error', error => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      killGroup(child.pid)
      reject(new RunError(`${file} could not be started: ${error.message}`, 'spawn', null, stdout(), stderr(), { cause: error }))
    })
    child.once('close', (code, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      const outcome = { code, signal, stdout: stdout(), stderr: stderr(), overflow, timedOut }
      if (code === 0 && !overflow && !timedOut) {
        resolve({ code, stdout: outcome.stdout, stderr: outcome.stderr })
      } else {
        reject(toRunError(file, timeoutMs, outcome))
      }
    })
  })
}
