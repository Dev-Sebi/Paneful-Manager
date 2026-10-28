import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  API_ROUTES,
  ApiErrorSchema,
  CreateFileResponseSchema,
  DEFAULT_CONFIG,
  DeleteFileResponseSchema,
  ListFilesResponseSchema,
  ReadFileResponseSchema,
  WriteFileResponseSchema,
} from '@paneful-manager/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createSandbox, silentLogger, type Sandbox } from './test-helpers.js'

const TOKEN = 'files-route-token'
const PORT = DEFAULT_CONFIG.port
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

let box: Sandbox
let app: FastifyInstance

function send(options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, 'x-paneful-key': TOKEN, 'x-paneful-token': TOKEN, ...options.headers },
  })
}

beforeEach(() => {
  box = createSandbox()
  app = buildApp({ config: DEFAULT_CONFIG, logger: silentLogger, sessionToken: TOKEN, accessKey: TOKEN, dev: false, files: box.service })
})

afterEach(async () => {
  await app.close()
  await box.cleanup()
})

describe('file routes', () => {
  it('creates, lists, reads, writes and deletes a skill', async () => {
    const created = await send({ method: 'POST', url: API_ROUTES.files, payload: { scopePath: box.project, kind: 'skill', name: 'demo' } })
    expect(created.statusCode).toBe(201)
    const file = CreateFileResponseSchema.parse(created.json()).file
    expect(file.relPath).toBe('.claude/skills/demo/SKILL.md')

    const listed = await send({ method: 'GET', url: `${API_ROUTES.files}?scopeKind=project` })
    expect(ListFilesResponseSchema.parse(listed.json()).files.map(entry => entry.path)).toEqual([file.path])

    const read = await send({ method: 'GET', url: API_ROUTES.fileContent, query: { path: file.path } })
    expect(ReadFileResponseSchema.parse(read.json()).file.content).toBe(file.content)

    const written = await send({ method: 'PUT', url: API_ROUTES.fileContent, payload: { path: file.path, content: 'new', expectedHash: file.hash } })
    expect(written.statusCode).toBe(200)
    expect(WriteFileResponseSchema.parse(written.json()).file.hash).toBe(sha('new'))

    const dir = join(box.project, '.claude', 'skills', 'demo')
    const deleted = await send({ method: 'DELETE', url: API_ROUTES.fileContent, query: { path: dir } })
    expect(DeleteFileResponseSchema.parse(deleted.json())).toEqual({ path: dir, deleted: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('answers 409 with the current hash on a stale write', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'current')
    const response = await send({ method: 'PUT', url: API_ROUTES.fileContent, payload: { path, content: 'x', expectedHash: sha('stale') } })
    expect(response.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ code: 'conflict', details: { currentHash: sha('current') } })
    expect(readFileSync(path, 'utf8')).toBe('current')
  })

  it('answers 403 for traversal and non-managed paths', async () => {
    mkdirSync(join(box.project, 'src'))
    for (const path of [join(box.project, 'src', 'index.ts'), `${box.project}/../outside/CLAUDE.md`]) {
      const response = await send({ method: 'PUT', url: API_ROUTES.fileContent, payload: { path, content: 'x' } })
      expect(response.statusCode).toBe(403)
      expect(ApiErrorSchema.parse(response.json()).code).toBe('forbidden')
    }
    expect(existsSync(join(box.project, 'src', 'index.ts'))).toBe(false)
  })

  it('answers 409 with the blocking entries when a skill directory holds stray files', async () => {
    await send({ method: 'POST', url: API_ROUTES.files, payload: { scopePath: box.project, kind: 'skill', name: 'mixed' } })
    const dir = join(box.project, '.claude', 'skills', 'mixed')
    writeFileSync(join(dir, 'blob.bin'), 'x')
    const response = await send({ method: 'DELETE', url: API_ROUTES.fileContent, query: { path: dir } })
    expect(response.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(response.json())).toMatchObject({ details: { blocked: ['blob.bin'] } })
  })

  it('validates bodies and queries at the boundary', async () => {
    const badWrite = await send({ method: 'PUT', url: API_ROUTES.fileContent, payload: { path: join(box.project, 'CLAUDE.md'), content: 'x', force: true } })
    expect(badWrite.statusCode).toBe(400)
    expect(ApiErrorSchema.parse(badWrite.json()).code).toBe('validation_failed')
    const badCreate = await send({ method: 'POST', url: API_ROUTES.files, payload: { scopePath: box.project, kind: 'skill', name: '../x' } })
    expect(badCreate.statusCode).toBe(400)
    const badList = await send({ method: 'GET', url: `${API_ROUTES.files}?scopeKind=team` })
    expect(badList.statusCode).toBe(400)
    const missing = await send({ method: 'GET', url: API_ROUTES.fileContent })
    expect(missing.statusCode).toBe(400)
  })

  it('requires the token and a local Origin for mutations', async () => {
    const payload = { scopePath: box.project, kind: 'claude-md' }
    const noToken = await send({ method: 'POST', url: API_ROUTES.files, payload, headers: { 'x-paneful-token': 'wrong' } })
    expect(noToken.statusCode).toBe(401)
    const foreign = await send({ method: 'POST', url: API_ROUTES.files, payload, headers: { origin: 'http://evil.example' } })
    expect(foreign.statusCode).toBe(403)
    const deleteNoToken = await send({ method: 'DELETE', url: API_ROUTES.fileContent, query: { path: join(box.project, 'CLAUDE.md') }, headers: { 'x-paneful-token': '' } })
    expect(deleteNoToken.statusCode).toBe(401)
    expect(existsSync(join(box.project, 'CLAUDE.md'))).toBe(false)
  })

  it('is not registered without a file service', async () => {
    const bare = buildApp({ config: DEFAULT_CONFIG, logger: silentLogger, sessionToken: TOKEN, accessKey: TOKEN, dev: false })
    const response = await bare.inject({ method: 'GET', url: API_ROUTES.files, headers: { host: `localhost:${PORT}`, 'x-paneful-key': TOKEN } })
    expect(response.statusCode).toBe(404)
    await bare.close()
  })
})
