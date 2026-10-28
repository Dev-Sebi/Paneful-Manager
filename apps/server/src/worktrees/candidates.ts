import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  WORKTREE_COPY_MAX_BYTES,
  WORKTREE_COPY_PATTERNS,
  type Scope,
  type WorktreeCopyCandidate,
  type WorktreeCopyPlanResponse,
  type WorktreeSkipped,
  type WorktreeSkipReason,
} from '@paneful-manager/shared'
import { AppError } from '../errors.js'
import { errnoCode, readCurrent, sha256 } from '../files/read.js'
import type { RunFn } from '../scopes/run-git.js'

export const LS_FILES_TIMEOUT_MS = 20_000
export const LS_FILES_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** Directories whose contents are never offered, at any depth. */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.venv',
  'target',
])

/** Other worktrees live below the main checkout and must not be treated as sources. */
const EXCLUDED_PREFIXES = ['.claude/worktrees/']

export interface WorktreeContext {
  projectPath: string
  worktreePath: string
}

export type CopyEntry =
  | {
      kind: 'candidate'
      candidate: WorktreeCopyCandidate
      text: string
      mode: number
      /** Current content of the worktree counterpart, `null` when it does not exist. */
      worktree: Buffer | null
    }
  | { kind: 'skipped'; relPath: string; reason: WorktreeSkipReason }

const forbidden = (message: string): AppError => new AppError(message, 403, 'forbidden')

async function canonical(path: string): Promise<string | undefined> {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  if (!isAbsolute(expanded)) {
    return undefined
  }
  try {
    return await realpath(resolve(expanded))
  } catch {
    return undefined
  }
}

/** The worktree must be a discovered worktree scope with a known main checkout, otherwise 404. */
export async function resolveWorktree(scopes: readonly Scope[], worktreePath: string): Promise<WorktreeContext> {
  const wanted = await canonical(worktreePath)
  for (const scope of scopes) {
    if (scope.kind !== 'worktree' || scope.projectPath === undefined || wanted === undefined) {
      continue
    }
    if ((await canonical(scope.path)) === wanted) {
      const projectPath = await canonical(scope.projectPath)
      if (projectPath !== undefined) {
        return { projectPath, worktreePath: wanted }
      }
    }
  }
  throw new AppError('Not a known git worktree', 404, 'not_found')
}

/** Rejects absolute paths, `..`, `.`, empty segments, backslashes and NUL (403). */
export function assertRelPath(relPath: string): void {
  const bad =
    relPath.includes('\0') ||
    relPath.includes('\\') ||
    relPath.startsWith('/') ||
    relPath.split('/').some(part => part === '' || part === '.' || part === '..')
  if (bad) {
    throw forbidden('Path is outside the worktree')
  }
}

function globToRegExp(pattern: string): RegExp {
  const body = [...pattern].map(char => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)))
  return new RegExp(`^${body.join('')}$`)
}

const MATCHERS = WORKTREE_COPY_PATTERNS.map(pattern => ({ regex: globToRegExp(pattern), wholePath: pattern.includes('/') }))

export function matchesCopyPattern(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  return MATCHERS.some(({ regex, wholePath }) => regex.test(wholePath ? relPath : name))
}

function isExcluded(relPath: string): boolean {
  return relPath.split('/').some(part => EXCLUDED_DIR_NAMES.has(part)) || EXCLUDED_PREFIXES.some(prefix => relPath.startsWith(prefix))
}

export type Walked = { state: 'missing' } | { state: 'symlink' } | { state: 'not-regular' } | { state: 'file'; size: number }

/** `lstat` of every component below `root`; stops at the first missing, linked or non-directory component. */
export async function walkNoFollow(root: string, relPath: string): Promise<Walked> {
  const parts = relPath.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'ENOENT') {
        return { state: 'missing' }
      }
      if (code === 'ENOTDIR') {
        return { state: 'not-regular' }
      }
      throw error
    }
    if (stats.isSymbolicLink()) {
      return { state: 'symlink' }
    }
    if (index < parts.length - 1 && !stats.isDirectory()) {
      return { state: 'not-regular' }
    }
    if (index === parts.length - 1) {
      return stats.isFile() ? { state: 'file', size: stats.size } : { state: 'not-regular' }
    }
  }
  return { state: 'missing' }
}

function pathspec(pattern: string): string {
  return pattern.includes('/') ? `:(glob)${pattern}` : `:(glob)**/${pattern}`
}

async function listIgnored(projectPath: string, run: RunFn): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await run(
      'git',
      ['-C', projectPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...WORKTREE_COPY_PATTERNS.map(pathspec)],
      { timeoutMs: LS_FILES_TIMEOUT_MS, maxBuffer: LS_FILES_MAX_BUFFER_BYTES },
    ))
  } catch {
    throw new AppError('Could not list ignored files of the main checkout', 500, 'internal')
  }
  return [...new Set(stdout.split('\0').filter(Boolean))].filter(path => !isExcluded(path) && matchesCopyPattern(path)).toSorted()
}

/** Strict UTF-8 text of `content`, `undefined` when it is binary or not valid UTF-8. */
export function decodeText(content: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
    return !content.includes(0) && Buffer.from(text).equals(content) ? text : undefined
  } catch {
    return undefined
  }
}

async function inspect(ctx: WorktreeContext, relPath: string): Promise<CopyEntry | undefined> {
  const skipped = (reason: WorktreeSkipReason): CopyEntry => ({ kind: 'skipped', relPath, reason })
  const main = await walkNoFollow(ctx.projectPath, relPath)
  if (main.state === 'missing') {
    return undefined
  }
  if (main.state !== 'file') {
    return skipped(main.state)
  }
  if (main.size > WORKTREE_COPY_MAX_BYTES) {
    return skipped('too-large')
  }
  const file = await readCurrent(join(ctx.projectPath, relPath))
  if (file === null) {
    return undefined
  }
  const text = decodeText(file.content)
  if (text === undefined) {
    return skipped('binary')
  }
  const side = await walkNoFollow(ctx.worktreePath, relPath)
  if (side.state === 'symlink') {
    return skipped('worktree-symlink')
  }
  if (side.state === 'not-regular') {
    return skipped('worktree-not-regular')
  }
  if (side.state === 'file' && side.size > WORKTREE_COPY_MAX_BYTES) {
    return skipped('worktree-too-large')
  }
  const current = side.state === 'file' ? await readCurrent(join(ctx.worktreePath, relPath)) : null
  const hash = sha256(file.content)
  return {
    kind: 'candidate',
    text,
    mode: file.stats.mode & 0o777,
    worktree: current?.content ?? null,
    candidate: {
      relPath,
      size: file.stats.size,
      mtimeMs: file.stats.mtimeMs,
      hash,
      existsInWorktree: current !== null,
      ...(current === null ? {} : { worktreeHash: current.hash }),
      identical: current?.hash === hash,
    },
  }
}

/** Recomputes the current copy candidates and skipped files of the main checkout. */
export async function collectEntries(ctx: WorktreeContext, run: RunFn): Promise<CopyEntry[]> {
  const entries: CopyEntry[] = []
  for (const relPath of await listIgnored(ctx.projectPath, run)) {
    const entry = await inspect(ctx, relPath)
    if (entry !== undefined) {
      entries.push(entry)
    }
  }
  return entries
}

export async function planCopy(scopes: readonly Scope[], worktreePath: string, run: RunFn): Promise<WorktreeCopyPlanResponse> {
  const ctx = await resolveWorktree(scopes, worktreePath)
  const entries = await collectEntries(ctx, run)
  const skipped: WorktreeSkipped[] = []
  const candidates: WorktreeCopyCandidate[] = []
  for (const entry of entries) {
    if (entry.kind === 'candidate') {
      candidates.push(entry.candidate)
    } else {
      skipped.push({ relPath: entry.relPath, reason: entry.reason })
    }
  }
  return { projectPath: ctx.projectPath, worktreePath: ctx.worktreePath, candidates, skipped }
}
