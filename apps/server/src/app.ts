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
import { registerConfig } from './config/routes.js'
import { createConfigStore, type ConfigStore } from './config/store.js'
import { AppError } from './errors.js'
import { registerFiles } from './files/routes.js'
import type { FileService } from './files/service.js'
import { registerMcp } from './mcp/routes.js'
import type { McpService } from './mcp/service.js'
import { registerScopes } from './scopes/routes.js'
import { runFile } from './scopes/run-git.js'
import { registerSecurity } from './security/register-security.js'
import { createSessionToken } from './security/token.js'
import { authorizeUpgrade } from './security/upgrade.js'
import type { SessionEngine } from './sessions/engine.js'
import { registerSessions } from './sessions/routes.js'
import { registerTeams } from './teams/routes.js'
import { createTeamsService } from './teams/service.js'
import { registerWorktrees, type WorktreeDeps } from './worktrees/routes.js'
import { registerWs, type WsHub } from './ws/plugin.js'

export const BODY_LIMIT_BYTES = 1024 * 1024

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export interface BuildAppOptions {
  config: AppConfig
  logger: FastifyBaseLogger
  /** Per-boot token; generated when omitted. */
  sessionToken?: string
  /** Allows the Vite dev origins; defaults to `NODE_ENV === 'development'`. */
  dev?: boolean
  /** Extra dev origins (see `parseDevOrigins`); only used when `dev` is on. */
  devOrigins?: readonly string[]
  /** Session engine for `/api/sessions` and `/ws`; closed (tmux sessions kept) when the app closes. */
  engine?: SessionEngine
  /** Managed-file service; the file routes are only registered when it is given. */
  files?: FileService
  /** Live config store; defaults to an in-memory store seeded from `config`. */
  configStore?: ConfigStore
  /** Worktree helper; its routes are only registered when this is given. */
  worktrees?: Omit<WorktreeDeps, 'run'> & Partial<Pick<WorktreeDeps, 'run'>>
  /** MCP config service; the MCP routes are only registered when it is given. */
  mcp?: McpService
  /** Agent teams board; its route is only registered when `claudeDir` is given and reads nothing while the flag is off. */
  teams?: { claudeDir: string }
}

function registerCore(app: FastifyInstance, engine: SessionEngine | undefined): void {
  app.get(API_ROUTES.health, (): HealthResponse => ({
    status: 'ok',
    name: APP_NAME,
    version,
    protocolVersion: WS_PROTOCOL_VERSION,
    uptimeSec: process.uptime(),
    tmux: engine?.available === true ? 'available' : 'unavailable',
  }))
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) {return 'unauthorized'}
  if (status === 403) {return 'forbidden'}
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

export function buildApp({ config, logger, sessionToken, dev, devOrigins = [], engine, files, worktrees, mcp, configStore, teams }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: () => randomUUID(),
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    forceCloseConnections: true,
  })
  registerErrorHandlers(app)
  const getPort = (): number => {
    const address = app.server.address()
    return typeof address === 'object' && address !== null ? address.port : config.port
  }
  const token = sessionToken ?? createSessionToken()
  const isDev = dev ?? process.env.NODE_ENV === 'development'
  registerSecurity(app, { getPort, token, dev: isDev, devOrigins })
  registerCore(app, engine)
  const store = configStore ?? createConfigStore(config)
  registerConfig(app, { store })
  registerScopes(app, { getConfig: store.get })
  if (files) {
    registerFiles(app, { service: files })
    app.addHook('onClose', async () => files.close())
  }
  // Registered after registerSecurity: its onRequest hook guards these routes, and /ws uses the same checks.
  let hub: WsHub | undefined
  if (engine !== undefined) {
    registerSessions(app, { engine })
    hub = registerWs(app, { engine, authorizeUpgrade: request => authorizeUpgrade(request, { port: getPort(), token, dev: isDev, devOrigins }) })
    app.addHook('onClose', async () => {
      await engine.close()
    })
  }
  if (worktrees) {
    registerWorktrees(app, { ...worktrees, run: worktrees.run ?? runFile })
  }
  if (mcp) {
    registerMcp(app, { service: mcp })
  }
  if (teams) {
    const service = createTeamsService({
      claudeDir: teams.claudeDir,
      getConfig: store.get,
      onConfigChange: listener => store.onChange(listener),
      logger,
      broadcast: message => hub?.broadcast(message),
    })
    registerTeams(app, { service })
    app.addHook('onClose', async () => service.close())
    app.addHook('onReady', async () => service.sync())
  }
  return app
}
