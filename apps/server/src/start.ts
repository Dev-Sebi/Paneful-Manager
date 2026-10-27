import { BIND_HOST, type AppConfig } from '@agent-hub/shared'
import type { FastifyBaseLogger } from 'fastify'
import { buildApp } from './app.js'

export const SHUTDOWN_TIMEOUT_MS = 5000

export interface RunningServer {
  url: string
  port: number
  /** Stops accepting connections and closes; resolves after at most `SHUTDOWN_TIMEOUT_MS`. */
  shutdown: () => Promise<void>
}

export async function startServer(config: AppConfig, logger: FastifyBaseLogger): Promise<RunningServer> {
  const app = buildApp({ config, logger })
  await app.listen({ host: BIND_HOST, port: config.port })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const shutdown = async (): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
    })
    await Promise.race([app.close(), timeout])
    clearTimeout(timer)
  }
  return { url: `http://${BIND_HOST}:${port}`, port, shutdown }
}
