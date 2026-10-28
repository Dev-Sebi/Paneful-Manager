import { z } from 'zod'
import { CONFIG_DIR_NAME, DEFAULT_PORT } from './defaults.js'
import { PathSchema } from './scope.js'

export const PortSchema = z.int().min(1).max(65535)

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
export type LogLevel = z.infer<typeof LogLevelSchema>

export const ThemeSchema = z.enum(['dark', 'light', 'system'])
export type Theme = z.infer<typeof ThemeSchema>

export const ExperimentalConfigSchema = z.looseObject({
  agentTeams: z.boolean().default(false),
})

/** App config file `~/.config/paneful-manager/config.yaml`; an empty file yields `DEFAULT_CONFIG`. */
export const AppConfigSchema = z.looseObject({
  port: PortSchema.default(DEFAULT_PORT),
  experimental: ExperimentalConfigSchema.prefault({}),
  confirmCloseTab: z.boolean().default(true),
  projects: z.array(PathSchema).default(() => []),
  logLevel: LogLevelSchema.default('info'),
  theme: ThemeSchema.default('dark'),
})
export type AppConfig = z.infer<typeof AppConfigSchema>
export type AppConfigInput = z.input<typeof AppConfigSchema>

/** Partial update sent by `PATCH /api/config`; nested objects merge, arrays replace. */
export const ConfigPatchSchema = z.strictObject({
  port: PortSchema.optional(),
  experimental: z.strictObject({ agentTeams: z.boolean().optional() }).optional(),
  confirmCloseTab: z.boolean().optional(),
  projects: z.array(PathSchema).optional(),
  logLevel: LogLevelSchema.optional(),
  theme: ThemeSchema.optional(),
})
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>

/** Applies a patch to a config without mutating either. */
export function applyConfigPatch(config: AppConfig, patch: ConfigPatch): AppConfig {
  const { experimental, ...rest } = patch
  const defined = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
  const experimentalDefined = Object.fromEntries(
    Object.entries(experimental ?? {}).filter(([, value]) => value !== undefined),
  )
  return AppConfigSchema.parse({
    ...config,
    ...defined,
    experimental: { ...config.experimental, ...experimentalDefined },
  })
}

/** Effective port: `PANEFUL_MANAGER_PORT` (digits only, 1-65535) wins over the config file. */
export function resolvePort(configPort: number, envValue: string | undefined): number {
  if (envValue === undefined || envValue.trim() === '') {
    return configPort
  }
  const value = envValue.trim()
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!PortSchema.safeParse(port).success) {
    throw new Error(`Invalid PANEFUL_MANAGER_PORT "${envValue}": expected an integer between 1 and 65535`)
  }
  return port
}

function resolveXdgDir(value: string | undefined, fallback: string): string {
  const xdg = value?.trim()
  const base = xdg?.startsWith('/') ? xdg.replace(/\/+$/, '') : fallback
  return `${base}/${CONFIG_DIR_NAME}`
}

/** Config directory: `$XDG_CONFIG_HOME/paneful-manager`, falling back to `~/.config/paneful-manager` (a relative value is ignored per the XDG spec). */
export function resolveConfigDir(env: Record<string, string | undefined>): string {
  return resolveXdgDir(env.XDG_CONFIG_HOME, '~/.config')
}

/** State directory: `$XDG_STATE_HOME/paneful-manager`, falling back to `~/.local/state/paneful-manager` (relative values are ignored). */
export function resolveStateDir(env: Record<string, string | undefined>): string {
  return resolveXdgDir(env.XDG_STATE_HOME, '~/.local/state')
}
