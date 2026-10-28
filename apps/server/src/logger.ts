import { pino, type Logger } from 'pino'
import type { LogLevel } from '@paneful-manager/shared'

/** Headers that carry credentials; never written to logs. */
const SECRET_HEADERS = ['authorization', 'x-paneful-key', 'x-paneful-token', 'x-paneful-hook-token', 'sec-websocket-protocol']

export const REDACTED_PATHS = SECRET_HEADERS.flatMap(name => [`req.headers["${name}"]`, `*.headers["${name}"]`])

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
