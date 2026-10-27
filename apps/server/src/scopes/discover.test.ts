import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

  it('skips prunable and bare worktrees and survives git failures', async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: `worktree ${repo}\nHEAD a\nbranch refs/heads/main\n\nworktree /gone\nHEAD b\ndetached\nprunable x\n`,
    })
    const scopes = await discoverScopes({ config: { projects: [repo] }, env: {}, run })
    expect(run).toHaveBeenCalledWith('git', ['-C', repo, 'worktree', 'list', '--porcelain'])
    expect(scopes.map(s => s.kind)).toEqual(['global', 'project'])
    const failing = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await discoverScopes({ config: { projects: [repo] }, env: {}, run: failing })).toHaveLength(2)
  })
})
