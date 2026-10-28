import { ACCESS_KEY_HEADER, API_PREFIX, API_ROUTES, SESSION_TOKEN_HEADER, type SessionTokenResponse } from '@agent-hub/shared'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../errors.js'
import { isAllowedHost, isAllowedOrigin } from './origin.js'
import { tokenMatches } from './token.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface SecurityOptions {
  /** Port the browser talks to; read per request because tests listen on port 0. */
  getPort: () => number
  token: string
  /** Persisted access key; required on every API request except health and `POST /api/hooks`. */
  accessKey: string
  dev: boolean
  /** Extra loopback dev origins, already validated by `parseDevOrigins`. */
  devOrigins?: readonly string[]
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const isApiPath = (path: string): boolean => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)

/**
 * Whether a request needs the access key. Decided on the matched route, because the router decodes the path
 * (`/%61pi/...` matches `/api/...`), and on the raw path as a second line. Fails closed: unmatched requests need it.
 * Only health (installer, monitoring; reveals the version only) and non-API routes (static files, SPA) are exempt.
 */
function needsAccessKey(method: string, route: string | undefined, path: string): boolean {
  if (route === undefined || isApiPath(route) || isApiPath(path)) {
    return !((method === 'GET' || method === 'HEAD') && route === API_ROUTES.health)
  }
  return false
}

/**
 * Host, Origin, access key and per-boot token checks plus security headers for every request; serves the token bootstrap route.
 * API requests need the access key, mutations also an allowed Origin and the token.
 * Only `POST /api/hooks` is exempt from both and must come without Origin.
 */
export function registerSecurity(app: FastifyInstance, { getPort, token, accessKey, dev, devOrigins = [] }: SecurityOptions): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    const path = request.url.split('?', 1)[0] ?? ''
    const route = request.routeOptions.url
    if (isApiPath(path) || (route !== undefined && isApiPath(route))) {
      reply.header('cache-control', 'no-store')
    }
    const port = getPort()
    if (!isAllowedHost(request.headers.host, port)) {
      throw new AppError('Host not allowed', 403, 'forbidden')
    }
    const origin = single(request.headers.origin)
    const hasOrigin = request.headers.origin !== undefined
    const isHookPost = request.method === 'POST' && request.routeOptions.url === API_ROUTES.hooks
    if (isHookPost) {
      if (hasOrigin) {
        throw new AppError('Browser requests are not allowed on this route', 403, 'forbidden')
      }
      return
    }
    if (hasOrigin && !isAllowedOrigin(origin, port, dev, devOrigins)) {
      throw new AppError('Origin not allowed', 403, 'forbidden')
    }
    if (needsAccessKey(request.method, route, path) && !tokenMatches(single(request.headers[ACCESS_KEY_HEADER]), accessKey)) {
      throw new AppError('Missing or invalid access key; open the login URL once', 401, 'login_required')
    }
    if (MUTATING_METHODS.has(request.method) && (!hasOrigin || !tokenMatches(single(request.headers[SESSION_TOKEN_HEADER]), token))) {
      throw new AppError('Missing Origin or invalid token', 401, 'unauthorized')
    }
  })

  app.get(API_ROUTES.sessionToken, (request): SessionTokenResponse => {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError('Cross-site requests are not allowed', 403, 'forbidden')
    }
    return { token }
  })
}
