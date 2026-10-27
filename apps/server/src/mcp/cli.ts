import type { McpScopeKind } from '@agent-hub/shared'
import { AppError } from '../errors.js'
import { RunError, run as defaultRun, type RunOptions, type RunResult } from '../process/exec.js'
import type { NativeServer } from './native.js'

/** How long a detected (or missing) CLI is trusted before `claude --version` runs again. */
export const CLI_CACHE_MS = 60_000
export const CLI_TIMEOUT_MS = 30_000
export const CLI_VERSION_TIMEOUT_MS = 10_000
export const CLI_MAX_BUFFER_BYTES = 256 * 1024
const MAX_ERROR_DETAIL = 300

export type CliRun = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>

export type CliStatus = { available: true; version: string } | { available: false }

export interface ClaudeCliOptions {
  env: Record<string, string | undefined>
  run?: CliRun
  now?: () => number
}

export interface ClaudeCli {
  /** `claude --version`, cached for `CLI_CACHE_MS`. */
  detect: () => Promise<CliStatus>
  /** `claude mcp add-json -s <scope> <name> <json>` in `cwd`; `secrets` are scrubbed from error messages. */
  addJson: (name: string, native: NativeServer, scope: McpScopeKind, cwd: string, secrets: readonly string[]) => Promise<void>
  /** `claude mcp remove -s <scope> <name>` in `cwd`. */
  remove: (name: string, scope: McpScopeKind, cwd: string) => Promise<void>
}

/** Replaces every secret value, raw and JSON-escaped, longest first so overlapping values are fully covered. */
export function scrub(text: string, secrets: readonly string[]): string {
  return secrets
    .flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)])
    .filter(secret => secret.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((result, secret) => result.replaceAll(secret, '***'), text)
}

export function createClaudeCli({ env, run = defaultRun, now = Date.now }: ClaudeCliOptions): ClaudeCli {
  let cached: { status: CliStatus; at: number } | undefined
  // run() only inherits BASE_ENV_KEYS, so the config dir has to be passed on explicitly.
  const childEnv = env.CLAUDE_CONFIG_DIR?.trim() ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } : {}

  async function invoke(command: 'add-json' | 'remove', args: readonly string[], cwd: string, secrets: readonly string[]): Promise<void> {
    try {
      await run('claude', ['mcp', command, ...args], { cwd, timeoutMs: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER_BYTES, env: childEnv })
    } catch (error) {
      if (!(error instanceof RunError)) {
        const message = error instanceof Error ? error.message : String(error)
        throw new AppError(`claude mcp ${command} failed: ${scrub(message, secrets).slice(0, MAX_ERROR_DETAIL)}`, 500, 'internal')
      }
      cached = undefined
      const output = scrub(`${error.stderr}\n${error.stdout}`, secrets).trim().split('\n')[0] ?? ''
      const detail = output === '' ? error.reason : output.slice(0, MAX_ERROR_DETAIL)
      throw new AppError(`claude mcp ${command} failed: ${detail}`, 409, 'conflict', { command, exitCode: error.code })
    }
  }

  return {
    async detect() {
      if (cached && now() - cached.at < CLI_CACHE_MS) {
        return cached.status
      }
      let status: CliStatus
      try {
        const { stdout } = await run('claude', ['--version'], { timeoutMs: CLI_VERSION_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER_BYTES, env: childEnv })
        const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0]
        status = version ? { available: true, version } : { available: false }
      } catch {
        status = { available: false }
      }
      cached = { status, at: now() }
      return status
    },

    async addJson(name, native, scope, cwd, secrets) {
      await invoke('add-json', ['-s', scope, name, JSON.stringify(native)], cwd, secrets)
    },

    async remove(name, scope, cwd) {
      await invoke('remove', ['-s', scope, name], cwd, [])
    },
  }
}
