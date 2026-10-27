import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpScope } from '@agent-hub/shared'
import { resolveClaudeJsonPath } from './files.js'

const MAX_SETTINGS_BYTES = 16 * 1024 * 1024

export interface McpApprovalOptions {
  env: Record<string, string | undefined>
  home: string
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

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8')
    return text.length > MAX_SETTINGS_BYTES ? undefined : (JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

export interface McpApproval {
  /** Whether Claude Code would run this entry; only `project` scope (`.mcp.json`) needs an approval. */
  isApproved: (scope: McpScope, name: string) => Promise<boolean>
}

/**
 * Project `.mcp.json` servers come from the repository, so they run only when the user approved them:
 * `enableAllProjectMcpServers` / `enabledMcpjsonServers` in user settings, `.claude/settings.local.json` or the
 * project's entry in `~/.claude.json`; `disabledMcpjsonServers` from any of these or the shared `.claude/settings.json` wins.
 * The committed `.claude/settings.json` can only disable, because the repository must not approve itself.
 */
export function createMcpApproval({ env, home }: McpApprovalOptions): McpApproval {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  return {
    async isApproved(scope, name) {
      if (scope.kind !== 'project') {
        return true
      }
      const { projectPath } = scope
      const [user, local, shared, global] = await Promise.all([
        readJson(join(configDir, 'settings.json')),
        readJson(join(projectPath, '.claude', 'settings.local.json')),
        readJson(join(projectPath, '.claude', 'settings.json')),
        readJson(resolveClaudeJsonPath(env, home)),
      ])
      const projects = isRecord(global) && isRecord(global.projects) ? global.projects : {}
      const trusted = [rulesOf(user), rulesOf(local), rulesOf(projects[projectPath])]
      if ([...trusted, rulesOf(shared)].some(rules => rules.disabled.includes(name))) {
        return false
      }
      return trusted.some(rules => rules.enableAll || rules.enabled.includes(name))
    },
  }
}
