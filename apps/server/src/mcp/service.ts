import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  maskMcpEntry,
  type ListMcpServersQuery,
  type ListMcpServersResponse,
  type McpMode,
  type McpScope,
  type McpServerConfig,
  type McpServerConfigInput,
  type McpServerEntryMasked,
  type RemoveMcpServerRequest,
  type Scope,
  type UpsertMcpServerRequest,
  type UpsertMcpServerResponse,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import { createClaudeCli, type ClaudeCli, type CliRun } from './cli.js'
import { createMcpFileStore, type McpFileStore } from './files.js'
import { fromNative, toNative, type NativeServer } from './native.js'

export type McpServiceLogger = Pick<BaseLogger, 'info' | 'warn'>

export interface McpServiceOptions {
  getScopes: () => Promise<Scope[]>
  env: Record<string, string | undefined>
  /** Directory for backups, normally `$STATE/backups`. */
  backupDir: string
  logger: McpServiceLogger
  /** `auto` (default) uses the `claude` CLI when it is installed and falls back to editing the files. */
  mode?: McpMode | 'auto'
  run?: CliRun
  home?: string
  now?: () => number
}

export interface McpService {
  list: (query?: ListMcpServersQuery) => Promise<ListMcpServersResponse>
  upsert: (request: UpsertMcpServerRequest) => Promise<UpsertMcpServerResponse>
  remove: (request: RemoveMcpServerRequest) => Promise<void>
}

function expandHome(path: string, home: string): string {
  return path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : path
}

/** Claude Code keys the `local` scope by the real path of its working directory. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function secretsOf(config: McpServerConfig): string[] {
  return Object.values(config.transport === 'stdio' ? config.env : config.headers)
}

/** Applies `{ keep: true }` per key from the stored entry; keys left out of the request are dropped. */
function resolveKeep(input: McpServerConfigInput, existing: McpServerConfig | undefined): McpServerConfig {
  const merge = (values: Record<string, string | { keep: true }>, stored: Record<string, string> | undefined, label: string) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => {
      if (typeof value === 'string') {
        return [key, value]
      }
      const kept = stored && Object.hasOwn(stored, key) ? stored[key] : undefined
      if (kept === undefined) {
        throw new AppError(`Cannot keep ${label} "${key}": no stored value`, 400, 'bad_request')
      }
      return [key, kept]
    }))
  if (input.transport === 'stdio') {
    const stored = existing?.transport === 'stdio' ? existing.env : undefined
    return { ...input, env: merge(input.env, stored, 'env') }
  }
  const stored = existing && existing.transport !== 'stdio' ? existing.headers : undefined
  return { ...input, headers: merge(input.headers, stored, 'header') }
}

/** MCP servers across Claude Code's user, project and local scopes; writes go through `claude mcp` when possible. */
export function createMcpService(options: McpServiceOptions): McpService {
  const { getScopes, env, logger, home = homedir() } = options
  const files: McpFileStore = createMcpFileStore({ env, backupDir: options.backupDir, home })
  const cli: ClaudeCli = createClaudeCli({ env, run: options.run, now: options.now })
  let queue: Promise<unknown> = Promise.resolve()

  /** Mutations run one at a time: an update is remove + add and must not interleave with another one. */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  async function currentMode(): Promise<{ mode: McpMode; cliVersion?: string }> {
    if (options.mode === 'file') {
      return { mode: 'file' }
    }
    const status = await cli.detect()
    if (status.available) {
      return { mode: 'cli', cliVersion: status.version }
    }
    if (options.mode === 'cli') {
      throw new AppError('The claude CLI is not available', 409, 'conflict')
    }
    return { mode: 'file' }
  }

  async function projectPaths(): Promise<string[]> {
    const scopes = await getScopes()
    return scopes.filter(scope => scope.kind !== 'global').map(scope => canonical(scope.path))
  }

  /** Normalizes `projectPath` and requires it to be a configured project or one of its worktrees. */
  async function knownScope(scope: McpScope): Promise<McpScope> {
    if (scope.kind === 'user') {
      return scope
    }
    const wanted = canonical(expandHome(scope.projectPath.trim(), home))
    if (!(await projectPaths()).includes(wanted)) {
      throw new AppError('Unknown project', 404, 'not_found')
    }
    return { kind: scope.kind, projectPath: wanted }
  }

  function cwdOf(scope: McpScope): string {
    return scope.kind === 'user' ? home : scope.projectPath
  }

  async function add(mode: McpMode, scope: McpScope, name: string, native: NativeServer, secrets: string[]): Promise<void> {
    if (mode === 'file') {
      await files.write(scope, name, native)
    } else {
      await cli.addJson(name, native, scope.kind, cwdOf(scope), secrets)
    }
  }

  /** Puts the old entry back after a failed update: CLI first, then the file; 500 if both fail. */
  async function restore(scope: McpScope, name: string, previous: NativeServer, secrets: string[]): Promise<void> {
    try {
      await cli.addJson(name, previous, scope.kind, cwdOf(scope), secrets)
      return
    } catch {
      logger.warn({ name, scope: scope.kind }, 'CLI restore of MCP server failed, writing the file')
    }
    try {
      await files.write(scope, name, previous)
    } catch {
      logger.warn({ name, scope: scope.kind }, 'Could not restore MCP server after a failed update')
      throw new AppError(`MCP server "${name}" update failed and the entry was removed; re-add it manually`, 500, 'internal')
    }
  }

  return {
    async list(query = {}) {
      const all = await projectPaths()
      let paths = all
      if (query.projectPath !== undefined) {
        const wanted = canonical(expandHome(query.projectPath.trim(), home))
        if (!all.includes(wanted)) {
          throw new AppError('Unknown project', 404, 'not_found')
        }
        paths = [wanted]
      }
      const scopes: McpScope[] = [{ kind: 'user' }]
      for (const projectPath of paths) {
        scopes.push({ kind: 'project', projectPath }, { kind: 'local', projectPath })
      }
      const servers: McpServerEntryMasked[] = []
      for (const scope of scopes) {
        try {
          for (const entry of (await files.read(scope)).entries) {
            servers.push(maskMcpEntry({ ...entry, scope, source: 'file' }))
          }
        } catch (error) {
          // One broken `.mcp.json` must not hide every other scope.
          logger.warn({ scope: scope.kind, err: error instanceof AppError ? error.message : error }, 'Skipping MCP scope')
        }
      }
      return { servers, ...(await currentMode()) }
    },

    async upsert(request) {
      return serialize(async () => {
        const scope = await knownScope(request.scope)
        const { name } = request
        const existingRaw = (await files.read(scope)).raw.get(name)
        const existing = existingRaw === undefined ? undefined : fromNative(existingRaw)
        if (existingRaw !== undefined && !existing) {
          throw new AppError(`MCP server "${name}" uses a format Agent Hub does not manage; edit it by hand`, 409, 'conflict')
        }
        const config = resolveKeep(request.config, existing)
        const native = toNative(config, existingRaw)
        const secrets = secretsOf(config)
        const { mode } = await currentMode()
        if (mode === 'cli' && existingRaw !== undefined) {
          // No update subcommand exists: remove, add, and on failure put the old entry back.
          await cli.remove(name, scope.kind, cwdOf(scope))
          try {
            await add(mode, scope, name, native, secrets)
          } catch (error) {
            await restore(scope, name, existingRaw, [...secrets, ...(existing ? secretsOf(existing) : [])])
            throw error
          }
        } else {
          await add(mode, scope, name, native, secrets)
        }
        logger.info({ name, scope: scope.kind, mode, created: existingRaw === undefined }, 'MCP server saved')
        return { server: maskMcpEntry({ name, scope, config, source: mode }), created: existingRaw === undefined }
      })
    },

    async remove(request) {
      await serialize(async () => {
        const scope = await knownScope(request.scope)
        const { name } = request
        if (!(await files.read(scope)).raw.has(name)) {
          throw new AppError(`MCP server "${name}" not found`, 404, 'not_found')
        }
        const { mode } = await currentMode()
        if (mode === 'cli') {
          await cli.remove(name, scope.kind, cwdOf(scope))
        } else {
          await files.write(scope, name, undefined)
        }
        logger.info({ name, scope: scope.kind, mode }, 'MCP server removed')
      })
    },
  }
}
