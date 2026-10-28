import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  MCP_MASKED_PLACEHOLDER,
  maskMcpArgs,
  maskMcpEntry,
  maskMcpUrl,
  type ListMcpServersQuery,
  type ListMcpServersResponse,
  type McpMode,
  type McpScope,
  type McpServerConfig,
  type McpServerConfigInput,
  type RemoveMcpServerRequest,
  type Scope,
  type UpsertMcpServerRequest,
  type UpsertMcpServerResponse,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import { createMcpApproval, type McpApproval } from './approval.js'
import { createClaudeCli, type ClaudeCli, type CliRun } from './cli.js'
import { createMcpFileStore, type McpFileStore } from './files.js'
import type { HealthTarget } from './health.js'
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
  /** Managed settings directory; defaults to the platform location (`/etc/claude-code` on Linux). */
  managedDir?: string
  now?: () => number
}

export interface McpService {
  list: (query?: ListMcpServersQuery) => Promise<ListMcpServersResponse>
  upsert: (request: UpsertMcpServerRequest) => Promise<UpsertMcpServerResponse>
  remove: (request: RemoveMcpServerRequest) => Promise<void>
  /** Unmasked entries for internal use (health checks); never send them to a client. */
  entries: (query?: ListMcpServersQuery) => Promise<HealthTarget[]>
  /** One unmasked entry; 404 when the project or the server is unknown. */
  entry: (name: string, scope: McpScope) => Promise<HealthTarget>
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

/** Env and header values plus every argument or URL that holds a secret-looking part (see `maskMcpArgs`). */
function secretsOf(config: McpServerConfig): string[] {
  if (config.transport === 'stdio') {
    const masked = maskMcpArgs(config.args)
    return [...Object.values(config.env), ...config.args.filter((arg, index) => masked[index] !== arg)]
  }
  return [...Object.values(config.headers), ...(maskMcpUrl(config.url) === config.url ? [] : [config.url])]
}

const reenter = (what: string): AppError =>
  new AppError(`${what} contains ${MCP_MASKED_PLACEHOLDER} but no stored value matches; enter the value again`, 400, 'bad_request')

/**
 * An argument still holding the placeholder gets the stored argument it was masked from (same position first).
 * The result must mask back to the request, so a stored secret cannot be moved to a position where it is shown.
 */
function unmaskArgs(args: string[], stored: string[] | undefined): string[] {
  const storedArgs = stored ?? []
  const masked = maskMcpArgs(storedArgs)
  const restored = args.map((arg, index) => {
    if (!arg.includes(MCP_MASKED_PLACEHOLDER)) {
      return arg
    }
    if (masked[index] === arg && storedArgs[index] !== undefined) {
      return storedArgs[index]
    }
    const candidates = new Set(storedArgs.filter((_, position) => masked[position] === arg))
    if (candidates.size !== 1) {
      throw reenter(`Argument ${index + 1}`)
    }
    return [...candidates][0] ?? arg
  })
  const remasked = maskMcpArgs(restored)
  args.forEach((arg, index) => {
    if (restored[index] !== arg && remasked[index] !== arg) {
      throw reenter(`Argument ${index + 1}`)
    }
  })
  return restored
}

function unmaskUrl(url: string, stored: string | undefined): string {
  if (!url.includes(MCP_MASKED_PLACEHOLDER)) {
    return url
  }
  if (stored === undefined || maskMcpUrl(stored) !== url) {
    throw reenter('The URL')
  }
  return stored
}

/**
 * Applies `{ keep: true }` per key from the stored entry (keys left out of the request are dropped) and puts stored
 * values back where args or the URL still carry `MCP_MASKED_PLACEHOLDER` from a masked response.
 */
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
    const stored = existing?.transport === 'stdio' ? existing : undefined
    return { ...input, args: unmaskArgs(input.args, stored?.args), env: merge(input.env, stored?.env, 'env') }
  }
  const stored = existing && existing.transport !== 'stdio' ? existing : undefined
  return { ...input, url: unmaskUrl(input.url, stored?.url), headers: merge(input.headers, stored?.headers, 'header') }
}

/**
 * MCP servers across Claude Code's user, project and local scopes; writes go through `claude mcp` when possible.
 * Entries with env or header values, or with secret-looking args or URL parts, are always written to the file, so no
 * secret is ever a process argument.
 */
export function createMcpService(options: McpServiceOptions): McpService {
  const { getScopes, env, logger, home = homedir() } = options
  const files: McpFileStore = createMcpFileStore({ env, backupDir: options.backupDir, home })
  const approval: McpApproval = createMcpApproval({ env, home, managedDir: options.managedDir })
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

  async function readEntries(query: ListMcpServersQuery = {}): Promise<HealthTarget[]> {
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
    const servers: HealthTarget[] = []
    const session = approval.session()
    for (const scope of scopes) {
      try {
        for (const entry of (await files.read(scope)).entries) {
          servers.push({ ...entry, scope, source: 'file', approved: await session.isApproved(scope, entry.name) })
        }
      } catch (error) {
        // One broken `.mcp.json` must not hide every other scope.
        logger.warn({ scope: scope.kind, err: error instanceof AppError ? error.message : error }, 'Skipping MCP scope')
      }
    }
    return servers
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

  /** Puts the old entry back after a failed update: CLI first (only without secret values), then the file; 500 if both fail. */
  async function restore(scope: McpScope, name: string, previous: NativeServer, previousSecrets: string[], secrets: string[]): Promise<void> {
    if (previousSecrets.length === 0) {
      try {
        await cli.addJson(name, previous, scope.kind, cwdOf(scope), secrets)
        return
      } catch {
        logger.warn({ name, scope: scope.kind }, 'CLI restore of MCP server failed, writing the file')
      }
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
      const servers = (await readEntries(query)).map(({ approved, ...entry }) => maskMcpEntry(entry, approved))
      return { servers, ...(await currentMode()) }
    },

    entries: readEntries,

    async entry(name, requested) {
      const scope = await knownScope(requested)
      const found = (await files.read(scope)).entries.find(candidate => candidate.name === name)
      if (!found) {
        throw new AppError(`MCP server "${name}" not found`, 404, 'not_found')
      }
      return { ...found, scope, source: 'file', approved: await approval.session().isApproved(scope, name) }
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
        const { mode: available } = await currentMode()
        // `claude mcp add-json` takes the entry as an argument, readable by other local users in /proc/<pid>/cmdline (SEC-016).
        const mode: McpMode = available === 'cli' && secrets.length === 0 ? 'cli' : 'file'
        if (mode === 'cli' && existingRaw !== undefined) {
          // No update subcommand exists: remove, add, and on failure put the old entry back.
          await cli.remove(name, scope.kind, cwdOf(scope))
          try {
            await add(mode, scope, name, native, secrets)
          } catch (error) {
            const previousSecrets = existing ? secretsOf(existing) : []
            await restore(scope, name, existingRaw, previousSecrets, [...secrets, ...previousSecrets])
            throw error
          }
        } else {
          await add(mode, scope, name, native, secrets)
        }
        logger.info({ name, scope: scope.kind, mode, created: existingRaw === undefined }, 'MCP server saved')
        return { server: maskMcpEntry({ name, scope, config, source: mode }, await approval.session().isApproved(scope, name)), created: existingRaw === undefined }
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
