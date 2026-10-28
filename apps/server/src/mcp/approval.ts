import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpScope } from '@paneful-manager/shared'
import { resolveClaudeJsonPath } from './files.js'

const MAX_SETTINGS_BYTES = 16 * 1024 * 1024

export interface McpApprovalOptions {
  env: Record<string, string | undefined>
  home: string
  /** Directory of `managed-settings.json` and `managed-settings.d/*.json`; defaults to the platform location. */
  managedDir?: string
}

interface Rules {
  enableAll: boolean
  enabled: string[]
  disabled: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

function rulesOf(value: unknown): Rules {
  const source = isRecord(value) ? value : {}
  return { enableAll: source.enableAllProjectMcpServers === true, enabled: names(source.enabledMcpjsonServers), disabled: names(source.disabledMcpjsonServers) }
}

/** `deniedMcpServers` holds `{ serverName }` objects; plain strings are accepted too. */
function deniedNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap(item => (typeof item === 'string' ? [item] : isRecord(item) && typeof item.serverName === 'string' ? [item.serverName] : []))
}

export function defaultManagedDir(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'
}

/** Project files are untrusted: `O_NONBLOCK` keeps a FIFO from blocking the open, and only regular files are read. */
async function readJson(path: string): Promise<unknown> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MAX_SETTINGS_BYTES) {
        return undefined
      }
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** `managed-settings.json` and the sorted `managed-settings.d/*.json` drop-ins (small local reader, see ADR 0009). */
async function readManaged(dir: string): Promise<unknown[]> {
  const dropIns = await readdir(join(dir, 'managed-settings.d')).catch(() => [] as string[])
  const files = [join(dir, 'managed-settings.json'), ...dropIns.filter(file => file.endsWith('.json')).toSorted().map(file => join(dir, 'managed-settings.d', file))]
  return Promise.all(files.map(readJson))
}

export interface McpApprovalSession {
  /** Whether Claude Code would run this entry; `project` scope (`.mcp.json`) needs an approval, managed settings can block any scope. */
  isApproved: (scope: McpScope, name: string) => Promise<boolean>
}

export interface McpApproval {
  /** A session reads every settings file at most once; use one per listing. */
  session: () => McpApprovalSession
}

/**
 * Managed `disabledMcpjsonServers` / `deniedMcpServers` block an entry in every scope. A project `.mcp.json` server then
 * runs only when the user approved it: `enableAllProjectMcpServers` / `enabledMcpjsonServers` in user settings, or in the
 * project's entry of `~/.claude.json` when that entry has `hasTrustDialogAccepted: true`. Project files
 * (`.claude/settings.local.json`, `.claude/settings.json`) can only disable; `disabledMcpjsonServers` wins from every file.
 */
export function createMcpApproval({ env, home, managedDir = defaultManagedDir() }: McpApprovalOptions): McpApproval {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return {
    session() {
      const cache = new Map<string, Promise<unknown>>()
      const cached = (key: string, load: () => Promise<unknown>): Promise<unknown> => {
        const found = cache.get(key) ?? load()
        cache.set(key, found)
        return found
      }
      const file = (path: string): Promise<unknown> => cached(path, () => readJson(path))
      return {
        async isApproved(scope, name) {
          const managed = await cached('managed', () => readManaged(managedDir))
          const managedRules = (Array.isArray(managed) ? managed : []).map(source => ({ disabled: rulesOf(source).disabled, denied: deniedNames(isRecord(source) ? source.deniedMcpServers : undefined) }))
          if (managedRules.some(rules => rules.disabled.includes(name) || rules.denied.includes(name))) {
            return false
          }
          if (scope.kind !== 'project') {
            return true
          }
          const { projectPath } = scope
          const [user, local, shared, global] = await Promise.all([
            file(join(configDir, 'settings.json')),
            file(join(projectPath, '.claude', 'settings.local.json')),
            file(join(projectPath, '.claude', 'settings.json')),
            file(resolveClaudeJsonPath(env, home)),
          ])
          const projects = isRecord(global) && isRecord(global.projects) ? global.projects : {}
          const entry = projects[projectPath]
          const userRules = rulesOf(user)
          const entryRules = rulesOf(entry)
          if ([userRules, entryRules, rulesOf(local), rulesOf(shared)].some(rules => rules.disabled.includes(name))) {
            return false
          }
          const approves = (rules: Rules): boolean => rules.enableAll || rules.enabled.includes(name)
          // Approvals stored in the project's entry only count once the trust dialog was accepted.
          const trusted = isRecord(entry) && entry.hasTrustDialogAccepted === true
          return approves(userRules) || (trusted && approves(entryRules))
        },
      }
    },
  }
}
