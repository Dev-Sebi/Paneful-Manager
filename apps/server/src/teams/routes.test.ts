import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { API_ROUTES, DEFAULT_CONFIG, ListTeamsResponseSchema, type AppConfig } from '@paneful-manager/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createConfigStore, type ConfigStore } from '../config/store.js'
import { makeClaudeDir, task, writeJson } from './fixtures.js'

const TOKEN = 'test-token'
let dir: string
let app: FastifyInstance
let config: AppConfig
let store: ConfigStore

function build(): FastifyInstance {
  store = createConfigStore(config)
  app = buildApp({ config, logger: pino({ level: 'silent' }), sessionToken: TOKEN, accessKey: TOKEN, dev: false, configStore: store, teams: { claudeDir: dir } })
  return app
}

const get = () => app.inject({
  method: 'GET',
  url: API_ROUTES.teams,
  headers: { host: `127.0.0.1:${DEFAULT_CONFIG.port}`, origin: `http://127.0.0.1:${DEFAULT_CONFIG.port}`, 'x-paneful-key': TOKEN, 'x-paneful-token': TOKEN },
})

beforeEach(() => {
  dir = makeClaudeDir()
  writeJson(join(dir, 'teams', 'alpha', 'config.json'), { members: [{ name: 'lead' }] })
  writeJson(join(dir, 'tasks', 'alpha', '1.json'), task('1'))
  config = { ...DEFAULT_CONFIG, experimental: { agentTeams: false } }
})
afterEach(async () => {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/teams', () => {
  it('answers disabled and empty while the flag is off', async () => {
    build()
    const response = await get()
    expect(response.statusCode).toBe(200)
    expect(ListTeamsResponseSchema.parse(response.json())).toEqual({ enabled: false, teams: [], warnings: [] })
  })

  it('does not touch the disk while the flag is off', async () => {
    rmSync(dir, { recursive: true, force: true })
    build()
    expect((await get()).json()).toEqual({ enabled: false, teams: [], warnings: [] })
  })

  it('lists teams when the flag is on', async () => {
    config = { ...DEFAULT_CONFIG, experimental: { agentTeams: true } }
    build()
    const body = ListTeamsResponseSchema.parse((await get()).json())
    expect(body.enabled).toBe(true)
    expect(body.teams.map(team => [team.name, team.members.length, team.tasks.length])).toEqual([['alpha', 1, 1]])
  })

  it('follows the flag live', async () => {
    build()
    expect((await get()).json()).toMatchObject({ enabled: false })
    await store.patch({ experimental: { agentTeams: true } })
    expect((await get()).json()).toMatchObject({ enabled: true })
  })
})
