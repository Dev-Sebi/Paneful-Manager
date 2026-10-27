import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  WORKTREE_DIFF_MAX_BYTES,
  type FileConflictDetails,
  type Scope,
  type WorktreeCopyApplyRequest,
  type WorktreeCopyApplyResponse,
  type WorktreeDiffResponse,
  type WorktreeSkipped,
} from '@agent-hub/shared'
import { AppError } from '../errors.js'
import type { BackupStore } from '../files/backups.js'
import { errnoCode, readCurrent } from '../files/read.js'
import { atomicWrite } from '../files/service.js'
import { createAllowlist } from '../fs/allowlist.js'
import type { RunFn } from '../scopes/run-git.js'
import { assertRelPath, collectEntries, decodeText, resolveWorktree, walkNoFollow, type CopyEntry, type WorktreeContext } from './candidates.js'

export interface WorktreeDeps {
  getScopes: () => Promise<Scope[]>
  run: RunFn
  backups: BackupStore
}

type Candidate = Extract<CopyEntry, { kind: 'candidate' }>

const forbidden = (message: string): AppError => new AppError(message, 403, 'forbidden')

function conflict(currentHash: string | null): AppError {
  const details: FileConflictDetails = { currentHash }
  return new AppError('File changed since the copy plan was created', 409, 'conflict', details)
}

function find(entries: readonly CopyEntry[], relPath: string): CopyEntry {
  assertRelPath(relPath)
  const entry = entries.find(item => (item.kind === 'candidate' ? item.candidate.relPath : item.relPath) === relPath)
  if (entry === undefined) {
    throw forbidden('File is not a copy candidate')
  }
  return entry
}

/** Both the lexical and the real path must stay inside the worktree, with no link on the way. */
async function assertInsideWorktree(ctx: WorktreeContext, relPath: string): Promise<string> {
  const target = join(ctx.worktreePath, relPath)
  const real = createAllowlist([ctx.worktreePath]).resolveInside(target)
  const walked = await walkNoFollow(ctx.worktreePath, relPath)
  if (real !== target || walked.state === 'symlink' || walked.state === 'not-regular') {
    throw forbidden('Path is outside the worktree')
  }
  return target
}

/** Creates missing parent directories one level at a time, re-checking each against links. */
async function ensureParents(ctx: WorktreeContext, relPath: string): Promise<void> {
  let current = ctx.worktreePath
  for (const part of dirname(relPath).split('/').filter(name => name !== '.')) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o755 })
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error
      }
    }
    if (!(await lstat(current)).isDirectory()) {
      throw forbidden('Path is outside the worktree')
    }
  }
}

async function writeOne(ctx: WorktreeContext, entry: Candidate, backups: BackupStore, overwrite: boolean): Promise<WorktreeSkipped | null> {
  const { relPath, identical, existsInWorktree, worktreeHash } = entry.candidate
  if (identical) {
    return { relPath, reason: 'identical' }
  }
  if (existsInWorktree && !overwrite) {
    return { relPath, reason: 'exists' }
  }
  const target = await assertInsideWorktree(ctx, relPath)
  await ensureParents(ctx, relPath)
  if (entry.worktree !== null) {
    await backups.save(target, entry.worktree)
  }
  await atomicWrite(target, entry.text, entry.mode, async () => {
    const walked = await walkNoFollow(ctx.worktreePath, relPath)
    if (walked.state === 'symlink' || walked.state === 'not-regular') {
      throw forbidden('Path changed to a symbolic link')
    }
    const now = await readCurrent(target)
    if ((now?.hash ?? null) !== (worktreeHash ?? null)) {
      throw conflict(now?.hash ?? null)
    }
  })
  return null
}

export async function applyCopy(deps: WorktreeDeps, request: WorktreeCopyApplyRequest): Promise<WorktreeCopyApplyResponse> {
  const ctx = await resolveWorktree(await deps.getScopes(), request.worktreePath)
  const entries = await collectEntries(ctx, deps.run)
  if (new Set(request.files.map(file => file.relPath)).size !== request.files.length) {
    throw new AppError('Duplicate files in request', 400, 'bad_request')
  }
  const planned = request.files.map(file => {
    const entry = find(entries, file.relPath)
    if (entry.kind !== 'candidate') {
      throw forbidden('File is not a copy candidate')
    }
    if (entry.candidate.hash !== file.expectedHash) {
      throw conflict(entry.candidate.hash)
    }
    return { entry, overwrite: file.overwrite }
  })
  const copied: string[] = []
  const skipped: WorktreeSkipped[] = []
  for (const { entry, overwrite } of planned) {
    const result = await writeOne(ctx, entry, deps.backups, overwrite)
    if (result === null) {
      copied.push(entry.candidate.relPath)
    } else {
      skipped.push(result)
    }
  }
  return { copied, skipped }
}

function sideText(content: Buffer | null): string | null | undefined {
  if (content === null) {
    return null
  }
  return content.length > WORKTREE_DIFF_MAX_BYTES ? undefined : decodeText(content)
}

/** Only current candidates (and binary or oversized ones, withheld) can be read, never arbitrary paths. */
export async function diffFile(deps: WorktreeDeps, worktreePath: string, relPath: string): Promise<WorktreeDiffResponse> {
  const ctx = await resolveWorktree(await deps.getScopes(), worktreePath)
  const entry = find(await collectEntries(ctx, deps.run), relPath)
  if (entry.kind === 'skipped') {
    if (entry.reason === 'binary' || entry.reason === 'too-large') {
      return { relPath, main: null, worktree: null, binaryOrTooLarge: true }
    }
    throw forbidden('File is not a copy candidate')
  }
  const main = sideText(Buffer.from(entry.text))
  const worktree = sideText(entry.worktree)
  return {
    relPath,
    main: main ?? null,
    worktree: worktree ?? null,
    binaryOrTooLarge: main === undefined || worktree === undefined,
  }
}
