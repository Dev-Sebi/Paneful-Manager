import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { discoverScopes } from './discover.js'

let root: string
let repo: string
let worktree: string
let plain: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' })
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'scopes-')))
  repo = join(root, 'repo')
  worktree = join(root, 'repo-wt')
  plain = join(root, 'plain')
  mkdirSync(repo)
  mkdirSync(plain)
  git(repo, 'init', '-b', 'main')
  git(repo, 'commit', '--allow-empty', '-m', 'init')
  git(repo, 'worktree', 'add', '-b', 'feature', worktree)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('discoverScopes', () => {
  it('finds global, project and extra worktrees of a git repo', async () => {
    const scopes = await discoverScopes({ config: { projects: [repo, repo] }, env: {} })
    expect(scopes).toEqual([
      { kind: 'global', path: join(homedir(), '.claude') },
      { kind: 'project', path: repo },
      { kind: 'worktree', path: worktree, branch: 'feature', projectPath: repo },
    ])
  })

  it('emits worktrees without branch when detached', async () => {
    const detached = join(root, 'detached')
    git(repo, 'worktree', 'add', '--detach', detached)
    const scopes = await discoverScopes({ config: { projects: [repo] }, env: {} })
    expect(scopes).toContainEqual({ kind: 'worktree', path: detached, projectPath: repo })
  })

  it('returns only the project scope for a non-git directory', async () => {
    const warn = vi.fn()
    const scopes = await discoverScopes({ config: { projects: [plain] }, env: {}, logger: { warn, info: vi.fn() } })
    expect(scopes.slice(1)).toEqual([{ kind: 'project', path: plain }])
  })

  it('skips and warns about missing directories', async () => {
    const warn = vi.fn()
    const scopes = await discoverScopes({
      config: { projects: [join(root, 'missing')] },
      env: {},
      logger: { warn, info: vi.fn() },
    })
    expect(scopes).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })

  it('honors CLAUDE_CONFIG_DIR', async () => {
    const scopes = await discoverScopes({ config: { projects: [] }, env: { CLAUDE_CONFIG_DIR: join(root, 'cfg') } })
    expect(scopes).toEqual([{ kind: 'global', path: join(root, 'cfg') }])
  })

  it('skips prunable worktrees and logs them', async () => {
    const info = vi.fn()
    const run = vi.fn().mockResolvedValue({
      stdout: `worktree ${repo}\0HEAD a\0branch refs/heads/main\0\0worktree /gone\0HEAD b\0detached\0prunable x\0\0`,
    })
    const scopes = await discoverScopes({ config: { projects: [repo] }, env: {}, run, logger: { warn: vi.fn(), info } })
    expect(run).toHaveBeenCalledWith('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'])
    expect(scopes.map(s => s.kind)).toEqual(['global', 'project'])
    expect(info).toHaveBeenCalledWith({ projectPath: repo, worktree: '/gone' }, 'Skipping prunable worktree')
  })

  it('skips bare entries', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: `worktree ${repo}\0HEAD a\0\0worktree /bare\0bare\0\0` })
    expect(await discoverScopes({ config: { projects: [repo] }, env: {}, run })).toHaveLength(2)
  })

  it('logs a warning and keeps the project when git fails', async () => {
    const warn = vi.fn()
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const scopes = await discoverScopes({ config: { projects: [repo] }, env: {}, run, logger: { warn, info: vi.fn() } })
    expect(scopes).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ projectPath: repo }), 'Could not list git worktrees')
  })

  it('resolves symlinked project paths and dedupes them', async () => {
    const link = join(root, 'repo-link')
    symlinkSync(repo, link)
    const scopes = await discoverScopes({ config: { projects: [link, repo] }, env: {} })
    expect(scopes.filter(s => s.kind === 'project')).toEqual([{ kind: 'project', path: repo }])
    expect(scopes).toContainEqual({ kind: 'worktree', path: worktree, branch: 'feature', projectPath: repo })
  })

  it('lists sibling worktrees when a linked worktree is configured as project', async () => {
    const scopes = await discoverScopes({ config: { projects: [worktree] }, env: {} })
    expect(scopes.filter(s => s.kind === 'worktree').map(s => s.path)).not.toContain(worktree)
    expect(scopes).toContainEqual({ kind: 'project', path: worktree })
  })

  it('ignores GIT_DIR from the server environment', async () => {
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(plain, 'nonexistent')
    try {
      const scopes = await discoverScopes({ config: { projects: [repo] }, env: {} })
      expect(scopes).toContainEqual({ kind: 'worktree', path: worktree, branch: 'feature', projectPath: repo })
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_DIR
      } else {
        process.env.GIT_DIR = previous
      }
    }
  })
})
