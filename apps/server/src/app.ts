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
import type { HookSettings } from './hooks/install.js'
import { registerHooks } from './hooks/routes.js'
import { registerMcp, type McpDeps } from './mcp/routes.js'
import type { PresetLauncher } from './presets/launch.js'
import { registerPresets } from './presets/routes.js'
import type { PresetStore } from './presets/store.js'
import { registerScopes } from './scopes/routes.js'
import { runFile } from './scopes/run-git.js'
import type { DeviceAuth } from './security/device-auth.js'
import { registerSecurity } from './security/register-security.js'
import { createSessionToken } from './security/token.js'
import { authorizeUpgrade } from './security/upgrade.js'
import type { SessionEngine } from './sessions/engine.js'
import { registerSessions } from './sessions/routes.js'
import { registerStatic } from './static.js'
import { registerTeams } from './teams/routes.js'
import { createTeamsService } from './teams/service.js'
import type { TeamTemplateLauncher } from './team-templates/launch.js'
import { registerTeamTemplates } from './team-templates/routes.js'
import type { TeamTemplateStore } from './team-templates/store.js'
import { registerWorktrees, type WorktreeDeps } from './worktrees/routes.js'
import { registerWs, type WsHub } from './ws/plugin.js'

export const BODY_LIMIT_BYTES = 1024 * 1024

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export interface BuildAppOptions {
  config: AppConfig
  logger: FastifyBaseLogger
  /** Per-boot token; generated when omitted. */
  sessionToken?: string
  /** Persisted access key every API request must carry; loaded from the state directory by `startServer`. */
  accessKey: string
  /** Browser device login; the login routes only exist with it (see `registerSecurity`). */
  deviceAuth?: DeviceAuth
  /** Allows the Vite dev origins; defaults to `NODE_ENV === 'development'`. */
  dev?: boolean
  /** Extra dev origins (see `parseDevOrigins`); only used when `dev` is on. */
  devOrigins?: readonly string[]
  /** Session engine for `/api/sessions` and `/ws`; closed (tmux sessions kept) when the app closes. */
  engine?: SessionEngine
  /** Managed-file service; the file routes are only registered when it is given. */
  files?: FileService
  /** Persisted hook token; `POST /api/hooks` is only registered with it and an engine. */
  hookToken?: string
  /** Claude settings installer for the hook install, uninstall and status routes. */
  hookSettings?: HookSettings
  /** Live config store; defaults to an in-memory store seeded from `config`. */
  configStore?: ConfigStore
  /** Preset store for `/api/presets`; the launch route also needs the session engine's launcher. */
  presets?: { store: PresetStore; launcher?: PresetLauncher }
  /** Worktree helper; its routes are only registered when this is given. */
  worktrees?: Omit<WorktreeDeps, 'run'> & Partial<Pick<WorktreeDeps, 'run'>>
  /** MCP config service (and optional health runner); the MCP routes are only registered when it is given. */
  mcp?: McpDeps
  /** Agent teams board; its route is only registered when `claudeDir` is given and reads nothing while the flag is off. */
  teams?: { claudeDir: string }
  /** Team templates (experimental); every route answers 404 while `experimental.agentTeams` is off. */
  teamTemplates?: { store: TeamTemplateStore; launcher?: TeamTemplateLauncher }
  /** Built web app to serve with SPA fallback; API only when omitted. */
  webDist?: string
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

export function buildApp({ config, logger, sessionToken, accessKey, deviceAuth, dev, devOrigins = [], engine, files, presets, worktrees, mcp, configStore, teams, teamTemplates, webDist, hookToken, hookSettings }: BuildAppOptions): FastifyInstance {
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
  registerSecurity(app, { getPort, token, accessKey, deviceAuth, dev: isDev, devOrigins })
  registerCore(app, engine)
  const store = configStore ?? createConfigStore(config)
  registerConfig(app, { store })
  registerScopes(app, { getConfig: store.get })
  if (files) {
    registerFiles(app, { service: files })
    app.addHook('onClose', async () => files.close())
  }
  if (hookSettings !== undefined) {
    registerHooks(app, { getPort, settings: hookSettings })
  }
  // Registered after registerSecurity: its onRequest hook guards these routes, and /ws uses the same checks.
  let hub: WsHub | undefined
  if (engine !== undefined) {
    registerSessions(app, { engine })
    registerHooks(app, { getPort, engine, ...(hookToken === undefined ? {} : { token: hookToken }) })
    hub = registerWs(app, { engine, authorizeUpgrade: request => authorizeUpgrade(request, { port: getPort(), token, dev: isDev, devOrigins }) })
    app.addHook('onClose', async () => {
      await engine.close()
    })
  }
  if (presets) {
    registerPresets(app, presets)
  }
  if (worktrees) {
    registerWorktrees(app, { ...worktrees, run: worktrees.run ?? runFile })
  }
  if (mcp) {
    registerMcp(app, mcp)
  }
  if (teams) {
    const service = createTeamsService({
      claudeDir: teams.claudeDir,
      getConfig: store.get,
      onConfigChange: listener => store.onChange(listener),
      logger,
      broadcast: message => hub?.broadcast(message),
      ...(engine === undefined ? {} : { links: { listPanes: () => engine.tmux.listPanes(), sessions: () => engine.list() } }),
    })
    if (engine !== undefined) {
      const refresh = (): void => {
        void service.refresh()
      }
      engine.on('session.created', refresh)
      engine.on('session.removed', refresh)
      app.addHook('onClose', async () => {
        engine.off('session.created', refresh)
        engine.off('session.removed', refresh)
      })
    }
    registerTeams(app, { service })
    app.addHook('onClose', async () => service.close())
    app.addHook('onReady', async () => service.sync())
  }
  if (teamTemplates) {
    registerTeamTemplates(app, { ...teamTemplates, enabled: () => store.get().experimental.agentTeams })
  }
  if (webDist !== undefined) {
    registerStatic(app, webDist, getPort)
  }
  return app
}
