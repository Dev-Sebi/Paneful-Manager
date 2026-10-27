import { join } from 'node:path'
import { BIND_HOST, resolveStateDir, type AppConfig } from '@agent-hub/shared'
import type { FastifyBaseLogger } from 'fastify'
import { buildApp } from './app.js'
import { resolveConfigFile } from './config/load-config.js'
import { createConfigStore } from './config/store.js'
import { createBackupStore } from './files/backups.js'
import { createFileService } from './files/service.js'
import { AppError } from './errors.js'
import { assertBackupDirOutsideScopes } from './files/state-dir.js'
import { createMcpService } from './mcp/service.js'
import { expandHome } from './paths.js'
import { discoverScopes } from './scopes/discover.js'
import { assertLoopbackAddress } from './security/origin.js'
import { SessionEngine } from './sessions/engine.js'
import { resolveWebDist } from './static.js'
import type { Tmux } from './tmux/tmux.js'

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
  const engine = new SessionEngine({ stateDir, logger, ...(tmux === undefined ? {} : { tmux }) })
  await engine.start()
  const files = createFileService({ getScopes, backupDir, logger })
  const webDist = resolveWebDist(env)
  const mcp = createMcpService({ getScopes, env, backupDir, logger })
  const app = buildApp({ config, logger, files, engine, worktrees: { getScopes, backups: createBackupStore({ dir: backupDir }) }, mcp, configStore: store, ...(webDist === undefined ? {} : { webDist }) })
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
  const shutdown = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS)
    })
    const closed = app.close().then(() => true as const)
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
