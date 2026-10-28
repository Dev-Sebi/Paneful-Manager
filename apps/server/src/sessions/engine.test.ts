import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@paneful-manager/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunError } from '../process/exec.js'
import { Tmux, type RunFn } from '../tmux/tmux.js'
import { SECRET_ENV_FILE, SessionEngine, type EngineClient } from './engine.js'
import type { PtyProcess, SpawnPty } from './pty.js'
import { SessionStore } from './store.js'

class FakePty implements PtyProcess {
  dataListener: ((data: Uint8Array | string) => void) | undefined
  exitListener: ((event: { exitCode: number }) => void) | undefined
  written: string[] = []
  size: [number, number]
  killed = false

  constructor(cols: number, rows: number) {
    this.size = [cols, rows]
  }

  onData(listener: (data: Uint8Array | string) => void): void {
    this.dataListener = listener
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener
  }

  write(data: string): void {
    this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }

  kill(): void {
    this.killed = true
  }

  emit(text: string): void {
    this.dataListener?.(new TextEncoder().encode(text))
  }
}

/** In-memory tmux: `sessions` maps names to `pane_dead`/status; capture returns `history`. */
class FakeTmuxServer {
  running = true
  sessions = new Map<string, { dead: boolean, status?: number, path: string }>()
  history = '0'
  capture = ''
  calls: string[][] = []
  onCapture: (() => void) | undefined
  /** When set, list-sessions waits for it before answering. */
  listGate: Promise<void> | undefined
  /** When set, new-session waits for it before the session exists. */
  newSessionGate: Promise<void> | undefined

  run: RunFn = async (_file, rawArgs) => {
    let args = rawArgs.slice(3)
    if (args[0] === 'source-file') {
      this.calls.push(args.slice(0, 2))
      args = args.slice(3)
    }
    this.calls.push(args)
    if (!this.running) {
      throw new RunError('failed', 'exit', 1, '', 'no server running on /tmp/tmux-1000/paneful-manager\n')
    }
    const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '')
    switch (args[0]) {
      case 'list-sessions': {
        const snapshot = [...this.sessions]
        await this.listGate
        return { stdout: snapshot.map(([name, s]) => `${name}\t1793090986\t${s.path}\t${s.dead ? 1 : 0}\t${s.status ?? ''}\t\tsh`).join('\n'), stderr: '' }
      }
      case 'new-session': {
        await this.newSessionGate
        this.sessions.set(args[args.indexOf('-s') + 1] ?? '', { dead: false, path: args[args.indexOf('-c') + 1] ?? '/' })
        return { stdout: '', stderr: '' }
      }
      case 'kill-session': {
        if (target === undefined || !this.sessions.delete(target)) {
          throw new RunError('failed', 'exit', 1, '', `can't find session: ${target}\n`)
        }
        return { stdout: '', stderr: '' }
      }
      case 'display-message': {
        return { stdout: `${this.history}\n`, stderr: '' }
      }
      case 'capture-pane': {
        this.onCapture?.()
        return { stdout: this.capture, stderr: '' }
      }
      case 'list-clients': {
        return { stdout: '/dev/pts/9\n', stderr: '' }
      }
      default: {
        return { stdout: '', stderr: '' }
      }
    }
  }
}

const logger = pino({ level: 'silent' })
let dir: string
let server: FakeTmuxServer
let ptys: FakePty[]
let engine: SessionEngine
let spawnFails = false

const spawnPty: SpawnPty = (_file, _args, { cols, rows }) => {
  if (spawnFails) {
    throw new Error('forkpty failed')
  }
  const pty = new FakePty(cols, rows)
  ptys.push(pty)
  return pty
}

function newEngine(): SessionEngine {
  return new SessionEngine({ stateDir: join(dir, 'state'), logger, tmux: new Tmux({ run: server.run }), spawnPty, pollIdleMs: 60_000, pollAttachedMs: 60_000 })
}

function recorder(): EngineClient & { frames: string[] } {
  const frames: string[] = []
  return {
    frames,
    scrollback: (id, data) => frames.push(`scrollback:${id}:${data}`),
    output: (id, data) => frames.push(`output:${id}:${data}`),
    lost: (id, code) => frames.push(`lost:${id}:${code}`),
  }
}

const record = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  hostId: 'local',
  cwd: '/tmp',
  command: 'claude',
  args: [],
  tmuxSession: `pm-${id}`,
  createdAt: '2026-10-27T10:00:00.000Z',
  state: 'working',
  lifecycle: 'running',
  lastEventAt: '2026-10-27T10:00:00.000Z',
  cols: 120,
  rows: 30,
  ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'paneful-manager-engine-'))
  server = new FakeTmuxServer()
  ptys = []
  spawnFails = false
  engine = newEngine()
})

afterEach(async () => {
  await engine.close()
  await rm(dir, { recursive: true, force: true })
})

describe('SessionEngine', () => {
  it('re-adopts known sessions, adopts orphans, prunes stale records and ignores foreign names', async () => {
    const store = new SessionStore(join(dir, 'state'))
    await store.init()
    await store.save(record('known1'))
    await store.save(record('stale1'))
    server.sessions.set('pm-known1', { dead: true, status: 2, path: '/tmp' })
    server.sessions.set('pm-orphan1', { dead: false, path: '/srv/p1' })
    server.sessions.set('scratch', { dead: false, path: '/tmp' })

    await engine.start()

    expect(engine.list().map(s => s.id).sort()).toEqual(['known1', 'orphan1'])
    expect(engine.get('known1')).toMatchObject({ state: 'idle', lifecycle: 'exited', exitCode: 2 })
    expect(engine.get('orphan1')).toMatchObject({ title: 'Recovered', cwd: '/srv/p1', command: 'tmux', args: [], cols: 80, rows: 24, createdAt: '2026-10-27T08:49:46.000Z' })
    expect((await readdir(store.dir)).sort()).toEqual(['known1.json', 'orphan1.json'])
  })

  it('keeps records while tmux is unavailable and reconciles once it is back', async () => {
    const store = new SessionStore(join(dir, 'state'))
    await store.init()
    await store.save(record('known1'))
    server.running = false
    await engine.start()
    expect(engine.available).toBe(false)
    expect(engine.list()).toEqual([])
    await expect(engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'tmux_unavailable' })
    expect(await readdir(store.dir)).toEqual(['known1.json'])

    server.running = true
    server.sessions.set('pm-known1', { dead: false, path: '/tmp' })
    await engine.poll()
    expect(engine.available).toBe(true)
    expect(engine.get('known1')?.lifecycle).toBe('running')
  })

  it('creates a session and emits session.created after it is running', async () => {
    await engine.start()
    const created: Session[] = []
    engine.on('session.created', session => created.push(session))
    const session = await engine.create({ cwd: dir, command: 'claude', args: ['--resume'], cols: 100, rows: 40, title: 't' })
    expect(session).toMatchObject({ lifecycle: 'running', state: 'idle', cwd: dir, tmuxSession: `pm-${session.id}`, cols: 100, rows: 40 })
    expect(session.id).toMatch(/^[\w-]{12}$/)
    expect(created).toEqual([session])
    const newSession = server.calls.find(call => call[0] === 'new-session')
    expect(newSession).toContain(`PANEFUL_MANAGER_SESSION_ID=${session.id}`)
  })

  it('rejects a cwd with control characters before tmux sees it', async () => {
    await engine.start()
    for (const name of ['x\npm-forged\t1\tsrv\t1\t0\t\tsh', 'tab\there']) {
      const cwd = join(dir, name)
      await mkdir(cwd)
      await expect(engine.create({ cwd, command: 'sh', args: [], cols: 80, rows: 24 })).rejects.toMatchObject({ statusCode: 400, message: /control characters/ })
    }
    expect(server.calls.some(call => call[0] === 'new-session')).toBe(false)
  })

  it('detects exits and vanished sessions when polling', async () => {
    await engine.start()
    const a = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const b = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const states: unknown[] = []
    const removed: string[] = []
    engine.on('state', change => states.push(change))
    engine.on('session.removed', id => removed.push(id))
    server.sessions.set(`pm-${a.id}`, { dead: true, path: dir })
    server.sessions.delete(`pm-${b.id}`)
    await engine.poll()
    server.sessions.set(`pm-${a.id}`, { dead: true, status: 3, path: dir })
    await engine.poll()
    expect(states).toEqual([
      { sessionId: a.id, state: 'idle', lifecycle: 'exited', stateSince: a.stateSince },
      { sessionId: a.id, state: 'idle', lifecycle: 'exited', exitCode: 3, stateSince: a.stateSince },
    ])
    expect(removed).toEqual([b.id])
    await engine.poll()
    expect(states).toHaveLength(2)
  })

  it('sends scrollback before buffered output and shares one pty between clients', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    server.history = '2'
    server.capture = 'one\ntwo\n'
    const first = recorder()
    server.onCapture = () => ptys[0]?.emit('live-during-capture')
    await engine.attach(id, first, { cols: 80, rows: 24, scrollback: true })
    expect(first.frames).toEqual([`scrollback:${id}:one\r\ntwo\r\n`, `output:${id}:live-during-capture`])
    expect(server.calls.some(call => call[0] === 'refresh-client' && call[2] === '/dev/pts/9')).toBe(true)

    const second = recorder()
    server.onCapture = undefined
    await engine.attach(id, second, { cols: 90, rows: 30, scrollback: false })
    expect(ptys).toHaveLength(1)
    expect(ptys[0]?.size).toEqual([90, 30])
    expect(engine.get(id)).toMatchObject({ cols: 90, rows: 30 })
    ptys[0]?.emit('both')
    expect(first.frames.at(-1)).toBe(`output:${id}:both`)
    expect(second.frames).toEqual([`output:${id}:both`])

    expect(engine.input(id, 'ls\r')).toBe(true)
    expect(ptys[0]?.written).toEqual(['ls\r'])
    engine.detach(id, first)
    expect(ptys[0]?.killed).toBe(false)
    engine.detach(id, second)
    expect(ptys[0]?.killed).toBe(true)
    expect(engine.isAttached(id)).toBe(false)
    expect(engine.input(id, 'x')).toBe(false)
  })

  it('decodes multi-byte characters split across pty chunks', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const client = recorder()
    await engine.attach(id, client, { cols: 80, rows: 24, scrollback: false })
    const bytes = new TextEncoder().encode('€')
    ptys[0]?.dataListener?.(bytes.slice(0, 1))
    ptys[0]?.dataListener?.(bytes.slice(1))
    expect(client.frames).toEqual([`output:${id}:€`])
  })

  it('does not drop a session created while a listing was in flight', async () => {
    await engine.start()
    let release = (): void => undefined
    server.listGate = new Promise(resolve => {
      release = resolve
    })
    const polling = engine.poll()
    const session = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    release()
    await polling
    expect(engine.get(session.id)?.lifecycle).toBe('running')
    server.listGate = undefined
    await engine.poll()
    expect(engine.get(session.id)?.lifecycle).toBe('running')
  })

  it('does not drop a session whose tmux start finished after a listing was taken', async () => {
    await engine.start()
    let releaseNew = (): void => undefined
    let releaseList = (): void => undefined
    server.newSessionGate = new Promise(resolve => {
      releaseNew = resolve
    })
    server.listGate = new Promise(resolve => {
      releaseList = resolve
    })
    const calls = server.calls.length
    const creating = engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    await vi.waitFor(() => expect(server.calls.slice(calls).some(args => args[0] === 'new-session')).toBe(true))
    const polling = engine.poll()
    await vi.waitFor(() => expect(server.calls.slice(calls).some(args => args[0] === 'list-sessions')).toBe(true))
    releaseNew()
    const session = await creating
    releaseList()
    await polling
    expect(engine.get(session.id)?.lifecycle).toBe('running')
    server.listGate = undefined
    await engine.poll()
    expect(engine.get(session.id)?.lifecycle).toBe('running')
  })

  it('rejects an attach whose pty cannot be spawned and keeps no attachment', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    spawnFails = true
    await expect(engine.attach(id, recorder(), { cols: 80, rows: 24, scrollback: true })).rejects.toThrow('forkpty failed')
    expect(engine.isAttached(id)).toBe(false)
  })

  it('tells attached clients when the pty dies because tmux is gone', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const client = recorder()
    await engine.attach(id, client, { cols: 80, rows: 24, scrollback: false })
    server.running = false
    ptys[0]?.exitListener?.({ exitCode: 1 })
    await expect.poll(() => client.frames).toContain(`lost:${id}:tmux_unavailable`)
    expect(engine.isAttached(id)).toBe(false)
    expect(engine.available).toBe(false)
    expect(engine.get(id)).toBeDefined()
  })

  it('removes the session instead when the pty died with it', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const client = recorder()
    const removed: string[] = []
    engine.on('session.removed', sessionId => removed.push(sessionId))
    await engine.attach(id, client, { cols: 80, rows: 24, scrollback: false })
    server.sessions.clear()
    ptys[0]?.exitListener?.({ exitCode: 0 })
    await expect.poll(() => removed).toEqual([id])
    expect(client.frames.some(frame => frame.startsWith('lost:'))).toBe(false)
  })

  it('kills sessions, tolerates already-gone tmux sessions and rejects unknown ids', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    await engine.attach(id, recorder(), { cols: 80, rows: 24, scrollback: false })
    server.sessions.clear()
    await engine.kill(id)
    expect(ptys[0]?.killed).toBe(true)
    expect(engine.get(id)).toBeUndefined()
    await expect(engine.kill(id)).rejects.toMatchObject({ code: 'not_found', statusCode: 404 })
  })

  it('closes ptys on close but leaves tmux sessions alone', async () => {
    await engine.start()
    const { id } = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    await engine.attach(id, recorder(), { cols: 80, rows: 24, scrollback: false })
    await engine.close()
    expect(ptys[0]?.killed).toBe(true)
    expect(server.calls.some(call => call[0] === 'kill-session')).toBe(false)
  })

  it('passes the hook environment to new sessions', async () => {
    const env = new SessionEngine({
      stateDir: join(dir, 'state'),
      logger,
      tmux: new Tmux({ run: server.run }),
      spawnPty,
      pollIdleMs: 60_000,
      sessionEnv: () => ({ PANEFUL_MANAGER_URL: 'http://127.0.0.1:7337' }),
      secretEnv: () => ({ PANEFUL_MANAGER_HOOK_TOKEN: 'hook-token-value' }),
    })
    await env.start()
    const session = await env.create({ cwd: dir, command: 'claude', args: [], cols: 80, rows: 24 })
    const args = server.calls.find(call => call[0] === 'new-session') ?? []
    for (const pair of [`PANEFUL_MANAGER_SESSION_ID=${session.id}`, 'PANEFUL_MANAGER_URL=http://127.0.0.1:7337']) {
      expect(args[args.indexOf(pair) - 1]).toBe('-e')
    }
    expect(server.calls.flat().join(' ')).not.toContain('hook-token-value')
    const file = join(dir, 'state', SECRET_ENV_FILE)
    expect(server.calls).toContainEqual(['source-file', file])
    expect(await readFile(file, 'utf8')).toBe("set-environment -g PANEFUL_MANAGER_HOOK_TOKEN 'hook-token-value'\n")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(args.indexOf('--')).toBeGreaterThan(args.indexOf('PANEFUL_MANAGER_URL=http://127.0.0.1:7337'))
    await env.close()
  })

  it('removes secret env temp files left by an interrupted write on start', async () => {
    const state = join(dir, 'state')
    await mkdir(state, { recursive: true })
    const old = new Date(Date.now() - 120_000)
    for (const name of [`${SECRET_ENV_FILE}.0a1b2c.tmp`, `${SECRET_ENV_FILE}.3d4e5f.tmp`]) {
      await writeFile(join(state, name), "set-environment -g PANEFUL_MANAGER_HOOK_TOKEN 'old'\n")
      if (name.includes('0a1b2c')) {
        await utimes(join(state, name), old, old)
      }
    }
    const fresh = newEngine()
    await fresh.start()
    const names = await readdir(state)
    expect(names).not.toContain(`${SECRET_ENV_FILE}.0a1b2c.tmp`)
    expect(names).toContain(`${SECRET_ENV_FILE}.3d4e5f.tmp`)
    await fresh.close()
  })

  it('applies hook states, tracks stateSince and broadcasts only changes', async () => {
    await engine.start()
    const session = await engine.create({ cwd: dir, command: 'claude', args: [], cols: 80, rows: 24 })
    expect(session.stateSince).toBe(session.createdAt)
    const frames: unknown[] = []
    engine.on('state', change => frames.push(change))

    expect(engine.applyHookState(session.id, 'working')).toBe(true)
    const working = engine.get(session.id)
    expect(working).toMatchObject({ state: 'working' })
    expect(frames).toEqual([{ sessionId: session.id, state: 'working', lifecycle: 'running', stateSince: working?.stateSince }])

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(engine.applyHookState(session.id, 'working')).toBe(true)
    expect(frames).toHaveLength(1)
    expect(engine.get(session.id)?.stateSince).toBe(working?.stateSince)
    expect(engine.get(session.id)?.lastEventAt).not.toBe(working?.lastEventAt)

    expect(engine.applyHookState('missing', 'idle')).toBe(false)
    await engine.store.flush()
    const stored = (await engine.store.loadAll()).find(s => s.id === session.id)
    expect(stored).toMatchObject({ state: 'working', stateSince: working?.stateSince })
  })

  it('keeps a hook state that arrives while tmux is still starting the command', async () => {
    let id = ''
    const early: SessionEngine = new SessionEngine({
      stateDir: join(dir, 'state'),
      logger,
      spawnPty,
      pollIdleMs: 60_000,
      tmux: new Tmux({ run: async (file, args, options) => {
        if (args.includes('new-session')) {
          id = args[args.indexOf('-s') + 1]?.replace(/^pm-/, '') ?? ''
          expect(early.applyHookState(id, 'working')).toBe(true)
        }
        return server.run(file, args, options)
      } }),
    })
    await early.start()
    const session = await early.create({ cwd: dir, command: 'claude', args: [], cols: 80, rows: 24 })
    expect(session.id).toBe(id)
    expect(session).toMatchObject({ state: 'working', lifecycle: 'running' })
    await early.close()
  })

  it('ignores hook states for exited sessions', async () => {
    await engine.start()
    const session = await engine.create({ cwd: dir, command: 'claude', args: [], cols: 80, rows: 24 })
    server.sessions.set(session.tmuxSession, { dead: true, status: 0, path: dir })
    await engine.poll()
    expect(engine.applyHookState(session.id, 'working')).toBe(true)
    expect(engine.get(session.id)).toMatchObject({ state: 'idle', lifecycle: 'exited' })
  })

  it('resets state and stateSince when re-adopting', async () => {
    const store = new SessionStore(join(dir, 'state'))
    await store.init()
    await store.save(record('known1'))
    server.sessions.set('pm-known1', { dead: false, path: '/tmp' })
    await engine.start()
    const adopted = engine.get('known1')
    expect(adopted?.state).toBe('idle')
    expect(Date.parse(adopted?.stateSince ?? '')).toBeGreaterThan(Date.parse('2026-10-27T10:00:00.000Z'))
  })
})
