import { pino, type Logger } from 'pino'
import type { LogLevel } from '@agent-hub/shared'

/** Pretty output only in development, where `pino-pretty` is installed. */
export function createLogger(level: LogLevel, env: Record<string, string | undefined>): Logger {
  return pino({
    level,
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  })
}
