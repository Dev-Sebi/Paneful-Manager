import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROUTES,
  ApiErrorSchema,
  DEFAULT_CONFIG,
  DeletePresetResponseSchema,
  LaunchPresetResponseSchema,
  ListPresetsResponseSchema,
  PresetResponseSchema,
  SESSION_TOKEN_HEADER,
  type Session,
} from '@paneful-manager/shared'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { buildApp } from '../app.js'
import { createPresetLauncher } from './launch.js'
import { LaunchLedger } from './ledger.js'
import { createPresetStore } from './store.js'

const TOKEN = 'test-token'
const local = { host: `127.0.0.1:${DEFAULT_CONFIG.port}`, origin: `http://127.0.0.1:${DEFAULT_CONFIG.port}`, 'x-paneful-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN }
const body = { preset: { name: 'alpha', description: 'demo', tabs: [{ layout: 'row', panes: [{ cwd: '/work/app' }, { cwd: '/work/app' }] }] } }
let root: string
let app: FastifyInstance

function inject(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { ...local, ...options.headers } })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-preset-routes-'))
  const logger = pino({ level: 'silent' })
  const store = createPresetStore({ dir: join(root, 'workspaces'), logger })
  let counter = 0
  const engine = {
    create: async () => ({ id: `s${++counter}` }) as Session,
    kill: async () => {},
    get: () => undefined,
  }
  const launcher = createPresetLauncher({ store, engine, ledger: new LaunchLedger(join(root, 'state')), logger })
  app = buildApp({ config: DEFAULT_CONFIG, logger, sessionToken: TOKEN, accessKey: TOKEN, dev: false, presets: { store, launcher } })
})

afterEach(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true })
})

describe('preset routes', () => {
  it('creates, reads, lists, replaces and deletes a preset', async () => {
    const created = await inject({ method: 'POST', url: API_ROUTES.presets, payload: body })
    expect(created.statusCode).toBe(201)
    expect(PresetResponseSchema.parse(created.json()).preset.name).toBe('alpha')
    expect(parse(await readFile(join(root, 'workspaces', 'alpha.yaml'), 'utf8'))).toMatchObject({ name: 'alpha', description: 'demo' })

    const listed = ListPresetsResponseSchema.parse((await inject({ method: 'GET', url: API_ROUTES.presets })).json())
    expect(listed.presets).toHaveLength(1)
    const one = await inject({ method: 'GET', url: '/api/presets/alpha' })
    expect(PresetResponseSchema.parse(one.json()).preset.tabs).toHaveLength(1)

    const replaced = await inject({ method: 'PUT', url: '/api/presets/alpha', payload: { preset: { ...body.preset, description: 'v2' } } })
    expect(PresetResponseSchema.parse(replaced.json()).preset.description).toBe('v2')

    const deleted = await inject({ method: 'DELETE', url: '/api/presets/alpha' })
    expect(DeletePresetResponseSchema.parse(deleted.json())).toEqual({ name: 'alpha', deleted: true })
  })

  it('answers 409 on a duplicate create and 404 on missing presets', async () => {
    await inject({ method: 'POST', url: API_ROUTES.presets, payload: body })
    const duplicate = await inject({ method: 'POST', url: API_ROUTES.presets, payload: body })
    expect(duplicate.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(duplicate.json()).code).toBe('conflict')
    for (const method of ['GET', 'DELETE'] as const) {
      expect((await inject({ method, url: '/api/presets/missing' })).statusCode).toBe(404)
    }
    expect((await inject({ method: 'PUT', url: '/api/presets/missing', payload: { preset: { ...body.preset, name: 'missing' } } })).statusCode).toBe(404)
    expect((await inject({ method: 'POST', url: '/api/presets/missing/launch' })).statusCode).toBe(404)
  })

  it('validates bodies and names', async () => {
    const invalid = await inject({ method: 'POST', url: API_ROUTES.presets, payload: { preset: { name: 'x', tabs: [] } } })
    expect(invalid.statusCode).toBe(400)
    expect(ApiErrorSchema.parse(invalid.json()).code).toBe('validation_failed')
    expect((await inject({ method: 'POST', url: API_ROUTES.presets, payload: { preset: { ...body.preset, name: '../evil' } } })).statusCode).toBe(400)
    expect((await inject({ method: 'GET', url: '/api/presets/..%2Fevil' })).statusCode).toBe(400)
    expect((await inject({ method: 'PUT', url: '/api/presets/other', payload: body })).statusCode).toBe(400)
  })

  it('launches a preset and returns the tabs', async () => {
    await inject({ method: 'POST', url: API_ROUTES.presets, payload: body })
    const response = await inject({ method: 'POST', url: '/api/presets/alpha/launch' })
    expect(response.statusCode).toBe(201)
    expect(LaunchPresetResponseSchema.parse(response.json()).tabs[0]?.panes.map(pane => pane.sessionId)).toEqual(['s1', 's2'])
  })

  it('applies the token and Origin rules to every mutation', async () => {
    for (const [method, url] of [['POST', API_ROUTES.presets], ['PUT', '/api/presets/alpha'], ['DELETE', '/api/presets/alpha'], ['POST', '/api/presets/alpha/launch']] as const) {
      const noToken = await inject({ method, url, payload: body, headers: { [SESSION_TOKEN_HEADER]: 'wrong' } })
      expect(noToken.statusCode).toBe(401)
      const noOrigin = await app.inject({ method, url, payload: body, headers: { host: local.host, 'x-paneful-key': TOKEN, [SESSION_TOKEN_HEADER]: TOKEN } })
      expect(noOrigin.statusCode).toBe(401)
      const badOrigin = await inject({ method, url, payload: body, headers: { origin: 'http://evil.example' } })
      expect(badOrigin.statusCode).toBe(403)
    }
    expect((await inject({ method: 'GET', url: API_ROUTES.presets, headers: { host: 'evil.example' } })).statusCode).toBe(403)
  })
})
