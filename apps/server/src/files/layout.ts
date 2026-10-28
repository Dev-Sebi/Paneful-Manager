import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SKILL_FILE_EXTENSIONS, SkillNameSchema, type ManagedFileKind, type Scope } from '@paneful-manager/shared'

/** Deepest nesting below a skill directory that is still managed (`<skill>/a/b/c/file.md`). */
export const MAX_SKILL_DEPTH = 4

export const SKILL_FILE_NAME = 'SKILL.md'

/** Directory names never descended into, neither by listing nor by the watcher. */
export const IGNORED_DIR_NAMES = new Set(['node_modules', '.git'])

export interface ManagedMatch {
  scope: Scope
  /** `scope.path` with `~` expanded and normalized; `path` below starts with it. */
  root: string
  kind: ManagedFileKind
  /** Canonical path: `root` joined with `relPath`. */
  path: string
  relPath: string
  name: string
}

export interface SkillDirMatch {
  scope: Scope
  root: string
  path: string
  relPath: string
  name: string
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

export function scopeRoot(scope: Scope): string {
  return resolve(expandHome(scope.path))
}

/** Skills directory segments relative to the scope root. */
export function skillsDirSegments(scope: Scope): string[] {
  return scope.kind === 'global' ? ['skills'] : ['.claude', 'skills']
}

/** Root-level files managed in a scope, keyed by file name. */
export function rootFiles(scope: Scope): ReadonlyMap<string, ManagedFileKind> {
  return scope.kind === 'global'
    ? new Map([['CLAUDE.md', 'claude-md']])
    : new Map([['CLAUDE.md', 'claude-md'], ['CLAUDE.local.md', 'claude-local-md']])
}

/** Allowlist roots: `$CLAUDE_DIR` and every project and worktree path. */
export function allowlistRoots(scopes: readonly Scope[]): string[] {
  return [...new Set(scopes.map(scope => scopeRoot(scope)))]
}

export function isSkillName(name: string): boolean {
  return SkillNameSchema.safeParse(name).success
}

/** Whether `segments` (below the skill directory) name an allowed skill file: no hidden parts, allowed extension. */
export function isAllowedSkillFile(segments: readonly string[]): boolean {
  if (segments.length === 0 || segments.length > MAX_SKILL_DEPTH + 1) {
    return false
  }
  if (segments.some(segment => segment.startsWith('.') || IGNORED_DIR_NAMES.has(segment))) {
    return false
  }
  const ext = extname(segments.at(-1) ?? '').toLowerCase()
  return (SKILL_FILE_EXTENSIONS as readonly string[]).includes(ext)
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function relSegments(root: string, path: string): string[] | undefined {
  const rel = relative(root, path)
  if (isAbsolute(rel) || rel.split(sep).includes('..')) {
    return undefined
  }
  return rel === '' ? [] : rel.split(sep)
}

interface ScopeHit {
  scope: Scope
  root: string
  segments: string[]
  /** Length of the matched root form; the longest wins so nested worktrees beat their project. */
  depth: number
}

/** Most specific scope containing `path`, matched against the configured and the real form of each root. */
export function findScope(scopes: readonly Scope[], path: string): ScopeHit | undefined {
  let best: ScopeHit | undefined
  for (const scope of scopes) {
    const root = scopeRoot(scope)
    for (const form of new Set([root, tryRealpath(root) ?? root])) {
      const segments = relSegments(form, path)
      if (segments && (!best || form.length > best.depth)) {
        best = { scope, root, segments, depth: form.length }
      }
    }
  }
  return best
}

function startsWith(segments: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => segments[index] === part)
}

/** Classifies an absolute, normalized path lexically; `undefined` when it is not a managed file. */
export function matchManagedPath(scopes: readonly Scope[], path: string): ManagedMatch | undefined {
  const hit = findScope(scopes, path)
  if (!hit) {
    return undefined
  }
  const { scope, root, segments } = hit
  const relPath = segments.join('/')
  const rootKind = segments.length === 1 ? rootFiles(scope).get(segments[0] ?? '') : undefined
  if (rootKind) {
    return { scope, root, kind: rootKind, path: join(root, ...segments), relPath, name: segments[0] ?? '' }
  }
  const skills = skillsDirSegments(scope)
  if (!startsWith(segments, skills)) {
    return undefined
  }
  const [name, ...rest] = segments.slice(skills.length)
  if (name === undefined || !isSkillName(name) || !isAllowedSkillFile(rest)) {
    return undefined
  }
  return { scope, root, kind: 'skill', path: join(root, ...segments), relPath, name }
}

/** Matches `<skills dir>/<name>` exactly. */
export function matchSkillDir(scopes: readonly Scope[], path: string): SkillDirMatch | undefined {
  const hit = findScope(scopes, path)
  if (!hit) {
    return undefined
  }
  const skills = skillsDirSegments(hit.scope)
  const name = hit.segments.at(-1)
  if (hit.segments.length !== skills.length + 1 || !startsWith(hit.segments, skills) || name === undefined || !isSkillName(name)) {
    return undefined
  }
  return { scope: hit.scope, root: hit.root, path: join(hit.root, ...hit.segments), relPath: hit.segments.join('/'), name }
}

/**
 * Whether the watcher should descend into or report `path`: a scope root, its root files,
 * the skills directory chain and anything below it that is not hidden or ignored.
 */
export function isWatchCandidate(scopes: readonly Scope[], path: string): boolean {
  return scopes.some(scope => {
    const segments = relSegments(scopeRoot(scope), path)
    if (!segments) {
      return false
    }
    if (segments.length === 0) {
      return true
    }
    if (segments.length === 1 && rootFiles(scope).has(segments[0] ?? '')) {
      return true
    }
    const skills = skillsDirSegments(scope)
    if (segments.length <= skills.length) {
      return startsWith(skills, segments)
    }
    const below = segments.slice(skills.length)
    return startsWith(segments, skills)
      && below.length <= MAX_SKILL_DEPTH + 2
      && below.every(segment => !segment.startsWith('.') && !IGNORED_DIR_NAMES.has(segment))
  })
}
