import { createRequire } from 'node:module'
import { join } from 'node:path'
import { BIND_HOST, HOOK_ENV, resolveStateDir, type AppConfig } from '@agent-hub/shared'
import type { FastifyBaseLogger } from 'fastify'
import { buildApp } from './app.js'
import { resolveConfigFile, resolveTeamTemplatesDir, resolveWorkspacesDir } from './config/load-config.js'
import { createConfigStore } from './config/store.js'
import { createBackupStore } from './files/backups.js'
import { createFileService } from './files/service.js'
import { AppError } from './errors.js'
import { assertBackupDirOutsideScopes } from './files/state-dir.js'
import { createHookSettings, resolveClaudeSettingsPath } from './hooks/install.js'
import { StaleHookSessions } from './hooks/stale.js'
import { loadHookToken, rotateHookToken } from './hooks/token.js'
import { loadAccessKey } from './security/access-key.js'
import { DeviceAuth } from './security/device-auth.js'
import { createHealthRunner } from './mcp/health.js'
import { createMcpService } from './mcp/service.js'
import { expandHome } from './paths.js'
import { createPresetLauncher } from './presets/launch.js'
import { LaunchLedger } from './presets/ledger.js'
import { createPresetStore } from './presets/store.js'
import { discoverScopes } from './scopes/discover.js'
import { assertLoopbackAddress, DEV_ORIGINS_ENV_VAR, parseDevOrigins } from './security/origin.js'
import { SessionEngine } from './sessions/engine.js'
import { resolveWebDist } from './static.js'
import { resolveClaudeDir } from './teams/reader.js'
import { createTeamTemplateLauncher } from './team-templates/launch.js'
import { TeamLaunchLedger } from './team-templates/ledger.js'
import { createTeamTemplateStore } from './team-templates/store.js'
import type { Tmux } from './tmux/tmux.js'

/** The release version lives in the root `package.json` (see docs/releasing.md); the workspace packages stay `0.0.0`. */
export const RELEASE_VERSION = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version

/** Backups live in `<stateDir>/backups` (see the file-write policy). */
export const BACKUPS_DIR_NAME = 'backups'

export const SHUTDOWN_TIMEOUT_MS = 5000

export interface RunningServer {
  url: string
  port: number
  /** Resolves true after a clean close, false when `SHUTDOWN_TIMEOUT_MS` elapsed first. */
  shutdown: () => Promise<boolean>
}

export interface StartOptions {
  env?: Record<string, string | undefined>
  /** tmux wrapper for the session engine; tests pass one with a private socket. */
  tmux?: Tmux
  /** Config directory holding `config.yaml`; defaults to the XDG location. */
  configDir?: string
}

export async function startServer(config: AppConfig, logger: FastifyBaseLogger, { env = process.env, tmux, configDir }: StartOptions = {}): Promise<RunningServer> {
  const stateDir = expandHome(resolveStateDir(env))
  const backupDir = join(stateDir, BACKUPS_DIR_NAME)
  let listeningPort = config.port
  const store = createConfigStore(config, {
    file: resolveConfigFile(env, configDir),
    getListeningPort: () => listeningPort,
    validate: async next => {
      try {
        assertBackupDirOutsideScopes(backupDir, await discoverScopes({ config: next, env, logger }))
      } catch (error) {
        throw new AppError((error as Error).message, 400, 'bad_request')
      }
    },
  })
  const getScopes = () => discoverScopes({ config: store.get(), env, logger })
  assertBackupDirOutsideScopes(backupDir, await getScopes())
  // Renewed when the installed version changes: older builds exposed the token in tmux's argv (SEC-017).
  const loadedHookToken = await loadHookToken(stateDir, { version: RELEASE_VERSION })
  let hookToken = loadedHookToken.token
  const accessKey = await loadAccessKey(stateDir)
  // The URL is only known after listen; sessions are created through the server, so never before that.
  let serverUrl = `http://${BIND_HOST}:${config.port}`
  const sessionEnv = (): Record<string, string> => ({ [HOOK_ENV.url]: serverUrl })
  // The hook token never goes into tmux's argv, where other local users could read it from /proc.
  const secretEnv = (): Record<string, string> => ({ [HOOK_ENV.token]: hookToken })
  const engine = new SessionEngine({ stateDir, logger, sessionEnv, secretEnv, ...(tmux === undefined ? {} : { tmux }) })
  await engine.start()
  const staleHookSessions = new StaleHookSessions(id => engine.get(id)?.lifecycle === 'running')
  const markRunningStale = (): void => staleHookSessions.mark(engine.list().map(session => session.id))
  if (loadedHookToken.renewed) {
    // Re-adopted sessions keep the environment they were started with, so they still carry the old token.
    markRunningStale()
    if (staleHookSessions.list().length > 0) {
      logger.warn('Hook token renewed; running sessions report no status until they are restarted')
    }
  }
  const files = createFileService({ getScopes, backupDir, logger })
  const hookSettings = createHookSettings({
    settingsPath: resolveClaudeSettingsPath(env),
    backups: createBackupStore({ dir: backupDir }),
    staleSessions: () => staleHookSessions.list(),
    // New sessions read the token through `secretEnv`, which rewrites `session-env.tmux` before every start.
    onChange: async () => {
      hookToken = await rotateHookToken(stateDir, { version: RELEASE_VERSION })
      markRunningStale()
    },
  })
  const webDist = resolveWebDist(env)
  const mcp = createMcpService({ getScopes, env, backupDir, logger })
  const devOrigins = parseDevOrigins(env[DEV_ORIGINS_ENV_VAR], message => logger.warn(message))
  const backups = createBackupStore({ dir: backupDir })
  const presetStore = createPresetStore({ dir: resolveWorkspacesDir(env, configDir), logger, backups })
  const ledger = new LaunchLedger(stateDir, logger)
  await ledger.load()
  const launcher = createPresetLauncher({ store: presetStore, engine, ledger, logger })
  const teamTemplateStore = createTeamTemplateStore({ dir: resolveTeamTemplatesDir(env, configDir), logger, backups })
  const teamLedger = new TeamLaunchLedger(stateDir, logger)
  await teamLedger.load()
  const teamLauncher = createTeamTemplateLauncher({ store: teamTemplateStore, engine, ledger: teamLedger, logger })
  const app = buildApp({
    config,
    logger,
    accessKey,
    deviceAuth: new DeviceAuth(stateDir),
    devOrigins,
    files,
    engine,
    presets: { store: presetStore, launcher },
    worktrees: { getScopes, backups },
    mcp: { service: mcp, health: createHealthRunner({ logger }) },
    configStore: store,
    teams: { claudeDir: resolveClaudeDir(env) },
    teamTemplates: { store: teamTemplateStore, launcher: teamLauncher },
    ...(webDist === undefined ? {} : { webDist }),
    hookToken: () => hookToken,
    hookStaleSessions: staleHookSessions,
    hookSettings,
  })
  try {
    await app.listen({ host: BIND_HOST, port: config.port })
  } catch (error) {
    await app.close()
    throw error
  }
  const address = app.server.address()
  try {
    assertLoopbackAddress(address)
  } catch (error) {
    await app.close()
    throw error
  }
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  listeningPort = port
  serverUrl = `http://${BIND_HOST}:${port}`
  // Detached so startup is not delayed; shutdown waits for it so no session starts after close.
  const autostart = launcher.autostart()
  const shutdown = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS)
    })
    const closed = autostart.then(() => app.close()).then(() => true as const)
    const clean = await Promise.race([closed, timeout])
    clearTimeout(timer)
    if (!clean) {
      logger.warn(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS} ms`)
    }
    return clean
  }
  return { url: `http://${BIND_HOST}:${port}`, port, shutdown }
}

export interface SignalSource {
  once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
  on: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown
}

/** Shuts down on the first SIGINT/SIGTERM (exit 0, or 1 on timeout/failure); later signals are ignored. */
export function installShutdown(
  server: Pick<RunningServer, 'shutdown'>,
  proc: SignalSource,
  exit: (code: number) => void,
  logger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
): void {
  let shuttingDown = false
  const stop = (signal: string): void => {
    if (shuttingDown) {
      logger.info(`Received ${signal} during shutdown, ignoring`)
      return
    }
    shuttingDown = true
    logger.info(`Received ${signal}, shutting down`)
    server.shutdown().then(
      clean => exit(clean ? 0 : 1),
      (error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed')
        exit(1)
      },
    )
  }
  proc.on('SIGINT', () => stop('SIGINT'))
  proc.on('SIGTERM', () => stop('SIGTERM'))
}
