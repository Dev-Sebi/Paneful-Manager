import { describe, expect, it } from 'vitest'
import { RunError, run } from './exec.js'

const opts = { timeoutMs: 5000, maxBuffer: 1024 * 1024 }

async function failure(promise: Promise<unknown>): Promise<RunError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof RunError)) {
    throw new Error('expected a RunError')
  }
  return error
}

describe('run', () => {
  it('captures stdout and stderr', async () => {
    const result = await run('sh', ['-c', 'printf out; printf err >&2'], opts)
    expect(result).toEqual({ code: 0, stdout: 'out', stderr: 'err' })
  })

  it('passes arguments verbatim without shell expansion', async () => {
    const result = await run('printf', ['%s', '$HOME; echo injected'], opts)
    expect(result.stdout).toBe('$HOME; echo injected')
  })

  it('uses cwd and a replaced environment', async () => {
    const result = await run('sh', ['-c', 'pwd; printf "$ONLY"'], { ...opts, cwd: '/', env: { ONLY: 'set', PATH: '/usr/bin:/bin' } })
    expect(result.stdout).toBe('/\nset')
  })

  it('rejects on a non-zero exit with stderr in the error', async () => {
    const error = await failure(run('sh', ['-c', 'echo broken >&2; exit 3'], opts))
    expect(error.reason).toBe('exit')
    expect(error.code).toBe(3)
    expect(error.stderr).toBe('broken\n')
    expect(error.message).toContain('broken')
  })

  it('kills the child on timeout', async () => {
    const started = Date.now()
    const error = await failure(run('sleep', ['5'], { ...opts, timeoutMs: 100 }))
    expect(error.reason).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds the output', async () => {
    const error = await failure(run('sh', ['-c', 'head -c 5000 /dev/zero'], { ...opts, maxBuffer: 100 }))
    expect(error.reason).toBe('max-buffer')
  })

  it('never invokes a shell, so a command string is not found', async () => {
    const error = await failure(run('echo $HOME', [], opts))
    expect(error.reason).toBe('spawn')
    expect((error.cause as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
