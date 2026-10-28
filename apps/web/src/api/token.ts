import { API_ROUTES, SessionTokenResponseSchema } from '@paneful-manager/shared'
import { authorizedFetch, loginRequired } from './access'

let cached: Promise<string> | undefined

async function requestToken (): Promise<string> {
  const response = await authorizedFetch(API_ROUTES.sessionToken, { headers: { accept: 'application/json' } })
  if (response.status === 401) {
    loginRequired.value = true
  }
  if (!response.ok) {
    throw new Error(`Token request failed with status ${response.status}`)
  }
  return SessionTokenResponseSchema.parse(await response.json()).token
}

/** Lazily fetches the per-boot session token and caches it for the page lifetime. */
export function getToken (): Promise<string> {
  cached ??= requestToken().catch((error: unknown) => {
    cached = undefined
    throw error
  })
  return cached
}

/** Drops the cached token and fetches a fresh one. */
export function refreshToken (): Promise<string> {
  cached = undefined
  return getToken()
}
