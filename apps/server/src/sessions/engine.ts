import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import {
  DEFAULT_HOST_ID,
  HOOK_ENV,
  SessionSchema,
  type CreateSessionRequest,
  type Session,
  type SessionLifecycle,
  type SessionState,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import { expandHome } from '../paths.js'
import { Tmux, TmuxSessionNotFoundError, TmuxUnavailableError, tmuxEnv, tmuxName, type TmuxSessionInfo } from '../tmux/tmux.js'
import { spawnPty as defaultSpawnPty, type PtyProcess, type SpawnPty } from './pty.js'
import { SessionStore } from './store.js'
import { Utf8StreamDecoder } from './utf8.js'

/** History lines sent as `scrollback` on attach; bounded by the tmux `history-limit`. */
export const SCROLLBACK_LINES = 10_000
export const POLL_ATTACHED_MS = 1000
export const POLL_IDLE_MS = 5000
export const RECOVERED_TITLE = 'Recovered'
export const RECOVERED_COLS = 80
export const RECOVERED_ROWS = 24

export interface StateChange {
  sessionId: string
  state: SessionState
  lifecycle: SessionLifecycle
  exitCode?: number
  stateSince?: string
}

export interface EngineEvents {
  'session.created': [Session]
  'session.removed': [string]
  state: [StateChange]
  output: [string, string]
}

/** Receiver of one session's terminal data; one object may be attached to many sessions. */
export interface EngineClient {
  scrollback: (sessionId: string, data: string) => void
  output: (sessionId: string, data: string) => void
  /** The shared pty died while the session still exists; the client is no longer attached. */
  lost: (sessionId: string, code: 'tmux_unavailable' | 'internal') => void
}

export interface AttachOptions {
  cols: number
  rows: number
  scrollback: boolean
}

export interface SessionEngineOptions {
  stateDir: string
  logger: Pick<BaseLogger, 'debug' | 'info' | 'warn' | 'error'>
  tmux?: Tmux
  spawnPty?: SpawnPty
  /** Extra environment for new sessions: hook token and server URL; `AGENT_HUB_SESSION_ID` is always set. */
  sessionEnv?: (id: string) => Record<string, string>
  scrollbackLines?: number
  pollAttachedMs?: number
  pollIdleMs?: number
}

export class UnknownSessionError extends AppError {
  constructor(id: string) {
    super(`Unknown session ${id}`, 404, 'not_found')
  }
}

interface Attachment {
  pty: PtyProcess
  decoder: Utf8StreamDecoder
  /** Value is the output buffered until the client got its scrollback, or null once live. */
  clients: Map<EngineClient, string[] | null>
}

export function generateSessionId(): string {
  return randomBytes(9).toString('base64url')
}

function stateOf(session: Session): StateChange {
  return {
    sessionId: session.id,
    state: session.state,
    lifecycle: session.lifecycle,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    ...(session.stateSince === undefined ? {} : { stateSince: session.stateSince }),
  }
}

/** A dead pane is exited right away; tmux may collect the exit status later, which a later poll adds. */
function withLifecycle(session: Session, info: Pick<TmuxSessionInfo, 'dead' | 'exitStatus'>): Session {
  const { exitCode: _exitCode, ...rest } = session
  if (!info.dead) {
    return { ...rest, lifecycle: 'running' }
  }
  return { ...rest, lifecycle: 'exited', ...(info.exitStatus === undefined ? {} : { exitCode: info.exitStatus }) }
}

/** Owns tmux sessions, their metadata and the shared pty per attached session. */
export class SessionEngine extends EventEmitter<EngineEvents> {
  readonly tmux: Tmux
  readonly store: SessionStore
  private readonly sessions = new Map<string, Session>()
  private readonly attachments = new Map<string, Attachment>()
  private readonly options: SessionEngineOptions
  private readonly spawnPty: SpawnPty
  private reconciled = false
  private tmuxAvailable = true
  private pollTimer: NodeJS.Timeout | undefined
  private polling: Promise<void> | undefined
  private closed = false
  /** Creation counter: a listing only judges sessions that existed when it started. */
  private generation = 0
  private readonly born = new Map<string, number>()

  constructor(options: SessionEngineOptions) {
    super()
    this.options = options
    this.tmux = options.tmux ?? new Tmux()
    this.spawnPty = options.spawnPty ?? defaultSpawnPty
    this.store = new SessionStore(options.stateDir, options.logger)
  }

  get available(): boolean {
    return this.tmuxAvailable
  }

  /** Creates the state dir, re-adopts tmux sessions and starts exit polling. */
  async start(): Promise<void> {
    await this.store.init()
    await this.poll()
    this.schedulePoll()
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  isAttached(id: string): boolean {
    return this.attachments.has(id)
  }

  async create(input: CreateSessionRequest): Promise<Session> {
    const cwd = resolve(expandHome(input.cwd))
    const isDir = await stat(cwd).then(s => s.isDirectory(), () => false)
    if (!isDir) {
      throw new AppError(`cwd ${input.cwd} is not a directory`, 400, 'bad_request')
    }
    const id = generateSessionId()
    const now = new Date().toISOString()
    const starting = SessionSchema.parse({
      id,
      hostId: DEFAULT_HOST_ID,
      ...(input.title === undefined ? {} : { title: input.title }),
      cwd,
      command: input.command,
      args: input.args,
      tmuxSession: tmuxName(id),
      createdAt: now,
      state: 'idle',
      lifecycle: 'starting',
      lastEventAt: now,
      stateSince: now,
      cols: input.cols,
      rows: input.rows,
    })
    this.born.set(id, ++this.generation)
    this.sessions.set(id, starting)
    await this.store.save(starting)
    try {
      await this.tmux.newSession({
        id,
        cwd,
        command: input.command,
        args: input.args,
        env: { ...this.options.sessionEnv?.(id), [HOOK_ENV.sessionId]: id },
        cols: input.cols,
        rows: input.rows,
      })
    } catch (error) {
      this.sessions.delete(id)
      this.born.delete(id)
      await this.store.remove(id)
      if (error instanceof TmuxUnavailableError) {
        this.tmuxAvailable = false
        throw error
      }
      this.options.logger.warn({ err: error, sessionId: id }, 'tmux new-session failed')
      throw new AppError('tmux could not start the session', 500, 'session_spawn_failed')
    }
    const running: Session = { ...starting, lifecycle: 'running' }
    this.sessions.set(id, running)
    await this.store.save(running)
    this.emit('session.created', running)
    return running
  }

  /** Kills the tmux session and forgets it; throws `UnknownSessionError` for unknown ids. */
  async kill(id: string): Promise<void> {
    if (!this.sessions.has(id)) {
      throw new UnknownSessionError(id)
    }
    this.closeAttachment(id)
    try {
      await this.tmux.killSession(id)
    } catch (error) {
      if (!(error instanceof TmuxSessionNotFoundError || error instanceof TmuxUnavailableError)) {
        throw error
      }
    }
    await this.forget(id)
  }

  /** Registers `client`; it gets `scrollback` (if requested) before any `output`. Last attach sets the size. */
  async attach(id: string, client: EngineClient, options: AttachOptions): Promise<void> {
    const session = this.sessions.get(id)
    if (session === undefined) {
      throw new UnknownSessionError(id)
    }
    let attachment = this.attachments.get(id)
    if (attachment === undefined) {
      attachment = this.openAttachment(id, options.cols, options.rows)
    } else {
      attachment.pty.resize(options.cols, options.rows)
    }
    attachment.clients.set(client, [])
    this.updateSize(session, options.cols, options.rows)

    if (options.scrollback) {
      const history = await this.tmux.capturePane(id, this.options.scrollbackLines ?? SCROLLBACK_LINES).catch((error: unknown) => {
        this.options.logger.warn({ err: error, sessionId: id }, 'capture-pane failed')
        return ''
      })
      if (this.attachments.get(id)?.clients.has(client) !== true) {
        return
      }
      client.scrollback(id, history.replace(/\r?\n/g, '\r\n'))
    }
    const current = this.attachments.get(id)
    const buffered = current?.clients.get(client)
    if (current === undefined || buffered === undefined) {
      return
    }
    current.clients.set(client, null)
    for (const chunk of buffered ?? []) {
      client.output(id, chunk)
    }
    await this.redraw(id)
  }

  detach(id: string, client: EngineClient): void {
    const attachment = this.attachments.get(id)
    if (attachment === undefined || !attachment.clients.delete(client)) {
      return
    }
    if (attachment.clients.size === 0) {
      this.closeAttachment(id)
    }
  }

  /** Writes keystrokes; returns false when no pty is open for the session. */
  input(id: string, data: string): boolean {
    const attachment = this.attachments.get(id)
    if (attachment === undefined) {
      return false
    }
    attachment.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const attachment = this.attachments.get(id)
    const session = this.sessions.get(id)
    if (attachment === undefined || session === undefined) {
      return false
    }
    attachment.pty.resize(cols, rows)
    this.updateSize(session, cols, rows)
    return true
  }

  /**
   * Applies a state derived from a Claude Code hook; false for unknown sessions.
   * Only a changed state is persisted and broadcast; events for sessions that are not running are ignored.
   */
  applyHookState(id: string, state: SessionState): boolean {
    const session = this.sessions.get(id)
    if (session === undefined) {
      return false
    }
    if (session.lifecycle !== 'running') {
      return true
    }
    const now = new Date().toISOString()
    if (session.state === state) {
      this.sessions.set(id, { ...session, lastEventAt: now })
      return true
    }
    const next: Session = { ...session, state, lastEventAt: now, stateSince: now }
    this.sessions.set(id, next)
    this.emit('state', stateOf(next))
    this.store.save(next).catch((error: unknown) => {
      this.options.logger.warn({ err: error, sessionId: id }, 'Saving session state failed')
    })
    return true
  }

  /** Lists tmux sessions once: re-adopts on the first success, then detects exits and vanished sessions. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined
    })
    return this.polling
  }

  /** Closes all ptys and stops polling; tmux sessions keep running. */
  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.pollTimer)
    for (const id of [...this.attachments.keys()]) {
      this.closeAttachment(id)
    }
    await this.polling?.catch(() => undefined)
    await this.store.flush()
  }

  private async pollOnce(): Promise<void> {
    const generation = this.generation
    let listing: TmuxSessionInfo[]
    try {
      listing = await this.tmux.listSessions()
    } catch (error) {
      if (error instanceof TmuxUnavailableError) {
        if (this.tmuxAvailable) {
          this.options.logger.warn({ detail: error.details }, 'tmux server is not running; retrying')
        }
        this.tmuxAvailable = false
        return
      }
      this.options.logger.error({ err: error }, 'tmux list-sessions failed')
      return
    }
    if (!this.tmuxAvailable || !this.reconciled) {
      this.options.logger.info('tmux server is available')
      await this.tmux.ensureNoAlternateScreen().catch((error: unknown) => {
        this.options.logger.warn({ err: error }, 'Setting tmux terminal-overrides failed')
      })
    }
    this.tmuxAvailable = true
    if (this.reconciled) {
      await this.applyListing(listing, generation)
    } else {
      await this.reconcile(listing)
      this.reconciled = true
    }
  }

  private async reconcile(listing: TmuxSessionInfo[]): Promise<void> {
    const records = new Map((await this.store.loadAll()).map(session => [session.id, session]))
    const now = new Date().toISOString()
    for (const info of listing) {
      if (info.id === undefined) {
        continue
      }
      const record = records.get(info.id)
      let session: Session
      if (record === undefined) {
        this.options.logger.info({ sessionId: info.id, startCommand: info.startCommand }, 'Adopting orphan tmux session')
        session = withLifecycle(SessionSchema.parse({
          id: info.id,
          hostId: DEFAULT_HOST_ID,
          title: RECOVERED_TITLE,
          cwd: info.path || homedir(),
          command: 'tmux',
          args: [],
          tmuxSession: info.name,
          createdAt: info.createdAt.toISOString(),
          state: 'idle',
          lifecycle: 'running',
          lastEventAt: now,
          stateSince: now,
          cols: RECOVERED_COLS,
          rows: RECOVERED_ROWS,
        }), info)
      } else {
        session = withLifecycle({ ...record, state: 'idle', stateSince: now }, info)
      }
      this.sessions.set(session.id, session)
      await this.store.save(session)
    }
    const removed = await this.store.prune(new Set(this.sessions.keys()))
    if (removed.length > 0) {
      this.options.logger.info({ sessionIds: removed }, 'Removed stale session records')
    }
  }

  private async applyListing(listing: TmuxSessionInfo[], generation: number): Promise<void> {
    const byId = new Map(listing.flatMap(info => (info.id === undefined ? [] : [[info.id, info] as const])))
    for (const session of [...this.sessions.values()]) {
      if (session.lifecycle === 'starting' || (this.born.get(session.id) ?? 0) > generation) {
        continue
      }
      const info = byId.get(session.id)
      if (info === undefined) {
        this.options.logger.info({ sessionId: session.id }, 'tmux session disappeared')
        this.closeAttachment(session.id)
        await this.forget(session.id)
      } else if (info.dead && (session.lifecycle === 'running' || (session.exitCode === undefined && info.exitStatus !== undefined))) {
        await this.setSession(withLifecycle(session, info))
      }
    }
  }

  private schedulePoll(): void {
    if (this.closed) {
      return
    }
    const delay = this.attachments.size > 0
      ? this.options.pollAttachedMs ?? POLL_ATTACHED_MS
      : this.options.pollIdleMs ?? POLL_IDLE_MS
    this.pollTimer = setTimeout(() => {
      this.poll().finally(() => this.schedulePoll())
    }, delay)
    this.pollTimer.unref()
  }

  private async setSession(session: Session): Promise<void> {
    if (!this.sessions.has(session.id)) {
      return
    }
    this.sessions.set(session.id, session)
    await this.store.save(session)
    this.emit('state', stateOf(session))
  }

  private async forget(id: string): Promise<void> {
    this.born.delete(id)
    if (!this.sessions.delete(id)) {
      return
    }
    await this.store.remove(id)
    this.emit('session.removed', id)
  }

  private updateSize(session: Session, cols: number, rows: number): void {
    if (session.cols === cols && session.rows === rows) {
      return
    }
    const resized = { ...session, cols, rows }
    this.sessions.set(session.id, resized)
    this.store.save(resized).catch((error: unknown) => {
      this.options.logger.warn({ err: error, sessionId: session.id }, 'Saving session size failed')
    })
  }

  private openAttachment(id: string, cols: number, rows: number): Attachment {
    const pty = this.spawnPty(this.tmux.binary, this.tmux.attachArgs(id), {
      cols,
      rows,
      cwd: homedir(),
      env: tmuxEnv(process.env),
    })
    const attachment: Attachment = { pty, decoder: new Utf8StreamDecoder(), clients: new Map() }
    this.attachments.set(id, attachment)
    pty.onData(chunk => {
      const data = attachment.decoder.decode(chunk)
      if (data.length === 0) {
        return
      }
      this.emit('output', id, data)
      for (const [client, buffer] of attachment.clients) {
        if (buffer === null) {
          client.output(id, data)
        } else {
          buffer.push(data)
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      if (this.attachments.get(id) !== attachment) {
        return
      }
      const clients = [...attachment.clients.keys()]
      this.attachments.delete(id)
      this.options.logger.info({ sessionId: id, exitCode }, 'tmux client exited')
      if (!this.closed) {
        this.releaseClients(id, clients).catch((error: unknown) => {
          this.options.logger.warn({ err: error, sessionId: id }, 'Handling a lost pty failed')
        })
      }
    })
    return attachment
  }

  /** After an unexpected pty exit: a fresh listing decides between `session.removed` and telling clients why. */
  private async releaseClients(id: string, clients: EngineClient[]): Promise<void> {
    await this.polling?.catch(() => undefined)
    await this.poll()
    if (!this.sessions.has(id)) {
      return
    }
    const code = this.tmuxAvailable ? 'internal' : 'tmux_unavailable'
    for (const client of clients) {
      if (this.attachments.get(id)?.clients.has(client) !== true) {
        client.lost(id, code)
      }
    }
  }

  private closeAttachment(id: string): void {
    const attachment = this.attachments.get(id)
    if (attachment === undefined) {
      return
    }
    this.attachments.delete(id)
    attachment.clients.clear()
    try {
      attachment.pty.kill()
    } catch (error) {
      this.options.logger.debug({ err: error, sessionId: id }, 'pty kill failed')
    }
  }

  /** Makes tmux repaint the visible screen through the shared pty. */
  private async redraw(id: string): Promise<void> {
    try {
      for (const tty of await this.tmux.listClients(id)) {
        await this.tmux.refreshClient(tty)
      }
    } catch (error) {
      this.options.logger.debug({ err: error, sessionId: id }, 'refresh-client failed')
    }
  }
}
