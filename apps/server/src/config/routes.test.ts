import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_ROUTES, DEFAULT_CONFIG, GetConfigResponseSchema, PatchConfigResponseSchema } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createConfigStore, type ConfigStore } from './store.js'

const TOKEN = 'test-token'
let dir: string
let file: string
let store: ConfigStore
let app: FastifyInstance

function patch(payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: API_ROUTES.config,
    payload: payload as object,
    headers: {
      host: `localhost:${DEFAULT_CONFIG.port}`,
      origin: `http://localhost:${DEFAULT_CONFIG.port}`,
      'x-agent-hub-token': TOKEN,
    },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ah-config-'))
  await mkdir(dir, { recursive: true })
  file = join(dir, 'config.yaml')
  store = createConfigStore(DEFAULT_CONFIG, file)
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, dev: false, configStore: store })
})

afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

describe('config routes', () => {
  it('returns the current config', async () => {
    const response = await app.inject({
      method: 'GET',
      url: API_ROUTES.config,
      headers: { host: `localhost:${DEFAULT_CONFIG.port}`, 'x-agent-hub-token': TOKEN },
    })
    expect(GetConfigResponseSchema.parse(response.json()).config.confirmCloseTab).toBe(true)
  })

  it('persists a patch and applies it to the running config', async () => {
    const seen: boolean[] = []
    store.onChange(config => seen.push(config.confirmCloseTab))
    const response = await patch({ confirmCloseTab: false })
    expect(response.statusCode).toBe(200)
    const body = PatchConfigResponseSchema.parse(response.json())
    expect(body).toMatchObject({ restartRequired: false, config: { confirmCloseTab: false } })
    expect(store.get().confirmCloseTab).toBe(false)
    expect(seen).toEqual([false])
    expect(parse(await readFile(file, 'utf8'))).toMatchObject({ confirmCloseTab: false })
  })

  it('preserves unknown keys and comments', async () => {
    await writeFile(file, '# my config\nfoo: bar\nexperimental:\n  other: 1\n')
    await patch({ confirmCloseTab: false, experimental: { agentTeams: true } })
    const text = await readFile(file, 'utf8')
    expect(text).toContain('# my config')
    expect(parse(text)).toMatchObject({ foo: 'bar', confirmCloseTab: false, experimental: { other: 1, agentTeams: true } })
  })

  it('rejects an invalid patch with 400 and leaves the file untouched', async () => {
    const response = await patch({ port: 'nope' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ code: 'validation_failed' })
    expect((await patch({ unknown: true })).statusCode).toBe(400)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('flags a changed port as restartRequired', async () => {
    const response = await patch({ port: DEFAULT_CONFIG.port + 1 })
    expect(PatchConfigResponseSchema.parse(response.json()).restartRequired).toBe(true)
    expect((PatchConfigResponseSchema.parse((await patch({ port: DEFAULT_CONFIG.port + 1 })).json())).restartRequired).toBe(false)
  })
})
