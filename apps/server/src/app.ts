import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  API_ROUTES,
  APP_NAME,
  WS_PROTOCOL_VERSION,
  toValidationError,
  type ApiError,
  type AppConfig,
  type HealthResponse,
} from '@agent-hub/shared'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

export const BODY_LIMIT_BYTES = 1024 * 1024

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export interface BuildAppOptions {
  config: AppConfig
  logger: FastifyBaseLogger
}

/** Hook point for core routes and plugins; the security plugin (T11) registers here. */
function registerCore(app: FastifyInstance): void {
  app.get(API_ROUTES.health, (): HealthResponse => ({
    status: 'ok',
    name: APP_NAME,
    version,
    protocolVersion: WS_PROTOCOL_VERSION,
    uptimeSec: process.uptime(),
  }))
}

function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = { code: 'not_found', message: `Route ${request.method} ${request.url} not found` }
    return reply.code(404).send(body)
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(toValidationError(error))
    }
    const status = (error as { statusCode?: number }).statusCode
    const message = error instanceof Error ? error.message : String(error)
    if (status !== undefined && status >= 400 && status < 500) {
      const body: ApiError = { code: 'bad_request', message }
      return reply.code(status).send(body)
    }
    request.log.error({ err: error }, 'Unhandled error')
    const body: ApiError = { code: 'internal', message: 'Internal server error' }
    return reply.code(500).send(body)
  })
}

export function buildApp({ logger }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
  })
  registerErrorHandlers(app)
  registerCore(app)
  return app
}
