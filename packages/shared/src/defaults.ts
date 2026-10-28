import type { AppConfig } from './config.js'
import type { WorkspacePreset } from './preset.js'

/** Default HTTP/WebSocket port; overridden by the `PANEFUL_MANAGER_PORT` env variable. */
export const DEFAULT_PORT = 7337

/** The server only ever binds to loopback. */
export const BIND_HOST = '127.0.0.1'

export const PORT_ENV_VAR = 'PANEFUL_MANAGER_PORT'

/** Single-user v1: every session belongs to this host id. */
export const DEFAULT_HOST_ID = 'local'

export const DEFAULT_COMMAND = 'claude'

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30

/** Upper bound for terminal cols/rows accepted from clients. */
export const MAX_TERMINAL_SIZE = 1000

export const MAX_PANES_PER_TAB = 6

export const CONFIG_DIR_NAME = 'paneful-manager'

/** Default locations without `XDG_CONFIG_HOME` (see `resolveConfigDir`); `~` is expanded by the server. */
export const CONFIG_DIR = `~/.config/${CONFIG_DIR_NAME}`
export const CONFIG_FILE = `${CONFIG_DIR}/config.yaml`
export const WORKSPACES_DIR = `${CONFIG_DIR}/workspaces`

/** Default runtime state directory without `XDG_STATE_HOME` (see `resolveStateDir`). */
export const STATE_DIR = `~/.local/state/${CONFIG_DIR_NAME}`

/** Equals `AppConfigSchema.parse({})`; asserted by tests. */
export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  experimental: { agentTeams: false },
  confirmCloseTab: true,
  projects: [],
  logLevel: 'info',
  theme: 'dark',
} satisfies AppConfig

/** Example preset: four Claude Code panes side by side in one project. */
export const EXAMPLE_PRESET = {
  name: 'project1',
  description: 'Four Claude Code sessions side by side',
  autostart: false,
  tabs: [
    {
      title: 'project1',
      layout: { kind: 'row' },
      panes: [1, 2, 3, 4].map(n => ({
        cwd: '~/git/project1',
        command: DEFAULT_COMMAND,
        args: [],
        title: `agent ${n}`,
      })),
    },
  ],
} satisfies WorkspacePreset
