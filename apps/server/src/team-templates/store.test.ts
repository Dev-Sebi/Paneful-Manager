import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamTemplateSchema, type TeamTemplate } from '@agent-hub/shared'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createTeamTemplateStore, type TeamTemplateStore } from './store.js'

let root: string
let dir: string
let store: TeamTemplateStore

function template(name: string, extra: Record<string, unknown> = {}): TeamTemplate {
  return TeamTemplateSchema.parse({ name, experimental: true, lead: { cwd: '/work' }, teammates: [{ name: 'tester', prompt: 'Test it' }], ...extra })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ah-team-templates-'))
  dir = join(root, 'teams')
  store = createTeamTemplateStore({ dir, logger: pino({ level: 'silent' }) })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('team template store', () => {
  it('creates, lists, updates and deletes templates as compact YAML', async () => {
    await store.create(template('alpha'))
    const text = await readFile(join(dir, 'alpha.yaml'), 'utf8')
    expect(parse(text)).toEqual({ name: 'alpha', experimental: true, lead: { cwd: '/work', command: 'claude' }, teammates: [{ name: 'tester', prompt: 'Test it' }] })
    await store.update('alpha', template('alpha', { env: { DISABLE_TELEMETRY: '1' }, lead: { cwd: '/work', args: ['--add-dir', '/x'] } }))
    expect(parse(await readFile(join(dir, 'alpha.yaml'), 'utf8'))).toMatchObject({ env: { DISABLE_TELEMETRY: '1' }, lead: { args: ['--add-dir', '/x'] } })
    expect((await store.list()).map(item => item.name)).toEqual(['alpha'])
    await store.remove('alpha')
    await expect(store.get('alpha')).rejects.toMatchObject({ statusCode: 404, message: 'Team template alpha not found' })
  })

  it('answers 409 for duplicates and for files with env keys outside the allowlist', async () => {
    await store.create(template('alpha'))
    await expect(store.create(template('alpha'))).rejects.toMatchObject({ statusCode: 409 })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'evil.yaml'), 'name: evil\nexperimental: true\nlead: { cwd: /w }\nteammates: [{ name: a, prompt: p }]\nenv: { LD_PRELOAD: /x.so }\n')
    await expect(store.get('evil')).rejects.toMatchObject({ statusCode: 409 })
    expect((await store.list()).map(item => item.name)).toEqual(['alpha'])
  })

  it('rejects traversal names', async () => {
    for (const name of ['../evil', 'a/b', '.hidden']) {
      await expect(store.get(name)).rejects.toThrow()
    }
  })
})
