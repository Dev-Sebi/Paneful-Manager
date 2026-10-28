import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { McpServerNameSchema, type McpScope, type McpServerConfig } from '@paneful-manager/shared'
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type FormattingOptions, type ParseError } from 'jsonc-parser'
import { AppError } from '../errors.js'
import { createBackupStore, type BackupStore } from '../files/backups.js'
import { errnoCode, sha256 } from '../files/read.js'
import { atomicWrite } from '../files/service.js'
import { createAllowlist } from '../fs/allowlist.js'
import { fromNative, isRecord, type NativeServer } from './native.js'

/** `~/.claude.json` holds history and project state and can outgrow the 1 MiB managed-file limit. */
export const MAX_MCP_CONFIG_BYTES = 16 * 1024 * 1024

export const CLAUDE_JSON_NAME = '.claude.json'
export const MCP_JSON_NAME = '.mcp.json'

export interface McpFileStoreOptions {
  env: Record<string, string | undefined>
  backupDir: string
  /** Home directory; defaults to `os.homedir()`. */
  home?: string
}

export interface McpFileEntry {
  name: string
  config: McpServerConfig
}

export interface McpScopeRead {
  /** Lexical path of the file that holds the scope. */
  path: string
  /** Every native entry under the scope's `mcpServers`, including ones Paneful Manager cannot parse. */
  raw: Map<string, NativeServer>
  /** Entries with a valid name and a supported transport. */
  entries: McpFileEntry[]
}

export interface McpFileStore {
  readonly claudeJsonPath: string
  read: (scope: McpScope) => Promise<McpScopeRead>
  /** Sets (`native`) or removes (`undefined`) one server; touches nothing else in the file. */
  write: (scope: McpScope, name: string, native: NativeServer | undefined) => Promise<void>
}

interface Location {
  path: string
  root: string
  jsonPath: string[]
  mode: number | undefined
}

interface Loaded {
  content: Buffer
  text: string
  data: Record<string, unknown>
  hash: string
  mode: number
}

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path
}

/** `$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set, otherwise `~/.claude.json`. */
export function resolveClaudeJsonPath(env: Record<string, string | undefined>, home = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return dir ? join(resolve(expandHome(dir, home)), CLAUDE_JSON_NAME) : join(home, CLAUDE_JSON_NAME)
}

const invalidJson = (path: string, reason: string): AppError =>
  new AppError(`${path} is not valid JSON (${reason}); fix it by hand, Paneful Manager does not overwrite it`, 409, 'conflict', { path })

/** Position and error code only: `JSON.parse` messages quote file content, which may hold tokens. */
function describeSyntaxError(text: string): string {
  const errors: ParseError[] = []
  parseJsonc(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false })
  const first = errors[0]
  if (!first) {
    return 'syntax error'
  }
  const before = text.slice(0, first.offset)
  const line = before.split('\n').length
  const column = first.offset - before.lastIndexOf('\n')
  return `${printParseErrorCode(first.error)} at line ${line}, column ${column}`
}

function parseObject(path: string, text: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw invalidJson(path, describeSyntaxError(text))
  }
  if (!isRecord(data)) {
    throw invalidJson(path, 'top level is not an object')
  }
  return data
}

async function readFile(real: string, path: string): Promise<{ content: Buffer; mode: number } | null> {
  let handle
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = errnoCode(error)
    if (code === 'ENOENT') {
      return null
    }
    if (code === 'ELOOP') {
      throw new AppError('Path changed to a symbolic link', 403, 'forbidden')
    }
    throw error
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new AppError(`${path} is not a regular file`, 403, 'forbidden')
    }
    if (stats.size > MAX_MCP_CONFIG_BYTES) {
      throw new AppError(`${path} is larger than 16 MiB`, 413, 'bad_request')
    }
    return { content: await handle.readFile(), mode: stats.mode & 0o7777 }
  } finally {
    await handle.close()
  }
}

function decode(path: string, content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw invalidJson(path, 'not UTF-8')
  }
}

function formatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return indent.startsWith('\t') ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: indent.length, eol }
}

/** Reads `mcpServers` and the nested sections on the way; a present non-object section is a conflict. */
function serversAt(path: string, data: Record<string, unknown>, jsonPath: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = data
  for (const key of jsonPath) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
      return undefined
    }
    current = current[key]
    if (!isRecord(current)) {
      throw new AppError(`${path}: "${jsonPath.join('.')}" is not an object; fix it by hand`, 409, 'conflict', { path })
    }
  }
  return current as Record<string, unknown>
}

function nested(jsonPath: readonly string[], value: unknown): unknown {
  return jsonPath.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
}

/** Reads and edits `~/.claude.json` and `<project>/.mcp.json`, keeping unknown keys, key order and formatting. */
export function createMcpFileStore({ env, backupDir, home = homedir() }: McpFileStoreOptions): McpFileStore {
  const claudeJsonPath = resolveClaudeJsonPath(env, home)
  const backups: BackupStore = createBackupStore({ dir: backupDir })
  const locks = new Map<string, Promise<unknown>>()

  function locate(scope: McpScope): Location {
    if (scope.kind === 'project') {
      return { path: join(scope.projectPath, MCP_JSON_NAME), root: scope.projectPath, jsonPath: ['mcpServers'], mode: undefined }
    }
    const jsonPath = scope.kind === 'user' ? ['mcpServers'] : ['projects', scope.projectPath, 'mcpServers']
    return { path: claudeJsonPath, root: dirname(claudeJsonPath), jsonPath, mode: 0o600 }
  }

  /** Only the exact managed file name is accepted, also as the target of a link, and only inside its root. */
  function resolveReal(location: Location): string {
    const real = createAllowlist([location.root]).resolveInside(location.path)
    if (basename(real) !== basename(location.path)) {
      throw new AppError(`${location.path} links to a file that is not ${basename(location.path)}`, 403, 'forbidden')
    }
    return real
  }

  async function load(location: Location, real: string): Promise<Loaded | null> {
    const file = await readFile(real, location.path)
    if (!file) {
      return null
    }
    const text = decode(location.path, file.content)
    return { content: file.content, text, data: parseObject(location.path, text), hash: sha256(file.content), mode: file.mode }
  }

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

  return {
    claudeJsonPath,

    async read(scope) {
      const location = locate(scope)
      const loaded = await load(location, resolveReal(location))
      const servers = loaded ? serversAt(location.path, loaded.data, location.jsonPath) : undefined
      const raw = new Map<string, NativeServer>()
      const entries: McpFileEntry[] = []
      for (const [name, value] of Object.entries(servers ?? {})) {
        if (!isRecord(value)) {
          continue
        }
        raw.set(name, value)
        const config = fromNative(value)
        if (config && McpServerNameSchema.safeParse(name).success) {
          entries.push({ name, config })
        }
      }
      return { path: location.path, raw, entries }
    },

    async write(scope, name, native) {
      const location = locate(scope)
      const real = resolveReal(location)
      await withLock(real, async () => {
        const current = await load(location, real)
        const servers = current ? serversAt(location.path, current.data, location.jsonPath) : undefined
        if (native === undefined && !(servers && Object.hasOwn(servers, name))) {
          throw new AppError(`MCP server "${name}" not found`, 404, 'not_found')
        }
        let text: string
        if (current) {
          const edits = modify(current.text, [...location.jsonPath, name], native, { formattingOptions: formatting(current.text) })
          text = applyEdits(current.text, edits)
        } else {
          text = `${JSON.stringify(nested(location.jsonPath, { [name]: native }), null, 2)}\n`
        }
        parseObject(location.path, text)
        if (current) {
          await backups.save(real, current.content)
        } else {
          await mkdir(dirname(real), { recursive: true, mode: 0o700 })
        }
        const mode = location.mode ?? current?.mode
        await atomicWrite(real, text, mode, async () => {
          const latest = await readFile(real, location.path)
          if ((latest ? sha256(latest.content) : null) !== (current?.hash ?? null)) {
            throw new AppError(`${location.path} changed while saving; try again`, 409, 'conflict', { path: location.path })
          }
        })
      })
    },
  }
}
