import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API_ROUTES, DEFAULT_CONFIG, GetConfigResponseSchema, PatchConfigResponseSchema } from '@paneful-manager/shared'
import type { FastifyInstance } from 'fastify'
import { pino } from 'pino'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { AppError } from '../errors.js'
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
      host: `127.0.0.1:${DEFAULT_CONFIG.port}`,
      origin: `http://127.0.0.1:${DEFAULT_CONFIG.port}`,
      'x-paneful-key': TOKEN, 'x-paneful-token': TOKEN,
    },
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-config-'))
  await mkdir(dir, { recursive: true })
  file = join(dir, 'config.yaml')
  store = createConfigStore(DEFAULT_CONFIG, { file })
  app = buildApp({ config: DEFAULT_CONFIG, logger: pino({ level: 'silent' }), sessionToken: TOKEN, accessKey: TOKEN, dev: false, configStore: store })
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
      headers: { host: `127.0.0.1:${DEFAULT_CONFIG.port}`, 'x-paneful-key': TOKEN, 'x-paneful-token': TOKEN },
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

  it('keeps a symlinked config file a symlink', async () => {
    const real = join(dir, 'real.yaml')
    await writeFile(real, 'foo: bar\n')
    await symlink(real, file)
    await patch({ confirmCloseTab: false })
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(parse(await readFile(real, 'utf8'))).toMatchObject({ foo: 'bar', confirmCloseTab: false })
  })

  it('replaces a non-map experimental value', async () => {
    await writeFile(file, 'experimental: nope\n')
    expect((await patch({ experimental: { agentTeams: true } })).statusCode).toBe(200)
    expect(parse(await readFile(file, 'utf8'))).toMatchObject({ experimental: { agentTeams: true } })
  })

  it('answers 409 for a non-map root', async () => {
    await writeFile(file, '- a\n- b\n')
    const response = await patch({ confirmCloseTab: false })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ message: 'config.yaml has an unexpected structure' })
    expect(store.get().confirmCloseTab).toBe(true)
  })

  it('rejects a patch the validator refuses and writes nothing', async () => {
    const guarded = createConfigStore(DEFAULT_CONFIG, { file, validate: async () => { throw new AppError('overlap', 400, 'bad_request') } })
    await expect(guarded.patch({ projects: ['/x'] })).rejects.toThrow('overlap')
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it('flags a changed port as restartRequired', async () => {
    const response = await patch({ port: DEFAULT_CONFIG.port + 1 })
    expect(PatchConfigResponseSchema.parse(response.json()).restartRequired).toBe(true)
    expect(PatchConfigResponseSchema.parse((await patch({ port: DEFAULT_CONFIG.port })).json()).restartRequired).toBe(false)
  })
})
