import { PORT_ENV_VAR } from '@agent-hub/shared'
import { ConfigError, loadConfig } from './config/load-config.js'
import { createLogger } from './logger.js'
import { startServer, type RunningServer } from './start.js'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main(): Promise<void> {
  const bootstrap = createLogger('info', process.env)
  const config = await loadConfig({ env: process.env, logger: bootstrap })
  const logger = createLogger(config.logLevel, process.env)

  let server: RunningServer
  try {
    server = await startServer(config, logger)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail(`Port ${config.port} is already in use. Change \`port\` in config.yaml or set ${PORT_ENV_VAR}.`)
    }
    throw error
  }
  logger.info(`Agent Hub listening on ${server.url}`)

  const stop = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down`)
    server.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'Shutdown failed')
        process.exit(1)
      },
    )
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection:', reason)
  process.exit(1)
})

main().catch((error: unknown) => {
  fail(error instanceof ConfigError ? error.message : `Startup failed: ${String(error)}`)
})
