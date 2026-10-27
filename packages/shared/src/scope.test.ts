import { describe, expect, it } from 'vitest'
import { ScopeSchema } from './scope.js'
import { issuePaths } from './test-utils.js'

describe('ScopeSchema', () => {
  it('accepts every scope kind', () => {
    expect(ScopeSchema.parse({ kind: 'global', path: '~' })).toEqual({ kind: 'global', path: '~' })
    expect(ScopeSchema.parse({ kind: 'project', path: '~/git/project1' }).kind).toBe('project')
    const worktree = {
      kind: 'worktree',
      path: '~/git/project1/.worktrees/feature',
      branch: 'feature',
      projectPath: '~/git/project1',
    }
    expect(ScopeSchema.parse(worktree)).toEqual(worktree)
  })

  it('rejects an unknown kind at the kind path', () => {
    expect(issuePaths(ScopeSchema, { kind: 'team', path: '~' })).toEqual(['kind'])
  })

  it('rejects an empty path', () => {
    expect(issuePaths(ScopeSchema, { kind: 'global', path: '  ' })).toEqual(['path'])
  })

  it('rejects worktree-only fields on other kinds', () => {
    expect(issuePaths(ScopeSchema, { kind: 'project', path: '~/git/project1', branch: 'main' })).toEqual([''])
  })

  it('round-trips through JSON', () => {
    const scope = ScopeSchema.parse({ kind: 'worktree', path: '~/wt', branch: 'b' })
    expect(ScopeSchema.parse(JSON.parse(JSON.stringify(scope)))).toEqual(scope)
  })
})
