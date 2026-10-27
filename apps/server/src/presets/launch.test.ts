import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LaunchPresetResponseSchema, WorkspacePresetSchema, type CreateSessionRequest, type Session } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.js'
import { createPresetLauncher } from './launch.js'
import { LaunchLedger } from './ledger.js'
import type { PresetStore } from './store.js'

let stateDir: string
let alive: Set<string>
let requests: CreateSessionRequest[]
let killed: string[]
let failAt: number | undefined
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const engine = {
  create: async (input: CreateSessionRequest): Promise<Session> => {
    if (failAt === requests.length) {
      throw new AppError('tmux could not start the session', 500, 'session_spawn_failed')
    }
    requests.push(input)
    const id = `s${requests.length}`
    alive.add(id)
    return { id } as Session
  },
  kill: async (id: string): Promise<void> => {
    killed.push(id)
    alive.delete(id)
  },
  get: (id: string): Session | undefined => (alive.has(id) ? ({ id } as Session) : undefined),
}

function preset(name: string, autostart = false) {
  return WorkspacePresetSchema.parse({
    name,
    autostart,
    tabs: [
      { title: 'one', layout: 'row', panes: [{ cwd: '/a', title: 'first', size: 2 }, { cwd: '/b', command: 'sh', args: ['-l'] }] },
      { layout: 'single', panes: [{ cwd: '/c' }] },
    ],
  })
}

function setup(presets: ReturnType<typeof preset>[]) {
  const store = {
    list: async () => presets,
    get: async (name: string) => {
      const found = presets.find(item => item.name === name)
      if (!found) {
        throw new AppError('missing', 404, 'not_found')
      }
      return found
    },
  } as unknown as PresetStore
  const ledger = new LaunchLedger(stateDir)
  return { ledger, launcher: createPresetLauncher({ store, engine, ledger, logger }) }
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ah-launch-'))
  alive = new Set()
  requests = []
  killed = []
  failAt = undefined
  logger.info.mockReset()
  logger.warn.mockReset()
  logger.error.mockReset()
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('preset launch', () => {
  it('creates one session per pane and returns the tab descriptors', async () => {
    const { launcher } = setup([preset('alpha')])
    const result = LaunchPresetResponseSchema.parse(await launcher.launch('alpha'))
    expect(requests.map(request => [request.cwd, request.command, request.args, request.title])).toEqual([
      ['/a', 'claude', [], 'first'],
      ['/b', 'sh', ['-l'], undefined],
      ['/c', 'claude', [], undefined],
    ])
    expect(result.tabs).toEqual([
      { title: 'one', layout: { kind: 'row' }, panes: [{ sessionId: 's1', size: 2 }, { sessionId: 's2' }] },
      { title: 'alpha 2', layout: { kind: 'single' }, panes: [{ sessionId: 's3' }] },
    ])
  })

  it('answers 404 for an unknown preset', async () => {
    const { launcher } = setup([])
    await expect(launcher.launch('nope')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('kills the sessions already created when a later pane fails', async () => {
    const { launcher, ledger } = setup([preset('alpha')])
    failAt = 2
    await expect(launcher.launch('alpha')).rejects.toMatchObject({ code: 'session_spawn_failed' })
    expect(killed).toEqual(['s1', 's2'])
    expect(alive.size).toBe(0)
    expect(ledger.sessionIds('alpha')).toEqual([])
  })

  it('creates nothing when a pane is invalid', async () => {
    const bad = WorkspacePresetSchema.parse({ name: 'bad', tabs: [{ layout: 'single', panes: [{ cwd: '/a', command: 'a=b' }] }] })
    const { launcher } = setup([bad])
    await expect(launcher.launch('bad')).rejects.toThrow()
    expect(requests).toEqual([])
    expect(killed).toEqual([])
  })

  it('logs a failed rollback kill and still rethrows the launch error', async () => {
    const { launcher } = setup([preset('alpha')])
    failAt = 1
    const original = engine.kill
    engine.kill = async () => {
      throw new Error('stuck')
    }
    await expect(launcher.launch('alpha')).rejects.toMatchObject({ code: 'session_spawn_failed' })
    engine.kill = original
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('preset autostart', () => {
  it('launches autostart presets once and logs one line each', async () => {
    const { launcher } = setup([preset('auto', true), preset('manual')])
    await launcher.autostart()
    expect(requests).toHaveLength(3)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith('Autostarted preset auto (3 sessions)')
  })

  it('skips a preset whose sessions survived a restart', async () => {
    const first = setup([preset('auto', true)])
    await first.launcher.autostart()
    const restarted = setup([preset('auto', true)])
    await restarted.ledger.load()
    await restarted.launcher.autostart()
    expect(requests).toHaveLength(3)
    expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('autostart skipped'))
  })

  it('launches again once the earlier sessions are gone', async () => {
    const first = setup([preset('auto', true)])
    await first.launcher.autostart()
    alive.clear()
    const restarted = setup([preset('auto', true)])
    await restarted.ledger.load()
    await restarted.launcher.autostart()
    expect(requests).toHaveLength(6)
  })

  it('treats a manual launch like an autostart launch', async () => {
    const first = setup([preset('auto', true)])
    await first.launcher.launch('auto')
    await first.launcher.autostart()
    expect(requests).toHaveLength(3)
  })

  it('never throws: every failing preset is logged and the run continues', async () => {
    const { launcher } = setup([preset('one', true), preset('two', true)])
    failAt = 1
    await expect(launcher.autostart()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(2)
    failAt = undefined
    await launcher.autostart()
    expect(requests).toHaveLength(7)
  })

  it('survives a store that cannot list', async () => {
    const store = { list: async () => { throw new Error('boom') } } as unknown as PresetStore
    const launcher = createPresetLauncher({ store, engine, ledger: new LaunchLedger(stateDir), logger })
    await expect(launcher.autostart()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('starts with an empty ledger when the file is invalid', async () => {
    await writeFile(join(stateDir, 'preset-launches.json'), '{nope')
    const ledger = new LaunchLedger(stateDir, { warn: logger.warn })
    await ledger.load()
    expect(ledger.sessionIds('auto')).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
