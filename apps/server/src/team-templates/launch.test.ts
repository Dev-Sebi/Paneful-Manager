import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamTemplateSchema, type CreateSessionRequest, type Session } from '@paneful-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.js'
import { createTeamTemplateLauncher } from './launch.js'
import { TEAM_LAUNCHES_FILE_NAME, TeamLaunchLedger } from './ledger.js'
import type { TeamTemplateStore } from './store.js'

const CLAUDE_SESSION_ID = '1a2b3c4d-0000-4000-8000-000000000000'
let stateDir: string
let alive: Set<string>
let requests: CreateSessionRequest[]
let killed: string[]
let failCreate: boolean
let exited: Set<string>
let versionOutput: string
const logger = { info: vi.fn(), warn: vi.fn() }

const engine = {
  create: async (input: CreateSessionRequest): Promise<Session> => {
    if (failCreate) {
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
  get: (id: string): Session | undefined => (alive.has(id) ? ({ id, lifecycle: exited.has(id) ? 'exited' : 'running' } as Session) : undefined),
}

const alpha = TeamTemplateSchema.parse({
  name: 'alpha',
  experimental: true,
  goal: 'Ship the parser',
  lead: { cwd: tmpdir(), args: ['--add-dir', '/extra'], model: 'opus' },
  teammates: [{ name: 'tester', prompt: 'Write tests', model: 'sonnet' }, { name: 'docs', prompt: 'Write docs', cwd: '/work/docs' }],
  env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
})

function setup(templates = [alpha]) {
  const store = {
    get: async (name: string) => {
      const found = templates.find(item => item.name === name)
      if (!found) {
        throw new AppError('missing', 404, 'not_found')
      }
      return found
    },
  } as unknown as TeamTemplateStore
  const ledger = new TeamLaunchLedger(stateDir)
  const version = vi.fn(async () => versionOutput)
  const launcher = createTeamTemplateLauncher({
    store,
    engine,
    ledger,
    logger,
    version,
    newClaudeSessionId: () => CLAUDE_SESSION_ID,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  return { launcher, ledger, version }
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'pm-team-launch-'))
  alive = new Set()
  requests = []
  killed = []
  failCreate = false
  exited = new Set()
  versionOutput = '2.1.311 (Claude Code)\n'
  logger.info.mockReset()
  logger.warn.mockReset()
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('team template launch', () => {
  it('starts the lead with the team flags, settings env and the teammate prompt', async () => {
    const { launcher } = setup()
    const result = await launcher.launch('alpha')
    expect(result).toEqual({
      launch: { template: 'alpha', sessionId: 's1', team: 'session-1a2b3c4d', launchedAt: '2026-01-01T00:00:00.000Z' },
      claudeVersion: '2.1.311',
      untestedVersion: false,
    })
    const request = requests[0]
    expect(request).toMatchObject({ cwd: tmpdir(), command: 'claude', title: 'alpha' })
    const args = request?.args ?? []
    expect(args.slice(0, 6)).toEqual(['--add-dir', '/extra', '--teammate-mode', 'tmux', '--session-id', CLAUDE_SESSION_ID])
    expect(JSON.parse(args[7] ?? '')).toEqual({
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet',
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
        CLAUDE_CODE_TASK_LIST_ID: 'session-1a2b3c4d',
      },
    })
    expect(args.slice(8, 10)).toEqual(['--model', 'opus'])
    const prompt = args.at(-1) ?? ''
    expect(prompt).toContain('- tester (model: sonnet): Write tests')
    expect(prompt).toContain('- docs (working directory: /work/docs): Write docs')
    expect(prompt).toContain('Team goal: Ship the parser')
  })

  it('records the launch and lists it while the lead is live', async () => {
    const { launcher } = setup()
    await launcher.launch('alpha')
    expect(launcher.launches().map(launch => launch.sessionId)).toEqual(['s1'])
    const reloaded = new TeamLaunchLedger(stateDir)
    await reloaded.load()
    expect(reloaded.live(() => true)).toHaveLength(1)
    alive.clear()
    expect(launcher.launches()).toEqual([])
    await launcher.forget('alpha')
    expect(JSON.parse(await readFile(join(stateDir, TEAM_LAUNCHES_FILE_NAME), 'utf8'))).toEqual([])
  })

  it('does not list a launch whose lead has exited', async () => {
    const { launcher, version } = setup()
    await launcher.launch('alpha')
    expect(version).toHaveBeenCalledWith('claude', tmpdir())
    exited.add('s1')
    expect(launcher.launches()).toEqual([])
  })

  it('reads the version from noisy output', async () => {
    versionOutput = 'warning: config 9.9.9 is deprecated\n  2.1.310 (Claude Code)\n'
    expect((await setup().launcher.launch('alpha')).claudeVersion).toBe('2.1.310')
  })

  it('answers 400 when the lead cwd is not a directory', async () => {
    const missing = TeamTemplateSchema.parse({ ...alpha, name: 'missing', lead: { cwd: join(stateDir, 'nope') } })
    const { launcher, version } = setup([missing])
    await expect(launcher.launch('missing')).rejects.toMatchObject({ statusCode: 400 })
    expect(version).not.toHaveBeenCalled()
  })

  it('refuses old or unparsable versions before any session starts', async () => {
    const { launcher } = setup()
    for (const output of ['2.1.308 (Claude Code)', 'not a version']) {
      versionOutput = output
      await expect(launcher.launch('alpha')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('2.1.309 or later') })
    }
    expect(requests).toEqual([])
  })

  it('reports a failing version probe as a conflict', async () => {
    const { launcher, version } = setup()
    version.mockRejectedValueOnce(new Error('spawn claude ENOENT'))
    await expect(launcher.launch('alpha')).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('ENOENT') })
    expect(requests).toEqual([])
  })

  it('flags versions newer than the last tested one', async () => {
    versionOutput = '2.2.0'
    expect((await setup().launcher.launch('alpha')).untestedVersion).toBe(true)
  })

  it('records nothing when the lead fails to start', async () => {
    const { launcher, ledger } = setup()
    failCreate = true
    await expect(launcher.launch('alpha')).rejects.toMatchObject({ code: 'session_spawn_failed' })
    expect(ledger.live(() => true)).toEqual([])
    expect(killed).toEqual([])
  })

  it('kills the lead when the launch cannot be completed', async () => {
    const { launcher, ledger } = setup()
    const create = engine.create
    engine.create = async input => ({ ...(await create(input)), id: 'bad id' })
    await expect(launcher.launch('alpha')).rejects.toThrow()
    engine.create = create
    expect(killed).toEqual(['bad id'])
    expect(ledger.live(() => true)).toEqual([])
  })

  it('keeps the lead when recording the launch fails', async () => {
    const { launcher, ledger } = setup()
    ledger.record = async () => {
      throw new Error('disk full')
    }
    await expect(launcher.launch('alpha')).resolves.toMatchObject({ launch: { sessionId: 's1' } })
    expect(killed).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for an unknown template and starts an empty ledger from an invalid file', async () => {
    await expect(setup().launcher.launch('nope')).rejects.toMatchObject({ statusCode: 404 })
    await writeFile(join(stateDir, TEAM_LAUNCHES_FILE_NAME), '{nope')
    const ledger = new TeamLaunchLedger(stateDir, { warn: logger.warn })
    await ledger.load()
    expect(ledger.live(() => true)).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
