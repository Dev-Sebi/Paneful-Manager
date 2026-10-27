import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFile } from './run-git.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runFile', () => {
  it('drops GIT_* variables and pins prompt and locale', async () => {
    vi.stubEnv('GIT_DIR', '/elsewhere')
    const { stdout } = await runFile('sh', ['-c', 'printf "%s|%s|%s" "$GIT_DIR" "$GIT_TERMINAL_PROMPT" "$LC_ALL"'])
    expect(stdout).toBe('|0|C')
  })
})
