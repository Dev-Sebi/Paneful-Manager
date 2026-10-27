import type { ApiError, ApiErrorCode, CreateSessionRequestInput, PatchConfigRequest, z } from '@agent-hub/shared'
import {
  API_ROUTES,
  ApiErrorSchema,
  CreateSessionResponseSchema,
  GetConfigResponseSchema,
  HealthResponseSchema,
  KillSessionResponseSchema,
  ListPresetsResponseSchema,
  ListSessionsResponseSchema,
  PatchConfigResponseSchema,
  ScopesResponseSchema,
  SESSION_TOKEN_HEADER,
} from '@agent-hub/shared'
import { getToken, refreshToken } from './token'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const RETRY_STATUSES = new Set([401, 403])

/** Error raised for non-2xx responses (typed code from the server) and for unreachable servers (`status` 0). */
export class ApiClientError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | 'network' | 'invalid_response'
  readonly details: ApiError['details']

  constructor (status: number, code: ApiClientError['code'], message: string, details?: ApiError['details']) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface FetchJsonInit<S extends z.ZodType> extends Omit<RequestInit, 'body'> {
  /** Shared schema the response body must satisfy. */
  schema: S
  /** Serialized as JSON. */
  body?: unknown
}

async function send (route: string, init: RequestInit, mutating: boolean, token?: string): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body !== undefined) {
    headers.set('content-type', 'application/json')
  }
  if (mutating && token) {
    headers.set(SESSION_TOKEN_HEADER, token)
  }
  try {
    return await fetch(route, { ...init, headers })
  } catch (error) {
    throw new ApiClientError(0, 'network', error instanceof Error ? error.message : 'Network error')
  }
}

async function toError (response: Response): Promise<ApiClientError> {
  const body: unknown = await response.json().catch(() => undefined)
  const parsed = ApiErrorSchema.safeParse(body)
  if (parsed.success) {
    return new ApiClientError(response.status, parsed.data.code, parsed.data.message, parsed.data.details)
  }
  return new ApiClientError(response.status, 'internal', response.statusText || `Request failed with status ${response.status}`)
}

/**
 * Fetches `route`, sends the session token on mutations and retries a mutation once with a fresh token on 401/403.
 * The body is validated with `init.schema`.
 */
export async function fetchJson<S extends z.ZodType> (route: string, init: FetchJsonInit<S>): Promise<z.infer<S>> {
  const { schema, body, ...rest } = init
  const method = (rest.method ?? 'GET').toUpperCase()
  const mutating = !SAFE_METHODS.has(method)
  const request: RequestInit = { ...rest, method, body: body === undefined ? undefined : JSON.stringify(body) }

  let response = await send(route, request, mutating, mutating ? await getToken().catch(() => undefined) : undefined)
  if (mutating && RETRY_STATUSES.has(response.status)) {
    const fresh = await refreshToken().catch(() => undefined)
    if (fresh) {
      response = await send(route, request, mutating, fresh)
    }
  }
  if (!response.ok) {
    throw await toError(response)
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) {
    throw new ApiClientError(response.status, 'invalid_response', 'Response did not match the API contract')
  }
  return parsed.data
}

/** Typed endpoint helpers; each validates with the matching shared schema. */
export const api = {
  health: () => fetchJson(API_ROUTES.health, { schema: HealthResponseSchema }),
  getConfig: () => fetchJson(API_ROUTES.config, { schema: GetConfigResponseSchema }),
  patchConfig: (patch: PatchConfigRequest) =>
    fetchJson(API_ROUTES.config, { schema: PatchConfigResponseSchema, method: 'PATCH', body: patch }),
  listScopes: () => fetchJson(API_ROUTES.scopes, { schema: ScopesResponseSchema }),
  listSessions: () => fetchJson(API_ROUTES.sessions, { schema: ListSessionsResponseSchema }),
  sessions: {
    create: (request: CreateSessionRequestInput) =>
      fetchJson(API_ROUTES.sessions, { schema: CreateSessionResponseSchema, method: 'POST', body: request }),
    kill: (id: string) =>
      fetchJson(API_ROUTES.session.replace(':id', encodeURIComponent(id)), { schema: KillSessionResponseSchema, method: 'DELETE' }),
  },
  listPresets: () => fetchJson(API_ROUTES.presets, { schema: ListPresetsResponseSchema }),
}
