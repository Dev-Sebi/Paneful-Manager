import {
  ACCESS_KEY_HEADER,
  API_PREFIX,
  API_ROUTES,
  type AuthChallengeResponse,
  type AuthSessionResponse,
  CreateAuthSessionRequestSchema,
  RegisterDeviceRequestSchema,
  type RegisterDeviceResponse,
  SESSION_TOKEN_HEADER,
  type SessionTokenResponse,
} from '@agent-hub/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../errors.js'
import type { DeviceAuth } from './device-auth.js'
import { isAllowedHost, isAllowedOrigin } from './origin.js'
import { tokenMatches } from './token.js'

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface SecurityOptions {
  /** Port the browser talks to; read per request because tests listen on port 0. */
  getPort: () => number
  token: string
  /** Persisted access key for scripts; it or a browser session key is required on every API request except health, hooks and login. */
  accessKey: string
  /** Browser device login (ADR 0013); without it only the access key is accepted and the login routes do not exist. */
  deviceAuth?: DeviceAuth
  dev: boolean
  /** Extra loopback dev origins, already validated by `parseDevOrigins`. */
  devOrigins?: readonly string[]
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const isApiPath = (path: string): boolean => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)

/** Device login routes: they bring their own proof (login code or signature), so they need neither key nor token. */
function isLoginRoute(method: string, route: string | undefined): boolean {
  return (method === 'GET' && route === API_ROUTES.authChallenge)
    || (method === 'POST' && (route === API_ROUTES.authRegister || route === API_ROUTES.authSession))
}

function rejectCrossSite(request: FastifyRequest): void {
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new AppError('Cross-site requests are not allowed', 403, 'forbidden')
  }
}

const loginFailed = (message: string): AppError => new AppError(message, 401, 'login_required')

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
export function registerSecurity(app: FastifyInstance, { getPort, token, accessKey, deviceAuth, dev, devOrigins = [] }: SecurityOptions): void {
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
    if (deviceAuth !== undefined && isLoginRoute(request.method, route)) {
      return
    }
    const presented = single(request.headers[ACCESS_KEY_HEADER])
    if (needsAccessKey(request.method, route, path) && !tokenMatches(presented, accessKey) && deviceAuth?.hasSession(presented) !== true) {
      throw loginFailed('Not logged in; open a login URL from install.sh --login-url in this browser')
    }
    if (MUTATING_METHODS.has(request.method) && (!hasOrigin || !tokenMatches(single(request.headers[SESSION_TOKEN_HEADER]), token))) {
      throw new AppError('Missing Origin or invalid token', 401, 'unauthorized')
    }
  })

  app.get(API_ROUTES.sessionToken, (request): SessionTokenResponse => {
    rejectCrossSite(request)
    return { token }
  })

  if (deviceAuth === undefined) {
    return
  }
  app.get(API_ROUTES.authChallenge, (request): AuthChallengeResponse => {
    rejectCrossSite(request)
    return { nonce: deviceAuth.challenge() }
  })
  app.post(API_ROUTES.authRegister, async (request): Promise<RegisterDeviceResponse> => {
    rejectCrossSite(request)
    const { code, publicKey } = RegisterDeviceRequestSchema.parse(request.body)
    const deviceId = await deviceAuth.register(code, publicKey)
    if (deviceId === undefined) {
      throw loginFailed('This login URL is used or expired; print a new one with install.sh --login-url')
    }
    return { deviceId }
  })
  app.post(API_ROUTES.authSession, async (request): Promise<AuthSessionResponse> => {
    rejectCrossSite(request)
    const { deviceId, nonce, signature } = CreateAuthSessionRequestSchema.parse(request.body)
    const session = await deviceAuth.createSession(deviceId, nonce, signature)
    if (session === undefined) {
      throw loginFailed('This browser is not registered (or was logged out); open a new login URL')
    }
    return session
  })
}
