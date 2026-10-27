import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type TeamChangedMessage } from '@agent-hub/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config/store.js'
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
})
