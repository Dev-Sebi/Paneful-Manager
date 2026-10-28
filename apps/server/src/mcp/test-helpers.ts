import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Scope } from '@paneful-manager/shared'
import { pino, type Logger } from 'pino'
import { RunError, type RunOptions, type RunResult } from '../process/exec.js'
import type { CliRun } from './cli.js'

export interface McpSandbox {
  base: string
  home: string
  project: string
  worktree: string
  state: string
  scopes: Scope[]
  cleanup: () => void
}

/** Temp HOME, one project with a worktree directory and a state dir. */
export function createMcpSandbox(): McpSandbox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'paneful-manager-mcp-')))
  const home = join(base, 'home')
  const project = join(base, 'project')
  const worktree = join(base, 'worktree')
  const state = join(base, 'state')
  for (const dir of [home, project, worktree, state]) {
    mkdirSync(dir, { recursive: true })
  }
  const scopes: Scope[] = [
    { kind: 'global', path: join(home, '.claude') },
    { kind: 'project', path: project },
    { kind: 'worktree', path: worktree, projectPath: project },
  ]
  return { base, home, project, worktree, state, scopes, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

export interface RecordedCall {
  file: string
  args: readonly string[]
  options: RunOptions
}

export interface FakeRun {
  run: CliRun
  calls: RecordedCall[]
  /** argv of every `claude mcp ...` call, without `--version` probes. */
  mcpCalls: () => (readonly string[])[]
}

/** Fake `run()`: `claude --version` answers `version` (or fails when null); `handler` decides the rest. */
export function createFakeRun(version: string | null, handler?: (call: RecordedCall) => RunResult | Promise<RunResult>): FakeRun {
  const calls: RecordedCall[] = []
  const run: CliRun = async (file, args, options) => {
    const call = { file, args: [...args], options }
    calls.push(call)
    if (args[0] === '--version') {
      if (version === null) {
        throw new RunError('claude could not be started: ENOENT', 'spawn', null, '', '')
      }
      return { code: 0, stdout: `${version} (Claude Code)\n`, stderr: '' }
    }
    return handler ? handler(call) : { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, mcpCalls: () => calls.filter(call => call.args[0] === 'mcp').map(call => call.args) }
}

/** Logger at debug level that keeps every line in memory. */
export function captureLogger(): { logger: Logger; output: () => string } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'))
      callback()
    },
  })
  return { logger: pino({ level: 'debug' }, stream), output: () => lines.join('') }
}
