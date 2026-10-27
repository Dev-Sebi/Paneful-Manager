import type { McpMode, McpScope, McpServerEntryMasked, RemoveMcpServerRequest, UpsertMcpServerRequestInput } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/client'
import { useScopesStore } from '@/stores/scopes'

export interface McpSection {
  key: string
  scope: McpScope
  label: string
  servers: McpServerEntryMasked[]
}

export interface McpGroup {
  key: string
  kind: 'user' | 'project' | 'worktree'
  label: string
  path?: string
  branch?: string
  sections: McpSection[]
}

export function scopeKey (scope: McpScope): string {
  return scope.kind === 'user' ? 'user' : `${scope.kind}:${scope.projectPath}`
}

export function entryKey (entry: Pick<McpServerEntryMasked, 'name' | 'scope'>): string {
  return `${scopeKey(entry.scope)}::${entry.name}`
}

export function scopeLabel (scope: McpScope): string {
  if (scope.kind === 'user') {
    return 'user scope'
  }
  return `${scope.kind === 'project' ? 'project scope (.mcp.json)' : 'local scope'} of ${scope.projectPath}`
}

function baseName (path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path
}

export const useMcpStore = defineStore('mcp', () => {
  const entries = ref<McpServerEntryMasked[]>([])
  const mode = ref<McpMode>()
  const cliVersion = ref<string>()
  const loading = ref(false)
  const error = ref<string>()

  const groups = computed<McpGroup[]>(() => {
    const byScope = new Map<string, McpServerEntryMasked[]>()
    for (const entry of entries.value) {
      const key = scopeKey(entry.scope)
      byScope.set(key, [...(byScope.get(key) ?? []), entry])
    }
    const servers = (scope: McpScope) => byScope.get(scopeKey(scope)) ?? []
    const section = (scope: McpScope, label: string): McpSection => ({ key: scopeKey(scope), scope, label, servers: servers(scope) })

    const result: McpGroup[] = [{
      key: 'user',
      kind: 'user',
      label: 'User',
      sections: [section({ kind: 'user' }, 'User')],
    }]
    const seen = new Set<string>()
    const projectGroup = (path: string, kind: 'project' | 'worktree', branch?: string): McpGroup => ({
      key: `${kind}:${path}`,
      kind,
      label: baseName(path),
      path,
      branch,
      sections: [
        section({ kind: 'project', projectPath: path }, 'Project (.mcp.json)'),
        section({ kind: 'local', projectPath: path }, 'Local (private)'),
      ],
    })
    for (const scope of useScopesStore().scopes) {
      if (scope.kind !== 'global' && !seen.has(scope.path)) {
        seen.add(scope.path)
        result.push(projectGroup(scope.path, scope.kind, scope.kind === 'worktree' ? scope.branch : undefined))
      }
    }
    for (const entry of entries.value) {
      if (entry.scope.kind !== 'user' && !seen.has(entry.scope.projectPath)) {
        seen.add(entry.scope.projectPath)
        result.push(projectGroup(entry.scope.projectPath, 'project'))
      }
    }
    return result
  })

  async function reload () {
    loading.value = true
    try {
      const response = await api.mcp.list()
      entries.value = response.servers
      mode.value = response.mode
      cliVersion.value = response.cliVersion
      error.value = undefined
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load MCP servers'
    } finally {
      loading.value = false
    }
  }

  /** Saves a server and reloads the list; rejects with the API error so a form can show it. */
  async function upsert (request: UpsertMcpServerRequestInput) {
    const response = await api.mcp.upsert(request)
    await reload()
    return response
  }

  async function remove (request: RemoveMcpServerRequest) {
    const response = await api.mcp.remove(request)
    await reload()
    return response
  }

  return { entries, mode, cliVersion, loading, error, groups, reload, upsert, remove }
})
