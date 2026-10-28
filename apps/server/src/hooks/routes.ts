import {
  API_ROUTES,
  HOOK_SESSION_HEADER,
  HOOK_TOKEN_HEADER,
  HookChangeRequestSchema,
  HookPayloadSchema,
  SessionIdSchema,
  hookTriggersPoll,
  mapHookEvent,
  type HookChangeResponse,
  type HookStatus,
  type SessionState,
} from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { tokenMatches } from '../security/token.js'
import type { HookSettings } from './install.js'
import type { StaleHookSessions } from './stale.js'

/** Tool payloads (e.g. a large file read) can exceed the global 1 MiB limit; a dropped event would leave a stale state. */
export const HOOK_BODY_LIMIT_BYTES = 16 * 1024 * 1024

export interface HookTarget {
  applyHookState: (sessionId: string, state: SessionState) => boolean
  poll: () => Promise<void>
}

export interface RegisterHooksOptions {
  getPort: () => number
  /** Receiver of hook states; `POST /api/hooks` is only registered together with `token`. */
  engine?: HookTarget
  /** Current hook token; a function when it can be rotated while the server runs. */
  token?: string | (() => string)
  /** Records sessions that send an outdated token. */
  stale?: StaleHookSessions
  /** Settings installer; the install, uninstall and status routes are only registered when given. */
  settings?: HookSettings
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `POST /api/hooks` answers 204 without a body (an empty 2xx is a plain success for Claude Code) or 401.
 * The security plugin already rejected requests with an Origin; the per-boot token does not apply here.
 */
function registerReceiver(app: FastifyInstance, engine: HookTarget, token: () => string, stale: StaleHookSessions | undefined): void {
  app.register(async scope => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: HOOK_BODY_LIMIT_BYTES }, (_request, body, done) => {
      try {
        done(null, JSON.parse(String(body)))
      } catch {
        done(null, undefined)
      }
    })
    scope.post(API_ROUTES.hooks, {
      bodyLimit: HOOK_BODY_LIMIT_BYTES,
      onRequest: async (request, reply) => {
        const candidate = single(request.headers[HOOK_TOKEN_HEADER])
        const sessionId = single(request.headers[HOOK_SESSION_HEADER])
        // Claude sessions not started by Agent Hub send both headers empty; they cannot change anything.
        if (candidate === '' && sessionId === '') {
          return reply.code(204).send()
        }
        if (!tokenMatches(candidate, token())) {
          // A known session with an old token was started before a rotation; it fails closed until restarted.
          stale?.mark([sessionId])
          throw new AppError('Invalid hook token', 401, 'unauthorized')
        }
      },
    }, async (request, reply) => {
      const sessionId = single(request.headers[HOOK_SESSION_HEADER])
      const payload = HookPayloadSchema.safeParse(request.body)
      if (!SessionIdSchema.safeParse(sessionId).success || !payload.success) {
        request.log.debug({ sessionId }, 'Ignoring hook request without a valid session id or payload')
        return reply.code(204).send()
      }
      stale?.clear(sessionId)
      const event = payload.data.hook_event_name
      const state = mapHookEvent(event, payload.data)
      const known = state === null || engine.applyHookState(sessionId, state)
      if (!known) {
        request.log.debug({ sessionId, event }, 'Ignoring hook for an unknown session')
      } else if (hookTriggersPoll(event)) {
        engine.poll().catch((error: unknown) => request.log.warn({ err: error }, 'Poll after SessionEnd failed'))
      }
      return reply.code(204).send()
    })
  })
}

/** Hook receiver plus the explicit install, uninstall and status routes (normal Origin and token checks). */
export function registerHooks(app: FastifyInstance, { getPort, engine, token, stale, settings }: RegisterHooksOptions): void {
  if (engine !== undefined && token !== undefined) {
    registerReceiver(app, engine, typeof token === 'string' ? () => token : token, stale)
  }
  if (settings === undefined) {
    return
  }
  app.get(API_ROUTES.hooksStatus, (): Promise<HookStatus> => settings.status(getPort()))
  app.post(API_ROUTES.hooksInstall, (request): Promise<HookChangeResponse> => {
    HookChangeRequestSchema.parse(request.body ?? {})
    return settings.install(getPort())
  })
  app.post(API_ROUTES.hooksUninstall, (request): Promise<HookChangeResponse> => {
    HookChangeRequestSchema.parse(request.body ?? {})
    return settings.uninstall(getPort())
  })
}
