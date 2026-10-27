import { PORT_ENV_VAR, resolveStateDir } from '@agent-hub/shared'
import { ConfigError, loadConfig } from './config/load-config.js'
import { createLogger } from './logger.js'
import { expandHome } from './paths.js'
import { SessionEngine } from './sessions/engine.js'
import { installShutdown, startServer, type RunningServer } from './start.js'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const logger = createLogger('info', process.env)

async function main(): Promise<void> {
  const config = await loadConfig({ env: process.env, logger })
  logger.level = config.logLevel

  const engine = new SessionEngine({ stateDir: expandHome(resolveStateDir(process.env)), logger })
  await engine.start()

  let server: RunningServer
  try {
    server = await startServer(config, logger, { engine })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      fail(`Port ${config.port} is already in use. Change \`port\` in config.yaml or set ${PORT_ENV_VAR}.`)
    }
    throw error
  }
  logger.info(`Agent Hub listening on ${server.url}`)

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
