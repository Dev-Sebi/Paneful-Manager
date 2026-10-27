import { SessionIdSchema } from '@agent-hub/shared'
import { AppError } from '../errors.js'
import { run as defaultRun, RunError, type RunOptions } from '../process/exec.js'

export const TMUX_SOCKET_NAME = 'agent-hub'
export const TMUX_SESSION_PREFIX = 'ah-'
export const TMUX_TIMEOUT_MS = 5000
export const TMUX_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** TERM of the attach pty; matches xterm.js in the browser. */
export const PTY_TERM_NAME = 'xterm-256color'
/** Keeps tmux clients out of the alternate screen, so scrollback written before the redraw stays visible. */
export const NO_ALT_SCREEN_OVERRIDE = `${PTY_TERM_NAME}:smcup@:rmcup@`

const SESSION_FORMAT = [
  '#{session_name}',
  '#{session_created}',
  '#{session_path}',
  '#{pane_dead}',
  '#{pane_dead_status}',
  '#{pane_dead_signal}',
  '#{pane_start_command}',
].join('\t')

/** Subset of `run()` the wrapper needs; swappable in tests. */
export type RunFn = (file: string, args: readonly string[], options: RunOptions) => Promise<{ stdout: string }>

export interface TmuxSessionInfo {
  name: string
  /** Agent Hub session id, or undefined for names without the `ah-` prefix or an invalid id. */
  id: string | undefined
  createdAt: Date
  path: string
  dead: boolean
  /** Exit code, `128 + signal` for a killed command; undefined while tmux has not collected it yet. */
  exitStatus: number | undefined
  startCommand: string
}

export interface NewSessionOptions {
  id: string
  cwd: string
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cols: number
  rows: number
}

export interface TmuxOptions {
  socketName?: string
  run?: RunFn
  binary?: string
}

export class TmuxUnavailableError extends AppError {
  constructor(detail: string) {
    super('tmux server is not running', 503, 'tmux_unavailable', { detail })
  }
}

export class TmuxSessionNotFoundError extends Error {
  override readonly name = 'TmuxSessionNotFoundError'
}

export function tmuxName(id: string): string {
  return `${TMUX_SESSION_PREFIX}${id}`
}

/** Exact-match session target; tmux prefix-matches plain names. */
export function sessionTarget(id: string): string {
  return `=${tmuxName(id)}`
}

/** Exact-match target for the session's current window and pane. */
export function paneTarget(id: string): string {
  return `=${tmuxName(id)}:`
}

export function idFromTmuxName(name: string): string | undefined {
  if (!name.startsWith(TMUX_SESSION_PREFIX)) {
    return undefined
  }
  const id = name.slice(TMUX_SESSION_PREFIX.length)
  return SessionIdSchema.safeParse(id).success ? id : undefined
}

function parseExitStatus(dead: boolean, status: string | undefined, signal: string | undefined): number | undefined {
  if (!dead) {
    return undefined
  }
  if (status !== undefined && /^\d+$/.test(status)) {
    return Number(status)
  }
  return signal !== undefined && /^\d+$/.test(signal) ? 128 + Number(signal) : undefined
}

/** Parses `list-sessions -F SESSION_FORMAT` output; the start command is last because it may contain tabs. */
export function parseSessionList(stdout: string): TmuxSessionInfo[] {
  return stdout
    .split('\n')
    .filter(line => line.length > 0)
    .flatMap(line => {
      const [name, created, path, deadRaw, status, signal, ...command] = line.split('\t')
      if (name === undefined || created === undefined || path === undefined || deadRaw === undefined) {
        return []
      }
      const dead = deadRaw === '1'
      const seconds = Number(created)
      return [{
        name,
        id: idFromTmuxName(name),
        createdAt: new Date(Number.isFinite(seconds) ? seconds * 1000 : 0),
        path,
        dead,
        exitStatus: parseExitStatus(dead, status, signal),
        startCommand: command.join('\t'),
      }]
    })
}

function isServerMissing(stderr: string): boolean {
  return /no server running|error connecting to|server exited unexpectedly/i.test(stderr)
}

function isSessionMissing(stderr: string): boolean {
  return /can't find (session|window|pane)|session not found/i.test(stderr)
}

/** Socket location override; `run()` adds only its base env, so it is passed on explicitly. */
function socketEnv(): NodeJS.ProcessEnv {
  const dir = process.env.TMUX_TMPDIR
  return dir === undefined ? {} : { TMUX_TMPDIR: dir }
}

/** Environment for the attach pty; an inherited `$TMUX` would make tmux refuse nested attaches. */
export function tmuxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = base
  return rest
}

/** Typed wrapper over `tmux -L <socket>`; `-N` keeps tmux from ever starting the server itself. */
export class Tmux {
  readonly socketName: string
  readonly binary: string
  private readonly runFn: RunFn

  constructor(options: TmuxOptions = {}) {
    this.socketName = options.socketName ?? TMUX_SOCKET_NAME
    this.binary = options.binary ?? 'tmux'
    this.runFn = options.run ?? defaultRun
  }

  /** Arguments for `tmux attach-session` (used by the pty). */
  attachArgs(id: string): string[] {
    return ['-L', this.socketName, 'attach-session', '-t', sessionTarget(id)]
  }

  async hasServer(): Promise<boolean> {
    try {
      await this.exec(['list-sessions', '-F', '#{session_name}'])
      return true
    } catch (error) {
      if (error instanceof TmuxUnavailableError) {
        return false
      }
      throw error
    }
  }

  /** Appends `NO_ALT_SCREEN_OVERRIDE` to the server's `terminal-overrides` unless it is already there. */
  async ensureNoAlternateScreen(): Promise<void> {
    const current = await this.exec(['show-options', '-s', '-v', 'terminal-overrides'])
    if (!current.split('\n').includes(NO_ALT_SCREEN_OVERRIDE)) {
      await this.exec(['set-option', '-s', '-a', 'terminal-overrides', `,${NO_ALT_SCREEN_OVERRIDE}`])
    }
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    return parseSessionList(await this.exec(['list-sessions', '-F', SESSION_FORMAT]))
  }

  /** Runs `command args...` directly: `env --` guarantees tmux gets several words and never uses `sh -c`. */
  async newSession({ id, cwd, command, args, env, cols, rows }: NewSessionOptions): Promise<void> {
    const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
    await this.exec([
      'new-session', '-d', '-s', tmuxName(id), '-c', cwd, '-x', String(cols), '-y', String(rows),
      ...envArgs, '--', 'env', '--', command, ...args,
    ])
  }

  async killSession(id: string): Promise<void> {
    await this.exec(['kill-session', '-t', sessionTarget(id)])
  }

  /** Up to `lines` lines of history above the visible screen, with escape sequences; empty without history. */
  async capturePane(id: string, lines: number): Promise<string> {
    const historySize = Number((await this.exec(['display-message', '-p', '-t', paneTarget(id), '#{history_size}'])).trim())
    const depth = Math.min(lines, Number.isFinite(historySize) ? historySize : 0)
    if (depth <= 0) {
      return ''
    }
    return this.exec(['capture-pane', '-p', '-e', '-J', '-S', `-${depth}`, '-E', '-1', '-t', paneTarget(id)])
  }

  async refreshClient(tty: string): Promise<void> {
    await this.exec(['refresh-client', '-t', tty])
  }

  async listClients(id: string): Promise<string[]> {
    const stdout = await this.exec(['list-clients', '-t', paneTarget(id), '-F', '#{client_tty}'])
    return stdout.split('\n').filter(line => line.length > 0)
  }

  private async exec(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await this.runFn(this.binary, ['-N', '-L', this.socketName, ...args], {
        timeoutMs: TMUX_TIMEOUT_MS,
        maxBuffer: TMUX_MAX_BUFFER_BYTES,
        env: socketEnv(),
      })
      return stdout
    } catch (error) {
      if (error instanceof RunError) {
        if (error.reason === 'spawn') {
          throw new TmuxUnavailableError(`${this.binary} is not installed`)
        }
        if (isServerMissing(error.stderr)) {
          throw new TmuxUnavailableError(error.stderr.trim())
        }
        if (isSessionMissing(error.stderr)) {
          throw new TmuxSessionNotFoundError(error.stderr.trim())
        }
      }
      throw error
    }
  }
}
