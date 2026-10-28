import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROUTES,
  ApiErrorSchema,
  DEFAULT_CONFIG,
  DeleteTeamTemplateResponseSchema,
  LaunchTeamTemplateResponseSchema,
  ListTeamTemplatesResponseSchema,
  SESSION_TOKEN_HEADER,
  TeamTemplateResponseSchema,
  type Session,
} from '@paneful-manager/shared'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createConfigStore, type ConfigStore } from '../config/store.js'
import { createTeamTemplateLauncher } from './launch.js'
import { TeamLaunchLedger } from './ledger.js'
import { createTeamTemplateStore } from './store.js'

const TOKEN = 'test-token'
const local = { host: `127.0.0.1:${DEFAULT_CONFIG.port}`, origin: `http://127.0.0.1:${DEFAULT_CONFIG.port}`, 'x-paneful-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN }
const template = { name: 'alpha', experimental: true, lead: { cwd: tmpdir() }, teammates: [{ name: 'tester', prompt: 'Test it' }] }
const body = { template }
let root: string
let app: FastifyInstance
let config: ConfigStore
let live: Set<string>

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { ...local, ...options.headers } })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-team-template-routes-'))
  const logger = pino({ level: 'silent' })
  const store = createTeamTemplateStore({ dir: join(root, 'teams'), logger })
  live = new Set()
  let counter = 0
  const engine = {
    create: async () => {
      const id = `s${++counter}`
      live.add(id)
      return { id } as Session
    },
    kill: async () => {},
    get: (id: string) => (live.has(id) ? ({ id, lifecycle: 'running' } as Session) : undefined),
  }
  const launcher = createTeamTemplateLauncher({
    store,
    engine,
    ledger: new TeamLaunchLedger(join(root, 'state')),
    logger,
    version: async () => '2.1.311 (Claude Code)',
    newClaudeSessionId: () => 'abcdef12-0000-4000-8000-000000000000',
  })
  config = createConfigStore({ ...DEFAULT_CONFIG, experimental: { agentTeams: true } })
  app = buildApp({ config: DEFAULT_CONFIG, configStore: config, logger, sessionToken: TOKEN, accessKey: TOKEN, dev: false, teamTemplates: { store, launcher } })
})

afterEach(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true })
})

describe('team template routes', () => {
  it('creates, reads, lists, replaces and deletes a template', async () => {
    const created = await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: body })
    expect(created.statusCode).toBe(201)
    expect(TeamTemplateResponseSchema.parse(created.json()).template.lead.command).toBe('claude')
    const listed = ListTeamTemplatesResponseSchema.parse((await inject({ method: 'GET', url: API_ROUTES.teamTemplates })).json())
    expect(listed).toMatchObject({ templates: [{ name: 'alpha' }], launches: [] })
    expect((await inject({ method: 'GET', url: '/api/team-templates/alpha' })).statusCode).toBe(200)
    const replaced = await inject({ method: 'PUT', url: '/api/team-templates/alpha', payload: { template: { ...template, description: 'v2' } } })
    expect(TeamTemplateResponseSchema.parse(replaced.json()).template.description).toBe('v2')
    const deleted = await inject({ method: 'DELETE', url: '/api/team-templates/alpha' })
    expect(DeleteTeamTemplateResponseSchema.parse(deleted.json())).toEqual({ name: 'alpha', deleted: true })
  })

  it('answers 409 on duplicates, 404 on missing templates and 400 on invalid bodies', async () => {
    await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: body })
    expect((await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: body })).statusCode).toBe(409)
    for (const [method, url] of [['GET', '/api/team-templates/missing'], ['DELETE', '/api/team-templates/missing'], ['POST', '/api/team-templates/missing/launch']] as const) {
      expect((await inject({ method, url })).statusCode).toBe(404)
    }
    const invalid = await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: { template: { ...template, env: { PATH: '/tmp' } } } })
    expect(invalid.statusCode).toBe(400)
    expect(ApiErrorSchema.parse(invalid.json()).code).toBe('validation_failed')
    expect((await inject({ method: 'GET', url: '/api/team-templates/..%2Fevil' })).statusCode).toBe(400)
  })

  it('launches the lead and lists the live launch', async () => {
    await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: body })
    const response = await inject({ method: 'POST', url: '/api/team-templates/alpha/launch' })
    expect(response.statusCode).toBe(201)
    expect(LaunchTeamTemplateResponseSchema.parse(response.json()).launch).toMatchObject({ sessionId: 's1', team: 'session-abcdef12' })
    const listed = ListTeamTemplatesResponseSchema.parse((await inject({ method: 'GET', url: API_ROUTES.teamTemplates })).json())
    expect(listed.launches.map(launch => launch.team)).toEqual(['session-abcdef12'])
  })

  it('answers 404 on every route while the flag is off and follows it live', async () => {
    await inject({ method: 'POST', url: API_ROUTES.teamTemplates, payload: body })
    await config.patch({ experimental: { agentTeams: false } })
    for (const [method, url] of [
      ['GET', API_ROUTES.teamTemplates],
      ['POST', API_ROUTES.teamTemplates],
      ['GET', '/api/team-templates/alpha'],
      ['PUT', '/api/team-templates/alpha'],
      ['DELETE', '/api/team-templates/alpha'],
      ['POST', '/api/team-templates/alpha/launch'],
    ] as const) {
      const response = await inject({ method, url, payload: body })
      expect(response.statusCode, `${method} ${url}`).toBe(404)
      expect(ApiErrorSchema.parse(response.json()).code).toBe('not_found')
    }
    expect(live.size).toBe(0)
    await config.patch({ experimental: { agentTeams: true } })
    expect((await inject({ method: 'GET', url: '/api/team-templates/alpha' })).statusCode).toBe(200)
  })

  it('applies the token and Origin rules to every mutation', async () => {
    for (const [method, url] of [['POST', API_ROUTES.teamTemplates], ['PUT', '/api/team-templates/alpha'], ['DELETE', '/api/team-templates/alpha'], ['POST', '/api/team-templates/alpha/launch']] as const) {
      expect((await inject({ method, url, payload: body, headers: { [SESSION_TOKEN_HEADER]: 'wrong' } })).statusCode).toBe(401)
      expect((await app.inject({ method, url, payload: body, headers: { host: local.host, 'x-paneful-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN } })).statusCode).toBe(401)
      expect((await inject({ method, url, payload: body, headers: { origin: 'http://evil.example' } })).statusCode).toBe(403)
    }
    expect(live.size).toBe(0)
  })
})
