import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../process/exec.js'
import { discoverScopes } from '../scopes/discover.js'
import { encodeBackupPath } from './backups.js'
import { createFileService } from './service.js'
import { appError, createSandbox, silentLogger, type Sandbox } from './test-helpers.js'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

let box: Sandbox

beforeEach(() => {
  box = createSandbox()
})

afterEach(async () => {
  await box.cleanup()
})

function backupsOf(path: string): string[] {
  const dir = join(box.state, 'backups', encodeBackupPath(path))
  return existsSync(dir) ? readdirSync(dir).toSorted() : []
}

describe('path checks', () => {
  it('rejects traversal out of the scopes', async () => {
    writeFileSync(join(box.outside, 'CLAUDE.md'), 'secret')
    for (const path of [
      join(box.project, '..', 'outside', 'CLAUDE.md'),
      `${box.project}/.claude/skills/../../../outside/CLAUDE.md`,
      'relative/CLAUDE.md',
    ]) {
      expect((await appError(box.service.read(path))).statusCode).toBe(403)
      expect((await appError(box.service.write({ path, content: 'x' }))).statusCode).toBe(403)
    }
    expect(readFileSync(join(box.outside, 'CLAUDE.md'), 'utf8')).toBe('secret')
  })

  it('rejects non-managed paths inside a scope', async () => {
    mkdirSync(join(box.project, 'src'))
    writeFileSync(join(box.project, 'src', 'index.ts'), 'code')
    for (const path of [
      join(box.project, 'src', 'index.ts'),
      join(box.project, 'README.md'),
      join(box.project, '.claude', 'settings.json'),
      join(box.project, '.claude', 'skills', 'demo', 'image.png'),
      join(box.project, '.claude', 'skills', 'demo', '.hidden.md'),
      join(box.project, '.claude', 'skills', '..', 'CLAUDE.md'),
      join(box.claudeDir, 'CLAUDE.local.md'),
      join(box.claudeDir, 'settings.json'),
    ]) {
      const error = await appError(box.service.write({ path, content: 'x' }))
      expect(error).toMatchObject({ statusCode: 403, code: 'forbidden' })
    }
    expect(readFileSync(join(box.project, 'src', 'index.ts'), 'utf8')).toBe('code')
  })

  it('rejects a skills directory symlinked outside the scopes', async () => {
    mkdirSync(join(box.outside, 'evil'))
    writeFileSync(join(box.outside, 'evil', 'SKILL.md'), 'outside')
    mkdirSync(join(box.claudeDir, 'skills'))
    symlinkSync(join(box.outside, 'evil'), join(box.claudeDir, 'skills', 'evil'))
    const path = join(box.claudeDir, 'skills', 'evil', 'SKILL.md')
    expect((await appError(box.service.read(path))).statusCode).toBe(403)
    expect((await appError(box.service.write({ path, content: 'x', expectedHash: sha('outside') }))).statusCode).toBe(403)
    expect((await appError(box.service.delete(join(box.claudeDir, 'skills', 'evil')))).statusCode).toBe(403)
    expect(readFileSync(join(box.outside, 'evil', 'SKILL.md'), 'utf8')).toBe('outside')
    expect(await box.service.list()).toEqual([])
  })

  it('rejects a file symlink pointing outside the scopes', async () => {
    writeFileSync(join(box.outside, 'target.md'), 'outside')
    symlinkSync(join(box.outside, 'target.md'), join(box.project, 'CLAUDE.md'))
    const path = join(box.project, 'CLAUDE.md')
    expect((await appError(box.service.read(path))).statusCode).toBe(403)
    expect((await appError(box.service.write({ path, content: 'x', expectedHash: sha('outside') }))).statusCode).toBe(403)
    expect(readFileSync(join(box.outside, 'target.md'), 'utf8')).toBe('outside')
  })

  it('writes through a symlink that stays inside and keeps the link', async () => {
    writeFileSync(join(box.project, 'AGENTS.md'), 'shared')
    symlinkSync('AGENTS.md', join(box.project, 'CLAUDE.md'))
    const path = join(box.project, 'CLAUDE.md')
    const read = await box.service.read(path)
    expect(read).toMatchObject({ path, content: 'shared', kind: 'claude-md', hash: sha('shared') })
    await box.service.write({ path, content: 'updated', expectedHash: read.hash })
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path)).toBe('AGENTS.md')
    expect(readFileSync(join(box.project, 'AGENTS.md'), 'utf8')).toBe('updated')
  })

  it('rejects writing through a dangling link', async () => {
    symlinkSync(join(box.project, 'missing.md'), join(box.project, 'CLAUDE.md'))
    expect((await appError(box.service.write({ path: join(box.project, 'CLAUDE.md'), content: 'x' }))).statusCode).toBe(403)
    expect(existsSync(join(box.project, 'missing.md'))).toBe(false)
  })

  it('rejects binary and oversized files', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, Buffer.from([0x23, 0x00, 0x01]))
    expect((await appError(box.service.read(path))).statusCode).toBe(415)
    expect((await appError(box.service.write({ path: join(box.project, 'CLAUDE.local.md'), content: 'a\0b' }))).statusCode).toBe(415)
    expect((await appError(box.service.write({ path: join(box.project, 'CLAUDE.local.md'), content: 'x'.repeat(1024 * 1024 + 1) }))).statusCode).toBe(413)
  })
})

describe('list and read', () => {
  it('lists managed files of every scope with hashes', async () => {
    writeFileSync(join(box.claudeDir, 'CLAUDE.md'), 'global')
    mkdirSync(join(box.claudeDir, 'skills', 'review', 'scripts'), { recursive: true })
    writeFileSync(join(box.claudeDir, 'skills', 'review', 'SKILL.md'), 'skill')
    writeFileSync(join(box.claudeDir, 'skills', 'review', 'scripts', 'run.sh'), 'echo')
    writeFileSync(join(box.claudeDir, 'skills', 'review', 'logo.png'), 'png')
    writeFileSync(join(box.project, 'CLAUDE.local.md'), 'local')
    writeFileSync(join(box.project, 'other.md'), 'ignored')
    const files = await box.service.list()
    expect(files.map(file => [file.scope.kind, file.kind, file.relPath, file.name])).toEqual([
      ['global', 'claude-md', 'CLAUDE.md', 'CLAUDE.md'],
      ['global', 'skill', 'skills/review/SKILL.md', 'review'],
      ['global', 'skill', 'skills/review/scripts/run.sh', 'review'],
      ['project', 'claude-local-md', 'CLAUDE.local.md', 'CLAUDE.local.md'],
    ])
    expect(files[0]).toMatchObject({ path: join(box.claudeDir, 'CLAUDE.md'), size: 6, hash: sha('global') })
    expect(await box.service.list({ scopeKind: 'project' })).toHaveLength(1)
    expect(await box.service.list({ scopePath: box.claudeDir })).toHaveLength(3)
  })

  it('answers 404 for a missing managed file', async () => {
    expect((await appError(box.service.read(join(box.project, 'CLAUDE.md')))).statusCode).toBe(404)
  })
})

describe('create', () => {
  it('creates a skill from the template', async () => {
    const file = await box.service.create({ scopePath: box.project, kind: 'skill', name: 'my-skill' })
    expect(file).toMatchObject({
      kind: 'skill',
      name: 'my-skill',
      relPath: '.claude/skills/my-skill/SKILL.md',
      path: join(box.project, '.claude', 'skills', 'my-skill', 'SKILL.md'),
    })
    expect(file.content).toMatch(/^---\nname: my-skill\ndescription: .+\n---\n/)
    expect(file.hash).toBe(sha(file.content))
    const again = await appError(box.service.create({ scopePath: box.project, kind: 'skill', name: 'my-skill' }))
    expect(again.statusCode).toBe(409)
  })

  it('creates an empty CLAUDE.md and refuses to overwrite it', async () => {
    const file = await box.service.create({ scopePath: box.claudeDir, kind: 'claude-md' })
    expect(file).toMatchObject({ content: '', scope: { kind: 'global' } })
    const error = await appError(box.service.create({ scopePath: box.claudeDir, kind: 'claude-md' }))
    expect(error).toMatchObject({ statusCode: 409, code: 'conflict', details: { currentHash: sha('') } })
  })

  it('rejects unknown scopes', async () => {
    expect((await appError(box.service.create({ scopePath: box.outside, kind: 'claude-md' }))).statusCode).toBe(404)
  })
})

describe('write', () => {
  it('rejects a wrong expectedHash with 409 and leaves the file unchanged', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'original')
    const error = await appError(box.service.write({ path, content: 'new', expectedHash: sha('something else') }))
    expect(error).toMatchObject({ statusCode: 409, code: 'conflict', details: { currentHash: sha('original') } })
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(backupsOf(path)).toEqual([])
  })

  it('never overwrites an existing file without expectedHash', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'original')
    expect((await appError(box.service.write({ path, content: 'new' }))).statusCode).toBe(409)
    expect(readFileSync(path, 'utf8')).toBe('original')
  })

  it('reports a conflict when the file was deleted meanwhile', async () => {
    const error = await appError(box.service.write({ path: join(box.project, 'CLAUDE.md'), content: 'x', expectedHash: sha('a') }))
    expect(error).toMatchObject({ statusCode: 409, details: { currentHash: null } })
  })

  it('lets only the first of two writes based on the same hash win', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'base')
    const results = await Promise.allSettled([
      box.service.write({ path, content: 'first', expectedHash: sha('base') }),
      box.service.write({ path, content: 'second', expectedHash: sha('base') }),
    ])
    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { statusCode: 409, details: { currentHash: sha('first') } } })
    expect(readFileSync(path, 'utf8')).toBe('first')
  })

  it('preserves the file mode and creates missing skill subdirectories', async () => {
    mkdirSync(join(box.claudeDir, 'skills', 'tool'), { recursive: true })
    const script = join(box.claudeDir, 'skills', 'tool', 'run.sh')
    writeFileSync(script, 'echo 1')
    chmodSync(script, 0o750)
    const entry = await box.service.write({ path: script, content: 'echo 2', expectedHash: sha('echo 1') })
    expect(entry).toMatchObject({ kind: 'skill', name: 'tool', hash: sha('echo 2') })
    expect(statSync(script).mode & 0o777).toBe(0o750)
    const nested = join(box.claudeDir, 'skills', 'tool', 'lib', 'helper.py')
    await box.service.write({ path: nested, content: 'print(1)' })
    expect(readFileSync(nested, 'utf8')).toBe('print(1)')
    expect(readdirSync(join(box.claudeDir, 'skills', 'tool')).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('backs up the previous content with mode 0600 before overwriting', async () => {
    const path = join(box.project, 'CLAUDE.md')
    writeFileSync(path, 'v0')
    await box.service.write({ path, content: 'v1', expectedHash: sha('v0') })
    const backups = backupsOf(path)
    expect(backups).toHaveLength(1)
    const backup = join(box.state, 'backups', encodeBackupPath(path), backups[0] ?? '')
    expect(readFileSync(backup, 'utf8')).toBe('v0')
    expect(statSync(backup).mode & 0o777).toBe(0o600)
  })

  it('keeps the last 20 backups per file', async () => {
    const path = join(box.project, 'CLAUDE.md')
    let content = 'v0'
    writeFileSync(path, content)
    for (let index = 1; index <= 21; index++) {
      const next = `v${index}`
      await box.service.write({ path, content: next, expectedHash: sha(content) })
      content = next
    }
    const backups = backupsOf(path)
    expect(backups).toHaveLength(20)
    const dir = join(box.state, 'backups', encodeBackupPath(path))
    expect(backups.map(name => readFileSync(join(dir, name), 'utf8'))).toEqual(Array.from({ length: 20 }, (_, index) => `v${index + 1}`))
  })
})

describe('delete', () => {
  it('backs up and deletes a managed file', async () => {
    const path = join(box.project, 'CLAUDE.local.md')
    writeFileSync(path, 'bye')
    await box.service.delete(path)
    expect(existsSync(path)).toBe(false)
    expect(backupsOf(path)).toHaveLength(1)
    expect((await appError(box.service.delete(path))).statusCode).toBe(404)
  })

  it('deletes a skill directory after backing up every file', async () => {
    await box.service.create({ scopePath: box.project, kind: 'skill', name: 'gone' })
    const dir = join(box.project, '.claude', 'skills', 'gone')
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'notes.txt'), 'notes')
    await box.service.delete(dir)
    expect(existsSync(dir)).toBe(false)
    expect(backupsOf(join(dir, 'SKILL.md'))).toHaveLength(1)
    expect(backupsOf(join(dir, 'docs', 'notes.txt'))).toHaveLength(1)
  })

  it('refuses to delete a skill directory with unmanaged files', async () => {
    await box.service.create({ scopePath: box.project, kind: 'skill', name: 'mixed' })
    const dir = join(box.project, '.claude', 'skills', 'mixed')
    writeFileSync(join(dir, 'image.png'), 'png')
    const error = await appError(box.service.delete(dir))
    expect(error).toMatchObject({ statusCode: 409, code: 'conflict', details: { blocked: ['image.png'] } })
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
    expect(backupsOf(join(dir, 'SKILL.md'))).toEqual([])
  })

  it('removes only the link of a symlinked skill directory inside the scopes', async () => {
    const shared = join(box.project, 'shared-skill')
    mkdirSync(shared)
    writeFileSync(join(shared, 'SKILL.md'), 'shared')
    mkdirSync(join(box.project, '.claude', 'skills'), { recursive: true })
    const link = join(box.project, '.claude', 'skills', 'linked')
    symlinkSync(shared, link)
    expect((await box.service.read(join(link, 'SKILL.md'))).content).toBe('shared')
    await box.service.delete(link)
    expect(existsSync(link)).toBe(false)
    expect(readFileSync(join(shared, 'SKILL.md'), 'utf8')).toBe('shared')
  })

  it('rejects deleting non-managed paths', async () => {
    writeFileSync(join(box.project, 'package.json'), '{}')
    expect((await appError(box.service.delete(join(box.project, 'package.json')))).statusCode).toBe(403)
    expect((await appError(box.service.delete(join(box.project, '.claude')))).statusCode).toBe(403)
    expect(existsSync(join(box.project, 'package.json'))).toBe(true)
  })
})

describe('worktree scopes', () => {
  it('manages files of a git worktree nested inside its project', async () => {
    const git = (args: string[]) => run('git', ['-c', 'commit.gpgsign=false', '-C', box.project, ...args], {
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
      env: { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    })
    await git(['init', '-q', '-b', 'main'])
    await git(['commit', '-q', '--allow-empty', '-m', 'init'])
    const worktree = join(box.project, '.claude', 'worktrees', 'feature')
    await git(['worktree', 'add', '-q', '-b', 'feature', worktree])
    const scopes = await discoverScopes({
      config: { ...DEFAULT_CONFIG, projects: [box.project] },
      env: { CLAUDE_CONFIG_DIR: box.claudeDir },
    })
    expect(scopes.map(scope => scope.kind)).toEqual(['global', 'project', 'worktree'])
    const service = createFileService({ getScopes: async () => scopes, backupDir: join(box.state, 'backups'), logger: silentLogger })
    const created = await service.create({ scopePath: worktree, kind: 'claude-md' })
    expect(created).toMatchObject({ scope: { kind: 'worktree' }, relPath: 'CLAUDE.md' })
    await service.create({ scopePath: worktree, kind: 'skill', name: 'wt-skill' })
    const projectFiles = await service.list({ scopeKind: 'project' })
    expect(projectFiles).toEqual([])
    const worktreeFiles = await service.list({ scopeKind: 'worktree' })
    expect(worktreeFiles.map(file => file.relPath)).toEqual(['CLAUDE.md', '.claude/skills/wt-skill/SKILL.md'])
    await service.close()
  })
})
