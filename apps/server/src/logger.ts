import { pino, type Logger } from 'pino'
import type { LogLevel } from '@agent-hub/shared'

/** Headers that carry credentials; never written to logs. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-agent-hub-token"]',
  'req.headers["sec-websocket-protocol"]',
]

/** Pretty output only in development, where `pino-pretty` is installed. */
export function createLogger(
  level: LogLevel,
  env: Record<string, string | undefined>,
  destination?: NodeJS.WritableStream,
): Logger {
  const options = {
    level,
    redact: REDACTED_PATHS,
    ...(env.NODE_ENV === 'development' && destination === undefined ? { transport: { target: 'pino-pretty' } } : {}),
  }
  return destination === undefined ? pino(options) : pino(options, destination)
}
