import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  API_ROUTES,
  APP_NAME,
  WS_PROTOCOL_VERSION,
  isZodError,
  toValidationError,
  type ApiError,
  type ApiErrorCode,
  type AppConfig,
  type HealthResponse,
} from '@agent-hub/shared'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { AppError } from './errors.js'
import type { SessionEngine } from './sessions/engine.js'
import { registerSessions } from './sessions/routes.js'
import { registerWs, type AuthorizeUpgrade } from './ws/plugin.js'

export const BODY_LIMIT_BYTES = 1024 * 1024

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export interface BuildAppOptions {
  config: AppConfig
  logger: FastifyBaseLogger
  /** Session engine; closed (ptys detached, tmux kept) when the app closes. */
  engine?: SessionEngine
  authorizeUpgrade?: AuthorizeUpgrade
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

function codeForStatus(status: number): ApiErrorCode {
  if (status === 404) {return 'not_found'}
  if (status === 409) {return 'conflict'}
  return status >= 400 && status < 500 ? 'bad_request' : 'internal'
}

function isClientSafe(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return error instanceof AppError || (typeof code === 'string' && code.startsWith('FST_'))
}

function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiError = { code: 'not_found', message: `Route ${request.method} ${request.url} not found` }
    return reply.code(404).send(body)
  })
  app.setErrorHandler((error, request, reply) => {
    if (isZodError(error)) {
      return reply.code(400).send(toValidationError(error))
    }
    const raw = (error as { statusCode?: unknown }).statusCode
    const status = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error')
    }
    const code = error instanceof AppError ? error.code : codeForStatus(status)
    const safe = error instanceof AppError || (status < 500 && isClientSafe(error))
    const message = safe ? (error as Error).message : status < 500 ? 'Bad request' : 'Internal server error'
    const details = error instanceof AppError ? error.details : undefined
    const body = { code, message, ...(details === undefined ? {} : { details }) } as ApiError
    return reply.code(status).send(body)
  })
}

export function buildApp({ logger, engine, authorizeUpgrade }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    forceCloseConnections: true,
  })
  registerErrorHandlers(app)
  registerCore(app)
  if (engine !== undefined) {
    registerSessions(app, { engine })
    registerWs(app, { engine, ...(authorizeUpgrade === undefined ? {} : { authorizeUpgrade }) })
    app.addHook('onClose', async () => {
      await engine.close()
    })
  }
  return app
}
