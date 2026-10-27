export interface Section {
  key: string
  label: string
  icon: string
  to: string
  /** Only shown when `experimental.agentTeams` is enabled. */
  flagged?: boolean
}

/** Sidebar sections in display order; `Ctrl+1..5` selects the first five visible ones. */
export const SECTIONS: readonly Section[] = [
  { key: 'workspaces', label: 'Workspaces', icon: 'mdi-console', to: '/workspaces' },
  { key: 'skills', label: 'Skills', icon: 'mdi-lightning-bolt-outline', to: '/skills' },
  { key: 'claude-md', label: 'CLAUDE.md', icon: 'mdi-file-document-outline', to: '/claude-md' },
  { key: 'mcp', label: 'MCP', icon: 'mdi-connection', to: '/mcp' },
  { key: 'teams', label: 'Teams', icon: 'mdi-account-group-outline', to: '/teams', flagged: true },
  { key: 'settings', label: 'Settings', icon: 'mdi-cog-outline', to: '/settings' },
]
