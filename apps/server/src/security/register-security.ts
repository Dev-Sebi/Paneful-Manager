import { API_PREFIX, API_ROUTES, SESSION_TOKEN_HEADER, type SessionTokenResponse } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { isAllowedHost, isAllowedOrigin } from './origin.js'
import { tokenMatches } from './token.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface SecurityOptions {
  /** Port the browser talks to; read per request because tests listen on port 0. */
  getPort: () => number
  token: string
  dev: boolean
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Host, Origin and per-boot token checks plus security headers for every request; serves the token bootstrap route. */
export function registerSecurity(app: FastifyInstance, { getPort, token, dev }: SecurityOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    const path = request.url.split('?', 1)[0] ?? ''
    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      reply.header('cache-control', 'no-store')
    }
    const port = getPort()
    if (!isAllowedHost(request.headers.host, port)) {
      throw new AppError('Host not allowed', 403, 'forbidden')
    }
    const origin = single(request.headers.origin)
    const isHookRoute = request.routeOptions.url === API_ROUTES.hooks
    if (isHookRoute && request.headers.origin !== undefined) {
      throw new AppError('Browser requests are not allowed on this route', 403, 'forbidden')
    }
    if (request.headers.origin !== undefined && !isAllowedOrigin(origin, port, dev)) {
      throw new AppError('Origin not allowed', 403, 'forbidden')
    }
    if (MUTATING_METHODS.has(request.method) && !isHookRoute && !tokenMatches(single(request.headers[SESSION_TOKEN_HEADER]), token)) {
      throw new AppError('Missing or invalid token', 401, 'unauthorized')
    }
  })

  app.get(API_ROUTES.sessionToken, (): SessionTokenResponse => ({ token }))
}
