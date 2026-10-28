import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type TeamChangedMessage } from '@paneful-manager/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config/store.js'
import type { TmuxPaneInfo } from '../tmux/tmux.js'
import { makeClaudeDir, task, writeJson } from './fixtures.js'
import { createTeamsService, type TeamsService } from './service.js'

const WAIT_MS = 10_000
let dir: string
let service: TeamsService
let messages: TeamChangedMessage[]

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out')
    }
    await new Promise(done => setTimeout(done, 25))
  }
}

const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

beforeEach(() => {
  dir = makeClaudeDir()
  mkdirSync(join(dir, 'tasks', 'alpha'), { recursive: true })
  messages = []
})
afterEach(async () => {
  await service.close()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('teams service', () => {
  it('starts and stops the watcher with the flag and reads nothing while off', { timeout: 30_000 }, async () => {
    const store = createConfigStore(DEFAULT_CONFIG)
    service = createTeamsService({
      claudeDir: dir,
      getConfig: store.get,
      onConfigChange: listener => store.onChange(listener),
      logger: pino({ level: 'silent' }),
      broadcast: message => messages.push(message),
      debounceMs: 50,
      pollIntervalMs: 60_000,
    })
    await service.sync()
    writeJson(join(dir, 'tasks', 'alpha', '1.json'), task('1'))
    await pause(400)
    expect(messages).toEqual([])
    expect(await service.list()).toEqual({ enabled: false, teams: [], warnings: [] })

    await store.patch({ experimental: { agentTeams: true } })
    await until(() => service.enabled())
    await pause(300)
    writeJson(join(dir, 'tasks', 'alpha', '2.json'), task('2'))
    await until(() => messages.length > 0)

    await store.patch({ experimental: { agentTeams: false } })
    await pause(300)
    messages.length = 0
    writeJson(join(dir, 'tasks', 'alpha', '3.json'), task('3'))
    await pause(600)
    expect(messages).toEqual([])
  })

  it('poll fallback reports changes the watcher did not', { timeout: 30_000 }, async () => {
    service = createTeamsService({
      claudeDir: dir,
      getConfig: () => ({ experimental: { agentTeams: true } }),
      logger: pino({ level: 'silent' }),
      broadcast: message => messages.push(message),
      debounceMs: 60_000,
      pollIntervalMs: 100,
    })
    await service.sync()
    writeJson(join(dir, 'tasks', 'alpha', '1.json'), task('1'))
    await until(() => messages.some(message => message.team === 'alpha'))
  })

  it('links members to sessions and broadcasts team.changed when a link changes', { timeout: 30_000 }, async () => {
    writeJson(join(dir, 'teams', 'alpha', 'config.json'), { members: [{ name: 'lead', agentType: 'team-lead' }, { name: 'dev', tmuxPaneId: '%2' }] })
    let panes: TmuxPaneInfo[] = []
    let paneCalls = 0
    service = createTeamsService({
      claudeDir: dir,
      getConfig: () => ({ experimental: { agentTeams: true } }),
      logger: pino({ level: 'silent' }),
      broadcast: message => messages.push(message),
      links: {
        listPanes: async () => {
          paneCalls += 1
          return panes
        },
        sessions: () => [{ id: 's1', cwd: '/work' }],
      },
      debounceMs: 60_000,
      pollIntervalMs: 60_000,
    })
    await service.sync()
    const before = await service.list()
    expect(before.teams[0]?.members.map(member => member.link)).toEqual([
      { status: 'unlinked', reason: 'no-pane' },
      { status: 'unlinked', reason: 'pane-not-found' },
    ])
    await service.refresh()
    expect(messages).toEqual([])

    panes = [{ paneId: '%2', sessionName: 'pm-s1', sessionId: 's1' }]
    await service.refresh()
    expect(messages).toEqual([{ type: 'team.changed', team: 'alpha' }])
    const after = await service.list()
    expect(after.teams[0]?.members.map(member => member.link?.status)).toEqual(['linked', 'linked'])

    paneCalls = 0
    await Promise.all([service.refresh(), service.refresh(), service.refresh(), service.refresh()])
    expect(paneCalls).toBe(2)
  })

  it('reports tmux-unavailable and never lists panes or broadcasts while the flag is off', { timeout: 30_000 }, async () => {
    writeJson(join(dir, 'teams', 'alpha', 'config.json'), { members: [{ name: 'dev', tmuxPaneId: '%2' }] })
    let enabled = false
    let calls = 0
    service = createTeamsService({
      claudeDir: dir,
      getConfig: () => ({ experimental: { agentTeams: enabled } }),
      logger: pino({ level: 'silent' }),
      broadcast: message => messages.push(message),
      links: {
        listPanes: async () => {
          calls += 1
          throw new Error('no server')
        },
        sessions: () => [],
      },
      pollIntervalMs: 60_000,
    })
    await service.sync()
    await service.refresh()
    expect(await service.list()).toEqual({ enabled: false, teams: [], warnings: [] })
    expect(calls).toBe(0)
    enabled = true
    await service.sync()
    const body = await service.list()
    expect(body.teams[0]?.members[0]?.link).toEqual({ status: 'unlinked', reason: 'tmux-unavailable' })

    enabled = false
    await service.sync()
    calls = 0
    writeJson(join(dir, 'teams', 'alpha', 'config.json'), { members: [{ name: 'other', tmuxPaneId: '%3' }] })
    await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(calls).toBe(0)
    expect(messages).toEqual([])
  })
})
