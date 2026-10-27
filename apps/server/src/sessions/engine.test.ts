import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@agent-hub/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecError, type RunFn } from '../process/exec.js'
import { Tmux } from '../tmux/tmux.js'
import { SessionEngine, type EngineClient } from './engine.js'
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

  run: RunFn = async (_file, rawArgs) => {
    const args = rawArgs.slice(3)
    this.calls.push(args)
    if (!this.running) {
      throw new ExecError('failed', 1, 'no server running on /tmp/tmux-1000/agent-hub\n')
    }
    const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '')
    switch (args[0]) {
      case 'list-sessions': {
        return { stdout: [...this.sessions].map(([name, s]) => `${name}\t1793090986\t${s.path}\t${s.dead ? 1 : 0}\t${s.status ?? ''}\tsh`).join('\n'), stderr: '' }
      }
      case 'new-session': {
        this.sessions.set(args[args.indexOf('-s') + 1] ?? '', { dead: false, path: args[args.indexOf('-c') + 1] ?? '/' })
        return { stdout: '', stderr: '' }
      }
      case 'kill-session': {
        if (target === undefined || !this.sessions.delete(target)) {
          throw new ExecError('failed', 1, `can't find session: ${target}\n`)
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

const spawnPty: SpawnPty = (_file, _args, { cols, rows }) => {
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
  }
}

const record = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  hostId: 'local',
  cwd: '/tmp',
  command: 'claude',
  args: [],
  tmuxSession: `ah-${id}`,
  createdAt: '2026-10-27T10:00:00.000Z',
  state: 'working',
  lifecycle: 'running',
  lastEventAt: '2026-10-27T10:00:00.000Z',
  cols: 120,
  rows: 30,
  ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-engine-'))
  server = new FakeTmuxServer()
  ptys = []
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
    server.sessions.set('ah-known1', { dead: true, status: 2, path: '/tmp' })
    server.sessions.set('ah-orphan1', { dead: false, path: '/srv/p1' })
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
    server.sessions.set('ah-known1', { dead: false, path: '/tmp' })
    await engine.poll()
    expect(engine.available).toBe(true)
    expect(engine.get('known1')?.lifecycle).toBe('running')
  })

  it('creates a session and emits session.created after it is running', async () => {
    await engine.start()
    const created: Session[] = []
    engine.on('session.created', session => created.push(session))
    const session = await engine.create({ cwd: dir, command: 'claude', args: ['--resume'], cols: 100, rows: 40, title: 't' })
    expect(session).toMatchObject({ lifecycle: 'running', state: 'idle', cwd: dir, tmuxSession: `ah-${session.id}`, cols: 100, rows: 40 })
    expect(session.id).toMatch(/^[\w-]{12}$/)
    expect(created).toEqual([session])
    const newSession = server.calls.find(call => call[0] === 'new-session')
    expect(newSession).toContain(`AGENT_HUB_SESSION_ID=${session.id}`)
  })

  it('detects exits and vanished sessions when polling', async () => {
    await engine.start()
    const a = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const b = await engine.create({ cwd: dir, command: 'sh', args: [], cols: 80, rows: 24 })
    const states: unknown[] = []
    const removed: string[] = []
    engine.on('state', change => states.push(change))
    engine.on('session.removed', id => removed.push(id))
    server.sessions.set(`ah-${a.id}`, { dead: true, status: 3, path: dir })
    server.sessions.delete(`ah-${b.id}`)
    await engine.poll()
    expect(states).toEqual([{ sessionId: a.id, state: 'idle', lifecycle: 'exited', exitCode: 3 }])
    expect(removed).toEqual([b.id])
    await engine.poll()
    expect(states).toHaveLength(1)
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
})
