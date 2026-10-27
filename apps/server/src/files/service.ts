import { randomBytes } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_MANAGED_FILE_BYTES,
  type CreateFileRequest,
  type FileChangedMessage,
  type FileConflictDetails,
  type FileContent,
  type FileEntry,
  type ListFilesQuery,
  type Scope,
  type SkillDeleteBlockedDetails,
  type WriteFileRequest,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import { createAllowlist, type Allowlist } from '../fs/allowlist.js'
import { createBackupStore, type BackupStore } from './backups.js'
import {
  IGNORED_DIR_NAMES,
  MAX_SKILL_DEPTH,
  SKILL_FILE_NAME,
  allowlistRoots,
  isAllowedSkillFile,
  isSkillName,
  matchManagedPath,
  matchSkillDir,
  rootFiles,
  scopeRoot,
  skillsDirSegments,
  type ManagedMatch,
} from './layout.js'
import { errnoCode, readCurrent, type CurrentFile } from './read.js'
import { createFileWatcher, type FileWatcher } from './watcher.js'

export type FileServiceLogger = Pick<BaseLogger, 'debug' | 'info' | 'warn'>

export interface FileServiceOptions {
  getScopes: () => Promise<Scope[]>
  /** Directory for backups, normally `$STATE/backups`. */
  backupDir: string
  logger: FileServiceLogger
  /** Builds the allowlist from the current scope roots; defaults to `createAllowlist`. */
  allowlist?: (roots: readonly string[]) => Allowlist
  backupLimits?: { perFile?: number; totalBytes?: number }
  /** Watcher debounce, mainly for tests. */
  watchDebounceMs?: number
  /** Sink for watcher messages, e.g. the WS broadcast. */
  broadcast?: (message: FileChangedMessage) => void
}

export interface FileService {
  list: (query?: ListFilesQuery) => Promise<FileEntry[]>
  read: (path: string) => Promise<FileContent>
  write: (request: WriteFileRequest) => Promise<FileEntry>
  create: (request: CreateFileRequest) => Promise<FileContent>
  delete: (path: string) => Promise<void>
  /** Starts the watcher on first use; returns an unsubscribe function. */
  watch: (listener: (message: FileChangedMessage) => void) => Promise<() => void>
  /** Re-reads the scopes for a running watcher, e.g. after the project list changed. */
  refresh: () => Promise<void>
  close: () => Promise<void>
}

interface Context {
  scopes: Scope[]
  allowlist: Allowlist
  realRoots: string[]
}

const forbidden = (message: string): AppError => new AppError(message, 403, 'forbidden')

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function decodeText(content: Buffer): string {
  if (content.includes(0)) {
    throw new AppError('Binary files are not supported', 415, 'bad_request')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new AppError('File is not valid UTF-8 text', 415, 'bad_request')
  }
}

function assertTextContent(content: string): void {
  if (content.includes('\0')) {
    throw new AppError('Binary content is not supported', 415, 'bad_request')
  }
  if (Buffer.byteLength(content) > MAX_MANAGED_FILE_BYTES) {
    throw new AppError('File is larger than 1 MiB', 413, 'bad_request')
  }
}

function conflict(current: CurrentFile | null, message = 'File changed since it was read'): AppError {
  const details: FileConflictDetails = { currentHash: current?.hash ?? null }
  return new AppError(message, 409, 'conflict', details)
}

function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: Describe what this skill does and when to use it.\n---\n\n# ${name}\n\nWrite the instructions for this skill here.\n`
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some filesystems cannot fsync directories; the rename itself is still atomic.
  }
}

/** Temp file in the target directory (`O_EXCL`), fsync, `verify`, rename; the temp file never survives a failure. */
export async function atomicWrite(target: string, content: string, mode: number | undefined, verify: () => Promise<void>): Promise<void> {
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.agent-hub-${randomBytes(6).toString('hex')}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  try {
    const handle = await open(temp, flags, mode ?? 0o644)
    try {
      await handle.writeFile(content)
      if (mode !== undefined) {
        await handle.chmod(mode)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await verify()
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await fsyncDir(dir)
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && !rel.split(sep).includes('..'))
}

export function createFileService(options: FileServiceOptions): FileService {
  const { getScopes, logger } = options
  const makeAllowlist = options.allowlist ?? createAllowlist
  const backups: BackupStore = createBackupStore({ dir: options.backupDir, ...options.backupLimits })
  const locks = new Map<string, Promise<unknown>>()
  let watcher: Promise<FileWatcher> | undefined

  async function context(): Promise<Context> {
    const scopes = await getScopes()
    const roots = allowlistRoots(scopes)
    const allowlist = makeAllowlist(roots)
    const realRoots = roots.flatMap(root => {
      try {
        return [allowlist.resolveInside(root)]
      } catch {
        return []
      }
    })
    return { scopes, allowlist, realRoots }
  }

  /** Serializes operations per real path so a stale write after a concurrent one sees the new hash. */
  async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const settled = next.catch(() => undefined)
    locks.set(key, settled)
    try {
      return await next
    } finally {
      if (locks.get(key) === settled) {
        locks.delete(key)
      }
    }
  }

  /** Re-checks with `lstat` that no existing component below the root is a symlink (TOCTOU guard). */
  async function assertNoSymlinks(ctx: Context, real: string): Promise<void> {
    const root = ctx.realRoots.filter(candidate => isInsideRoot(real, candidate)).toSorted((a, b) => b.length - a.length)[0]
    if (root === undefined) {
      throw forbidden('Path is outside the allowed directories')
    }
    let current = root
    for (const part of relative(root, real).split(sep).filter(Boolean)) {
      current = join(current, part)
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw forbidden('Path changed to a symbolic link')
        }
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') {
          return
        }
        throw error
      }
    }
  }

  /**
   * A resolved path must stay inside the scope root of the requested path and contain no hidden segment
   * (except the skills prefix); a file must also be managed or Markdown, so `CLAUDE.md -> AGENTS.md` works.
   */
  function assertRealInScope(hit: { scope: Scope; root: string }, real: string, type: 'file' | 'entry'): void {
    const realRoot = tryRealpath(hit.root) ?? hit.root
    if (!isInsideRoot(real, realRoot)) {
      throw forbidden('Link target leaves its scope')
    }
    const segments = relative(realRoot, real).split(sep).filter(Boolean)
    const skills = skillsDirSegments(hit.scope)
    const inSkills = segments.length > skills.length && skills.every((part, index) => segments[index] === part)
    if ((inSkills ? segments.slice(skills.length) : segments).some(segment => segment.startsWith('.'))) {
      throw forbidden('Link target is a hidden path')
    }
    if (type === 'file' && !matchManagedPath([hit.scope], real) && extname(real).toLowerCase() !== '.md') {
      throw forbidden('Link target is not a managed file')
    }
  }

  function resolveManaged(ctx: Context, raw: string): { match: ManagedMatch; real: string } {
    const real = ctx.allowlist.resolveInside(raw)
    const match = matchManagedPath(ctx.scopes, resolve(expandHome(raw.trim())))
    if (!match) {
      throw forbidden('Not a managed file')
    }
    assertRealInScope(match, real, 'file')
    return { match, real }
  }

  function toEntry(match: ManagedMatch, current: CurrentFile): FileEntry {
    return {
      scope: match.scope,
      kind: match.kind,
      path: match.path,
      relPath: match.relPath,
      name: match.name,
      size: current.stats.size,
      mtimeMs: current.stats.mtimeMs,
      hash: current.hash,
    }
  }

  async function readMatch(ctx: Context, match: ManagedMatch, real: string): Promise<FileContent> {
    await assertNoSymlinks(ctx, real)
    const current = await readCurrent(real)
    if (!current) {
      throw new AppError('File not found', 404, 'not_found')
    }
    return { ...toEntry(match, current), content: decodeText(current.content) }
  }

  async function writeResolved(ctx: Context, match: ManagedMatch, real: string, request: WriteFileRequest): Promise<FileEntry> {
    assertTextContent(request.content)
    return withLock(real, async () => {
      await assertNoSymlinks(ctx, real)
      const current = await readCurrent(real)
      if (current === null ? request.expectedHash !== undefined : current.hash !== request.expectedHash) {
        throw conflict(current, current && request.expectedHash === undefined ? 'File already exists' : undefined)
      }
      if (current) {
        await backups.save(real, current.content)
      } else {
        const parent = ctx.allowlist.resolveInside(dirname(real))
        await mkdir(parent, { recursive: true })
        await assertNoSymlinks(ctx, parent)
      }
      await atomicWrite(real, request.content, current ? current.stats.mode & 0o7777 : undefined, async () => {
        const latest = await readCurrent(real)
        if ((latest?.hash ?? null) !== (current?.hash ?? null)) {
          throw conflict(latest)
        }
      })
      const written = await readCurrent(real)
      if (!written) {
        throw new AppError('File disappeared after write', 409, 'conflict', { currentHash: null })
      }
      logger.info({ path: match.path }, 'Managed file written')
      return toEntry(match, written)
    })
  }

  async function tryListEntry(ctx: Context, match: ManagedMatch): Promise<FileEntry | undefined> {
    try {
      const real = ctx.allowlist.resolveInside(match.path)
      assertRealInScope(match, real, 'file')
      const current = await readCurrent(real)
      if (!current) {
        return undefined
      }
      decodeText(current.content)
      return toEntry(match, current)
    } catch (error) {
      logger.debug({ path: match.path, err: error }, 'Skipping file in listing')
      return undefined
    }
  }

  async function listDir(ctx: Context, dir: string): Promise<{ name: string; isDir: boolean }[]> {
    try {
      const real = ctx.allowlist.resolveInside(dir)
      const entries = await readdir(real, { withFileTypes: true })
      const result: { name: string; isDir: boolean }[] = []
      for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED_DIR_NAMES.has(entry.name)) {
          continue
        }
        const isDir = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(join(real, entry.name)).then(s => s.isDirectory(), () => false)))
        result.push({ name: entry.name, isDir })
      }
      return result.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        logger.debug({ dir, err: error }, 'Skipping directory in listing')
      }
      return []
    }
  }

  async function listSkillFiles(ctx: Context, dir: string, depth: number, out: string[]): Promise<void> {
    for (const entry of await listDir(ctx, dir)) {
      const path = join(dir, entry.name)
      if (entry.isDir) {
        if (depth < MAX_SKILL_DEPTH) {
          await listSkillFiles(ctx, path, depth + 1, out)
        }
      } else {
        out.push(path)
      }
    }
  }

  async function listScope(ctx: Context, scope: Scope): Promise<FileEntry[]> {
    const root = scopeRoot(scope)
    const candidates = [...rootFiles(scope).keys()].map(name => join(root, name))
    const skillsDir = join(root, ...skillsDirSegments(scope))
    for (const skill of await listDir(ctx, skillsDir)) {
      if (skill.isDir && isSkillName(skill.name)) {
        await listSkillFiles(ctx, join(skillsDir, skill.name), 0, candidates)
      }
    }
    const entries: FileEntry[] = []
    for (const candidate of candidates) {
      const match = matchManagedPath(ctx.scopes, candidate)
      // A nested scope (worktree inside its project) owns its own files.
      if (match && match.scope === scope) {
        const entry = await tryListEntry(ctx, match)
        if (entry) {
          entries.push(entry)
        }
      }
    }
    return entries
  }

  /** Walks a skill directory without following links; returns its files or the entries that block deletion. */
  async function inspectSkillDir(dir: string): Promise<{ files: string[]; blocked: string[] }> {
    const files: string[] = []
    const blocked: string[] = []
    async function walk(current: string, segments: string[]): Promise<void> {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const rel = [...segments, entry.name]
        const path = join(current, entry.name)
        if (entry.isDirectory() && rel.length <= MAX_SKILL_DEPTH && !entry.name.startsWith('.') && !IGNORED_DIR_NAMES.has(entry.name)) {
          await walk(path, rel)
        } else if (entry.isFile() && isAllowedSkillFile(rel) && (await lstat(path)).size <= MAX_MANAGED_FILE_BYTES) {
          files.push(path)
        } else {
          blocked.push(rel.join('/'))
        }
      }
    }
    await walk(dir, [])
    return { files, blocked }
  }

  async function deleteSkillDir(dir: string): Promise<void> {
    const { files, blocked } = await inspectSkillDir(dir)
    if (blocked.length > 0) {
      const details: SkillDeleteBlockedDetails = { blocked }
      throw new AppError('Skill directory contains files Agent Hub does not manage', 409, 'conflict', details)
    }
    for (const file of files) {
      const current = await readCurrent(file)
      if (current) {
        await backups.save(file, current.content)
      }
    }
    await rm(dir, { recursive: true })
  }

  return {
    async list(query = {}) {
      const ctx = await context()
      const scopePath = query.scopePath === undefined ? undefined : resolve(expandHome(query.scopePath))
      const scopes = ctx.scopes.filter(scope =>
        (query.scopeKind === undefined || scope.kind === query.scopeKind)
        && (scopePath === undefined || scopeRoot(scope) === scopePath))
      const entries: FileEntry[] = []
      for (const scope of scopes) {
        entries.push(...(await listScope(ctx, scope)))
      }
      return entries
    },

    async read(path) {
      const ctx = await context()
      const { match, real } = resolveManaged(ctx, path)
      return readMatch(ctx, match, real)
    },

    async write(request) {
      const ctx = await context()
      const { match, real } = resolveManaged(ctx, request.path)
      return writeResolved(ctx, match, real, request)
    },

    async create(request) {
      const ctx = await context()
      const wanted = resolve(expandHome(request.scopePath))
      const scope = ctx.scopes.find(candidate => scopeRoot(candidate) === wanted)
      if (!scope) {
        throw new AppError('Unknown scope', 404, 'not_found')
      }
      const root = scopeRoot(scope)
      let path: string
      let content = ''
      if (request.kind === 'skill') {
        const name = request.name ?? ''
        if (!isSkillName(name)) {
          throw new AppError('Invalid skill name', 400, 'bad_request')
        }
        const skillDir = join(root, ...skillsDirSegments(scope), name)
        const realDir = ctx.allowlist.resolveInside(skillDir)
        assertRealInScope({ scope, root }, realDir, 'entry')
        const existing = await lstat(realDir).then(() => true, () => false)
        if (existing) {
          throw conflict(null, 'Skill already exists')
        }
        await mkdir(realDir, { recursive: true })
        await assertNoSymlinks(ctx, realDir)
        path = join(skillDir, SKILL_FILE_NAME)
        content = (request.template ?? 'skill') === 'skill' ? skillTemplate(name) : ''
      } else {
        path = join(root, request.kind === 'claude-md' ? 'CLAUDE.md' : 'CLAUDE.local.md')
      }
      const { match, real } = resolveManaged(ctx, path)
      await writeResolved(ctx, match, real, { path, content })
      return readMatch(ctx, match, real)
    },

    async delete(path) {
      const ctx = await context()
      const lexical = resolve(expandHome(path.trim()))
      const skillDir = matchSkillDir(ctx.scopes, lexical)
      const fileMatch = matchManagedPath(ctx.scopes, lexical)
      const hit = skillDir ?? fileMatch
      if (!hit) {
        ctx.allowlist.resolveInside(path)
        throw forbidden('Not a managed file')
      }
      // The entry itself is removed, so a symlinked file or skill directory loses only its link.
      const parent = ctx.allowlist.resolveInside(dirname(lexical))
      const entry = join(parent, basename(lexical))
      assertRealInScope(hit, entry, skillDir ? 'entry' : 'file')
      let lockKey = entry
      try {
        lockKey = ctx.allowlist.resolveInside(lexical)
      } catch {
        // Dangling or escaping link: only the entry itself can be locked.
      }
      await withLock(lockKey, async () => {
        await assertNoSymlinks(ctx, parent)
        let info: Stats
        try {
          info = await lstat(entry)
        } catch (error) {
          if (errnoCode(error) === 'ENOENT') {
            throw new AppError('File not found', 404, 'not_found')
          }
          throw error
        }
        if (info.isSymbolicLink()) {
          assertRealInScope(hit, ctx.allowlist.resolveInside(entry), skillDir ? 'entry' : 'file')
          await unlink(entry)
        } else if (skillDir) {
          if (!info.isDirectory()) {
            throw new AppError('Not a skill directory', 400, 'bad_request')
          }
          await deleteSkillDir(entry)
        } else {
          const current = await readCurrent(entry)
          if (current) {
            await backups.save(entry, current.content)
          }
          await unlink(entry)
        }
      })
      logger.info({ path: lexical }, 'Managed file deleted')
    },

    async watch(listener) {
      watcher ??= (async () => {
        const created = createFileWatcher({
          getScopes,
          logger,
          allowlist: makeAllowlist,
          debounceMs: options.watchDebounceMs,
          broadcast: options.broadcast,
        })
        await created.start()
        return created
      })()
      watcher.catch(() => {
        watcher = undefined
      })
      return (await watcher).onChange(listener)
    },

    async refresh() {
      await (await watcher)?.refresh()
    },

    async close() {
      const current = watcher
      watcher = undefined
      await (await current)?.close()
    },
  }
}
