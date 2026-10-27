import { describe, expect, it } from 'vitest'
import { API_ROUTES } from './api.js'
import {
  WORKTREE_COPY_PATTERNS,
  WorktreeCopyApplyRequestSchema,
  WorktreeCopyCandidateSchema,
  WorktreeCopyPlanRequestSchema,
  WorktreeDiffResponseSchema,
} from './worktrees.js'

const HASH = 'ab'.repeat(32)

describe('worktree contracts', () => {
  it('has routes and default patterns', () => {
    expect(API_ROUTES.worktreeCopyPlan).toBe('/api/worktrees/copy-plan')
    expect(API_ROUTES.worktreeCopyApply).toBe('/api/worktrees/copy')
    expect(API_ROUTES.worktreeDiff).toBe('/api/worktrees/diff')
    expect(WORKTREE_COPY_PATTERNS).toContain('.claude/settings.local.json')
  })

  it('accepts a candidate with and without a worktree counterpart', () => {
    const base = { relPath: '.env', size: 3, mtimeMs: 1.5, hash: HASH, existsInWorktree: false, identical: false }
    expect(WorktreeCopyCandidateSchema.safeParse(base).success).toBe(true)
    expect(WorktreeCopyCandidateSchema.safeParse({ ...base, existsInWorktree: true, worktreeHash: HASH }).success).toBe(true)
    expect(WorktreeCopyCandidateSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
  })

  it('requires expectedHash and overwrite per file', () => {
    const file = { relPath: '.env', overwrite: false, expectedHash: HASH }
    expect(WorktreeCopyApplyRequestSchema.safeParse({ worktreePath: '/w', files: [file] }).success).toBe(true)
    expect(WorktreeCopyApplyRequestSchema.safeParse({ worktreePath: '/w', files: [] }).success).toBe(false)
    expect(WorktreeCopyApplyRequestSchema.safeParse({ worktreePath: '/w', files: [{ relPath: '.env', overwrite: false }] }).success).toBe(false)
    expect(WorktreeCopyPlanRequestSchema.safeParse({}).success).toBe(false)
  })

  it('describes a withheld diff', () => {
    expect(WorktreeDiffResponseSchema.safeParse({ relPath: 'a', main: null, worktree: null, binaryOrTooLarge: true }).success).toBe(true)
  })
})
