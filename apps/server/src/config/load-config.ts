import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppConfigSchema, resolveConfigDir, resolvePort, type AppConfig } from '@agent-hub/shared'
import { parse } from 'yaml'
import { expandHome } from '../paths.js'
import type { BaseLogger } from 'pino'

export const CONFIG_FILE_NAME = 'config.yaml'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export interface LoadConfigOptions {
  env: Record<string, string | undefined>
  configDir?: string
  logger?: Pick<BaseLogger, 'info'>
}

async function readConfigFile(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new ConfigError(`Cannot read config file ${file}: ${(error as Error).message}`)
  }
}

/** Loads and validates `<configDir>/config.yaml`; a missing file yields the defaults. */
export async function loadConfig({ env, configDir, logger }: LoadConfigOptions): Promise<AppConfig> {
  const file = join(expandHome(configDir ?? resolveConfigDir(env)), CONFIG_FILE_NAME)
  const text = await readConfigFile(file)
  let raw: unknown = {}
  if (text === undefined) {
    logger?.info(`No config file at ${file}, using defaults`)
  } else {
    try {
      raw = parse(text) ?? {}
    } catch (error) {
      throw new ConfigError(`Invalid YAML in ${file}: ${(error as Error).message}`)
    }
  }
  const result = AppConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(issue => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`Invalid config in ${file}:\n${issues}`)
  }
  try {
    return { ...result.data, port: resolvePort(result.data.port, env.AGENT_HUB_PORT) }
  } catch (error) {
    throw new ConfigError((error as Error).message)
  }
}
