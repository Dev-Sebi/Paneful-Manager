import { z } from 'zod'
import { FileHashSchema, MAX_MANAGED_FILE_BYTES } from './files.js'
import { PathSchema } from './scope.js'

/**
 * Gitignored files offered for copying into a worktree. A pattern without `/` matches the file name at any depth,
 * otherwise the whole relative path; `*` and `?` never match `/`.
 */
export const WORKTREE_COPY_PATTERNS: readonly string[] = ['.env', '.env.*', '*.local', '.claude/settings.local.json', '.claude/*.local.*']

/** Larger files are skipped (`too-large`). */
export const WORKTREE_COPY_MAX_BYTES = MAX_MANAGED_FILE_BYTES

/** Per side; larger or binary files are not returned by the diff route. */
export const WORKTREE_DIFF_MAX_BYTES = 256 * 1024

/** Path relative to the checkout root (forward slashes); the server rejects absolute paths and `..` with 403. */
export const WorktreeRelPathSchema = z.string().min(1).max(1024)

/**
 * Why a file is not copied. Plan: `symlink`, `too-large`, `not-regular`, `binary` (main side) and `worktree-*`
 * (the counterpart is a link, not a regular file, or too large). Apply: `exists` (overwrite not requested), `identical`.
 */
export const WorktreeSkipReasonSchema = z.enum([
  'symlink',
  'too-large',
  'not-regular',
  'binary',
  'worktree-symlink',
  'worktree-not-regular',
  'worktree-too-large',
  'exists',
  'identical',
])
export type WorktreeSkipReason = z.infer<typeof WorktreeSkipReasonSchema>

export const WorktreeSkippedSchema = z.strictObject({ relPath: WorktreeRelPathSchema, reason: WorktreeSkipReasonSchema })
export type WorktreeSkipped = z.infer<typeof WorktreeSkippedSchema>

export const WorktreeCopyCandidateSchema = z.strictObject({
  relPath: WorktreeRelPathSchema,
  size: z.int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  hash: FileHashSchema,
  existsInWorktree: z.boolean(),
  worktreeHash: FileHashSchema.optional(),
  identical: z.boolean(),
})
export type WorktreeCopyCandidate = z.infer<typeof WorktreeCopyCandidateSchema>

/** POST /api/worktrees/copy-plan; `worktreePath` must be a discovered worktree scope (else 404). */
export const WorktreeCopyPlanRequestSchema = z.strictObject({ worktreePath: PathSchema })
export type WorktreeCopyPlanRequest = z.infer<typeof WorktreeCopyPlanRequestSchema>

export const WorktreeCopyPlanResponseSchema = z.strictObject({
  projectPath: PathSchema,
  worktreePath: PathSchema,
  candidates: z.array(WorktreeCopyCandidateSchema),
  skipped: z.array(WorktreeSkippedSchema),
})
export type WorktreeCopyPlanResponse = z.infer<typeof WorktreeCopyPlanResponseSchema>

/** `expectedHash` is the candidate `hash` from the plan; a changed main file is `409 conflict`. */
export const WorktreeCopyFileSchema = z.strictObject({
  relPath: WorktreeRelPathSchema,
  overwrite: z.boolean(),
  expectedHash: FileHashSchema,
})
export type WorktreeCopyFile = z.infer<typeof WorktreeCopyFileSchema>

/** POST /api/worktrees/copy. Anything that is not a current candidate is 403; existing files need `overwrite`. */
export const WorktreeCopyApplyRequestSchema = z.strictObject({
  worktreePath: PathSchema,
  files: z.array(WorktreeCopyFileSchema).min(1).max(200),
})
export type WorktreeCopyApplyRequest = z.infer<typeof WorktreeCopyApplyRequestSchema>

export const WorktreeCopyApplyResponseSchema = z.strictObject({
  copied: z.array(WorktreeRelPathSchema),
  skipped: z.array(WorktreeSkippedSchema),
})
export type WorktreeCopyApplyResponse = z.infer<typeof WorktreeCopyApplyResponseSchema>

/** POST /api/worktrees/diff */
export const WorktreeDiffRequestSchema = z.strictObject({ worktreePath: PathSchema, relPath: WorktreeRelPathSchema })
export type WorktreeDiffRequest = z.infer<typeof WorktreeDiffRequestSchema>

/** A side is `null` when the file is missing there; `binaryOrTooLarge` is true when a side was withheld. */
export const WorktreeDiffResponseSchema = z.strictObject({
  relPath: WorktreeRelPathSchema,
  main: z.string().nullable(),
  worktree: z.string().nullable(),
  binaryOrTooLarge: z.boolean(),
})
export type WorktreeDiffResponse = z.infer<typeof WorktreeDiffResponseSchema>
