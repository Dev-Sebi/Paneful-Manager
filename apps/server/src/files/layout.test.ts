import { join } from 'node:path'
import type { Scope } from '@paneful-manager/shared'
import { describe, expect, it } from 'vitest'
import { allowlistRoots, isAllowedSkillFile, isWatchCandidate, matchManagedPath, matchSkillDir } from './layout.js'

const scopes: Scope[] = [
  { kind: 'global', path: '/home/user/.claude' },
  { kind: 'project', path: '/home/user/git/app' },
  { kind: 'worktree', path: '/home/user/git/app/.worktrees/feature', branch: 'feature', projectPath: '/home/user/git/app' },
]

describe('layout', () => {
  it('derives one allowlist root per scope', () => {
    expect(allowlistRoots(scopes)).toEqual(['/home/user/.claude', '/home/user/git/app', '/home/user/git/app/.worktrees/feature'])
  })

  it('classifies managed files per scope kind', () => {
    expect(matchManagedPath(scopes, '/home/user/.claude/CLAUDE.md')).toMatchObject({ kind: 'claude-md', relPath: 'CLAUDE.md' })
    expect(matchManagedPath(scopes, '/home/user/.claude/skills/x/SKILL.md')).toMatchObject({ kind: 'skill', name: 'x' })
    expect(matchManagedPath(scopes, '/home/user/.claude/CLAUDE.local.md')).toBeUndefined()
    expect(matchManagedPath(scopes, '/home/user/.claude/.claude/skills/x/SKILL.md')).toBeUndefined()
    expect(matchManagedPath(scopes, '/home/user/git/app/CLAUDE.local.md')).toMatchObject({ kind: 'claude-local-md' })
    expect(matchManagedPath(scopes, '/home/user/git/app/.claude/skills/x/a/b.yaml')).toMatchObject({ kind: 'skill', relPath: '.claude/skills/x/a/b.yaml' })
    expect(matchManagedPath(scopes, '/home/user/git/app/src/index.ts')).toBeUndefined()
    expect(matchManagedPath(scopes, '/home/user/git/app/.claude/skills/SKILL.md')).toBeUndefined()
    expect(matchManagedPath(scopes, '/home/user/git/app/.claude/skills/.x/SKILL.md')).toBeUndefined()
  })

  it('assigns files of a nested worktree to the worktree', () => {
    const match = matchManagedPath(scopes, '/home/user/git/app/.worktrees/feature/CLAUDE.md')
    expect(match?.scope.kind).toBe('worktree')
    expect(matchManagedPath(scopes, '/home/user/git/app/.worktrees/CLAUDE.md')).toBeUndefined()
  })

  it('allows only text extensions, no hidden parts and bounded depth in skills', () => {
    expect(isAllowedSkillFile(['SKILL.md'])).toBe(true)
    for (const name of ['a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.sh', 'a.py', 'a.ts', 'a.js', 'A.MD']) {
      expect(isAllowedSkillFile([name])).toBe(true)
    }
    for (const segments of [['a.png'], ['a'], ['.env.md'], ['.git', 'a.md'], ['node_modules', 'a.js'], ['1', '2', '3', '4', '5', 'a.md'], []]) {
      expect(isAllowedSkillFile(segments)).toBe(false)
    }
  })

  it('matches skill directories exactly', () => {
    expect(matchSkillDir(scopes, '/home/user/git/app/.claude/skills/x')).toMatchObject({ name: 'x', relPath: '.claude/skills/x' })
    expect(matchSkillDir(scopes, '/home/user/git/app/.claude/skills')).toBeUndefined()
    expect(matchSkillDir(scopes, '/home/user/git/app/.claude/skills/x/sub')).toBeUndefined()
  })

  it('limits the watcher to managed paths and their parents', () => {
    const app = '/home/user/git/app'
    for (const path of [app, join(app, 'CLAUDE.md'), join(app, '.claude'), join(app, '.claude/skills'), join(app, '.claude/skills/x/SKILL.md')]) {
      expect(isWatchCandidate(scopes, path)).toBe(true)
    }
    for (const path of [join(app, 'src'), join(app, 'node_modules'), join(app, '.git'), join(app, '.claude/agents'), join(app, '.claude/skills/x/node_modules'), '/etc']) {
      expect(isWatchCandidate(scopes, path)).toBe(false)
    }
  })
})
