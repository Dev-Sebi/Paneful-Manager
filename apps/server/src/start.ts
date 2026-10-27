import { BIND_HOST, type AppConfig } from '@agent-hub/shared'
import type { FastifyBaseLogger } from 'fastify'
import { buildApp } from './app.js'
import { createBackupStore } from './files/backups.js'
import { createFileService } from './files/service.js'
import { assertBackupDirOutsideScopes, resolveBackupDir } from './files/state-dir.js'
import { discoverScopes } from './scopes/discover.js'
import { assertLoopbackAddress } from './security/origin.js'

export const SHUTDOWN_TIMEOUT_MS = 5000

export interface RunningServer {
  url: string
  port: number
  /** Resolves true after a clean close, false when `SHUTDOWN_TIMEOUT_MS` elapsed first. */
  shutdown: () => Promise<boolean>
}

export interface StartOptions {
  env?: Record<string, string | undefined>
}

export async function startServer(config: AppConfig, logger: FastifyBaseLogger, { env = process.env }: StartOptions = {}): Promise<RunningServer> {
  const getScopes = () => discoverScopes({ config, env, logger })
  const backupDir = resolveBackupDir(env)
  assertBackupDirOutsideScopes(backupDir, await getScopes())
  const files = createFileService({ getScopes, backupDir, logger })
  const app = buildApp({ config, logger, files, worktrees: { getScopes, backups: createBackupStore({ dir: backupDir }) } })
  await app.listen({ host: BIND_HOST, port: config.port })
  const address = app.server.address()
  try {
    assertLoopbackAddress(address)
  } catch (error) {
    await app.close()
    throw error
  }
  const port = typeof address === 'object' && address !== null ? address.port : config.port
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
