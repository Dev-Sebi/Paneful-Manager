import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  API_ROUTES,
  ApiErrorSchema,
  DEFAULT_CONFIG,
  WorktreeCopyApplyResponseSchema,
  WorktreeCopyPlanResponseSchema,
  WorktreeDiffResponseSchema,
  type Scope,
} from '@paneful-manager/shared'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { createBackupStore } from '../files/backups.js'
import { sha256 } from '../files/read.js'
import { matchesCopyPattern } from './candidates.js'

const TOKEN = 'worktree-token'
const PORT = DEFAULT_CONFIG.port

let base: string
let main: string
let wt: string
let backupDir: string
let app: FastifyInstance

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
}

function write(root: string, rel: string, content: string | Buffer): void {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), content)
}

function send(options: InjectOptions) {
  return app.inject({
    ...options,
    headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'x-paneful-key': TOKEN, 'x-paneful-token': TOKEN, ...options.headers },
  })
}

const plan = async () => WorktreeCopyPlanResponseSchema.parse((await send({ method: 'POST', url: API_ROUTES.worktreeCopyPlan, payload: { worktreePath: wt } })).json())
const hashOf = (text: string): string => sha256(text)
const apply = (files: { relPath: string; overwrite?: boolean; expectedHash: string }[]) =>
  send({
    method: 'POST',
    url: API_ROUTES.worktreeCopyApply,
    payload: { worktreePath: wt, files: files.map(file => ({ overwrite: false, ...file })) },
  })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'paneful-manager-wt-')))
  main = join(base, 'main')
  wt = join(base, 'wt')
  backupDir = join(base, 'backups')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  write(main, '.gitignore', '.env\n.env.*\n.claude/settings.local.json\nnode_modules/\nbig.local\nlink.local\nbin.local\n.claude/worktrees/\n')
  write(main, 'README.md', 'readme')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
  write(main, '.env', 'KEY=1\n')
  write(main, '.env.local', 'LOCAL=1\n')
  write(main, '.claude/settings.local.json', '{"a":1}\n')
  write(main, 'apps/web/.env', 'WEB=1\n')
  write(main, 'node_modules/pkg/.env', 'NO=1\n')
  write(main, '.claude/worktrees/other/.env', 'NO=1\n')
  write(main, 'big.local', Buffer.alloc(1024 * 1024 + 1, 97))
  write(main, 'bin.local', Buffer.from([0, 1, 2, 3]))
  write(main, 'target.txt', 'secret')
  symlinkSync(join(main, 'target.txt'), join(main, 'link.local'))
  chmodSync(join(main, '.env'), 0o600)
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt)
  const scopes: Scope[] = [
    { kind: 'project', path: main },
    { kind: 'worktree', path: wt, branch: 'feature', projectPath: main },
  ]
  app = buildApp({
    config: DEFAULT_CONFIG,
    logger: pino({ level: 'silent' }),
    sessionToken: TOKEN,
    accessKey: TOKEN,
    dev: false,
    worktrees: { getScopes: async () => scopes, backups: createBackupStore({ dir: backupDir }) },
  })
})

afterEach(async () => {
  await app.close()
  rmSync(base, { recursive: true, force: true })
})

describe('copy patterns', () => {
  it('matches names at any depth and whole paths with a slash', () => {
    expect(matchesCopyPattern('apps/web/.env.production')).toBe(true)
    expect(matchesCopyPattern('x.local')).toBe(true)
    expect(matchesCopyPattern('.claude/settings.local.json')).toBe(true)
    expect(matchesCopyPattern('.claude/a.local.md')).toBe(true)
    expect(matchesCopyPattern('src/.claude/settings.local.json')).toBe(false)
    expect(matchesCopyPattern('env')).toBe(false)
  })
})

describe('copy plan', () => {
  it('lists candidates and skipped files with reasons', async () => {
    const result = await plan()
    expect(result.projectPath).toBe(main)
    expect(result.worktreePath).toBe(wt)
    expect(result.candidates.map(c => c.relPath)).toEqual(['.claude/settings.local.json', '.env', '.env.local', 'apps/web/.env'])
    expect(result.candidates.every(c => !c.existsInWorktree && !c.identical && c.worktreeHash === undefined)).toBe(true)
    expect(result.candidates.find(c => c.relPath === '.env')).toMatchObject({ size: 6, hash: hashOf('KEY=1\n') })
    expect(result.skipped).toEqual([
      { relPath: 'big.local', reason: 'too-large' },
      { relPath: 'bin.local', reason: 'binary' },
      { relPath: 'link.local', reason: 'symlink' },
    ])
  })

  it('reports existing and identical counterparts', async () => {
    write(wt, '.env', 'OLD=1\n')
    write(wt, '.env.local', 'LOCAL=1\n')
    const result = await plan()
    expect(result.candidates.find(c => c.relPath === '.env')).toMatchObject({ existsInWorktree: true, worktreeHash: hashOf('OLD=1\n'), identical: false })
    expect(result.candidates.find(c => c.relPath === '.env.local')).toMatchObject({ existsInWorktree: true, identical: true })
  })

  it('skips a worktree counterpart that is a symlink', async () => {
    symlinkSync(join(main, 'target.txt'), join(wt, '.env'))
    const result = await plan()
    expect(result.skipped).toContainEqual({ relPath: '.env', reason: 'worktree-symlink' })
  })

  it('answers 404 for unknown worktrees and 400 for bad bodies', async () => {
    const unknown = await send({ method: 'POST', url: API_ROUTES.worktreeCopyPlan, payload: { worktreePath: main } })
    expect(unknown.statusCode).toBe(404)
    expect((await send({ method: 'POST', url: API_ROUTES.worktreeCopyPlan, payload: {} })).statusCode).toBe(400)
  })

  it('requires the session token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: API_ROUTES.worktreeCopyPlan,
      headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` },
      payload: { worktreePath: wt },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('copy apply', () => {
  it('copies files, creates directories and keeps the mode', async () => {
    const response = await apply([
      { relPath: '.env', expectedHash: hashOf('KEY=1\n') },
      { relPath: 'apps/web/.env', expectedHash: hashOf('WEB=1\n') },
    ])
    expect(response.statusCode).toBe(200)
    expect(WorktreeCopyApplyResponseSchema.parse(response.json())).toEqual({ copied: ['.env', 'apps/web/.env'], skipped: [] })
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('KEY=1\n')
    expect(readFileSync(join(wt, 'apps/web/.env'), 'utf8')).toBe('WEB=1\n')
    expect(statSync(join(wt, '.env')).mode & 0o777).toBe(0o600)
    expect(readdirSync(wt).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to overwrite without the flag', async () => {
    write(wt, '.env', 'OLD=1\n')
    const response = await apply([{ relPath: '.env', expectedHash: hashOf('KEY=1\n') }])
    expect(WorktreeCopyApplyResponseSchema.parse(response.json())).toEqual({ copied: [], skipped: [{ relPath: '.env', reason: 'exists' }] })
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('OLD=1\n')
  })

  it('skips identical files even when overwrite is set', async () => {
    write(wt, '.env', 'KEY=1\n')
    const response = await apply([{ relPath: '.env', overwrite: true, expectedHash: hashOf('KEY=1\n') }])
    expect(WorktreeCopyApplyResponseSchema.parse(response.json()).skipped).toEqual([{ relPath: '.env', reason: 'identical' }])
  })

  it('overwrites with a backup when flagged', async () => {
    write(wt, '.env', 'OLD=1\n')
    const response = await apply([{ relPath: '.env', overwrite: true, expectedHash: hashOf('KEY=1\n') }])
    expect(WorktreeCopyApplyResponseSchema.parse(response.json()).copied).toEqual(['.env'])
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('KEY=1\n')
    const dirs = readdirSync(backupDir)
    expect(dirs).toHaveLength(1)
    expect(readFileSync(join(backupDir, dirs[0] ?? '', readdirSync(join(backupDir, dirs[0] ?? ''))[0] ?? ''), 'utf8')).toBe('OLD=1\n')
  })

  it('answers 409 when the main file changed since the plan', async () => {
    const response = await apply([{ relPath: '.env', expectedHash: hashOf('KEY=1\n') }])
    expect(response.statusCode).toBe(200)
    write(main, '.env.local', 'CHANGED=1\n')
    const stale = await apply([{ relPath: '.env.local', expectedHash: hashOf('LOCAL=1\n') }])
    expect(stale.statusCode).toBe(409)
    expect(ApiErrorSchema.parse(stale.json())).toMatchObject({ code: 'conflict', details: { currentHash: hashOf('CHANGED=1\n') } })
    expect(existsSync(join(wt, '.env.local'))).toBe(false)
  })

  it('answers 403 for traversal and non-candidates, writing nothing', async () => {
    for (const relPath of ['../x', '/etc/passwd', 'a/../.env', 'README.md', 'link.local', 'node_modules/pkg/.env']) {
      const response = await apply([{ relPath, expectedHash: hashOf('x') }])
      expect(response.statusCode, relPath).toBe(403)
      expect(ApiErrorSchema.parse(response.json()).code).toBe('forbidden')
    }
    expect(existsSync(join(base, 'x'))).toBe(false)
  })

  it('answers 403 when the worktree target or a parent is a symlink', async () => {
    symlinkSync(join(main, 'target.txt'), join(wt, '.env'))
    const direct = await apply([{ relPath: '.env', overwrite: true, expectedHash: hashOf('KEY=1\n') }])
    expect(direct.statusCode).toBe(403)
    expect(readFileSync(join(main, 'target.txt'), 'utf8')).toBe('secret')

    mkdirSync(join(base, 'outside'))
    symlinkSync(join(base, 'outside'), join(wt, 'apps'))
    const parent = await apply([{ relPath: 'apps/web/.env', expectedHash: hashOf('WEB=1\n') }])
    expect(parent.statusCode).toBe(403)
    expect(readdirSync(join(base, 'outside'))).toEqual([])
  })

  it('rejects duplicates and an empty list', async () => {
    const file = { relPath: '.env', expectedHash: hashOf('KEY=1\n') }
    expect((await apply([file, file])).statusCode).toBe(400)
    expect((await apply([])).statusCode).toBe(400)
  })
})

describe('diff', () => {
  const diff = (relPath: string) => send({ method: 'POST', url: API_ROUTES.worktreeDiff, payload: { worktreePath: wt, relPath } })

  it('returns both sides', async () => {
    write(wt, '.env', 'OLD=1\n')
    const body = WorktreeDiffResponseSchema.parse((await diff('.env')).json())
    expect(body).toEqual({ relPath: '.env', main: 'KEY=1\n', worktree: 'OLD=1\n', binaryOrTooLarge: false })
    expect(WorktreeDiffResponseSchema.parse((await diff('.env.local')).json())).toMatchObject({ worktree: null, binaryOrTooLarge: false })
  })

  it('withholds binary content', async () => {
    write(wt, '.env', Buffer.from([0, 1, 2]))
    expect(WorktreeDiffResponseSchema.parse((await diff('.env')).json())).toEqual({ relPath: '.env', main: 'KEY=1\n', worktree: null, binaryOrTooLarge: true })
    expect(WorktreeDiffResponseSchema.parse((await diff('bin.local')).json())).toEqual({ relPath: 'bin.local', main: null, worktree: null, binaryOrTooLarge: true })
  })

  it('withholds sides above 256 KiB', async () => {
    write(wt, '.env', 'a'.repeat(256 * 1024 + 1))
    expect(WorktreeDiffResponseSchema.parse((await diff('.env')).json())).toMatchObject({ worktree: null, binaryOrTooLarge: true })
  })

  it('answers 403 for paths that are not candidates', async () => {
    for (const relPath of ['../main/.env', 'README.md', 'link.local']) {
      expect((await diff(relPath)).statusCode, relPath).toBe(403)
    }
  })
})
