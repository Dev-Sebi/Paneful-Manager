import { PORT_ENV_VAR } from '@agent-hub/shared'
import { ConfigError, loadConfig } from './config/load-config.js'
import { createLogger } from './logger.js'
import { installShutdown, startServer, type RunningServer } from './start.js'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const logger = createLogger('info', process.env)

async function main(): Promise<void> {
  const config = await loadConfig({ env: process.env, logger })
  logger.level = config.logLevel

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
  logger.info('Open the login URL from "install.sh --login-url" (or "pnpm login-url" in a checkout) once per browser')

  installShutdown(server, process, code => process.exit(code), logger)
}

process.on('unhandledRejection', reason => {
  logger.fatal({ err: reason }, 'Unhandled rejection')
  process.exit(1)
})

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    fail(error.message)
  }
  logger.fatal({ err: error }, 'Startup failed')
  process.exit(1)
})
