import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamChangedMessage } from '@agent-hub/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeClaudeDir, task, writeJson } from './fixtures.js'
import { createTeamsWatcher, teamOfPath, type TeamsWatcher } from './watcher.js'

const TIMEOUT_MS = 10_000
let dir: string
let watcher: TeamsWatcher
let messages: TeamChangedMessage[]

async function waitForMessage(): Promise<TeamChangedMessage> {
  const deadline = Date.now() + TIMEOUT_MS
  while (messages.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('no team.changed')
    }
    await new Promise(done => setTimeout(done, 25))
  }
  return messages[0] as TeamChangedMessage
}

beforeEach(async () => {
  dir = makeClaudeDir()
  mkdirSync(join(dir, 'tasks', 'alpha'), { recursive: true })
  messages = []
  watcher = createTeamsWatcher({ claudeDir: dir, logger: pino({ level: 'silent' }), broadcast: message => messages.push(message), debounceMs: 50 })
  await watcher.start()
})
afterEach(async () => {
  await watcher.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('teamOfPath', () => {
  it('maps team and task paths to the team name', () => {
    expect(teamOfPath('/c', '/c/tasks/alpha/1.json')).toBe('alpha')
    expect(teamOfPath('/c', '/c/teams/alpha/config.json')).toBe('alpha')
    expect(teamOfPath('/c', '/c/tasks/alpha/.highwatermark')).toBeUndefined()
    expect(teamOfPath('/c', '/c/projects/x')).toBeUndefined()
    expect(teamOfPath('/c', '/c/tasks')).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'linux')('teams watcher', () => {
  it('emits one debounced team.changed for a burst of task writes', { timeout: 30_000 }, async () => {
    writeJson(join(dir, 'tasks', 'alpha', '1.json'), task('1'))
    writeJson(join(dir, 'tasks', 'alpha', '2.json'), task('2'))
    expect(await waitForMessage()).toEqual({ type: 'team.changed', team: 'alpha' })
    await new Promise(done => setTimeout(done, 300))
    expect(messages).toHaveLength(1)
  })

  it('emits for a new team config and ignores unrelated directories', { timeout: 30_000 }, async () => {
    writeJson(join(dir, 'projects', 'p', 'a.json'), {})
    writeJson(join(dir, 'teams', 'beta', 'config.json'), { members: [] })
    expect(await waitForMessage()).toEqual({ type: 'team.changed', team: 'beta' })
    expect(messages.every(message => message.team === 'beta')).toBe(true)
  })
})
