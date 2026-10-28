import { ACCESS_KEY_HEADER, API_ROUTES, SessionTokenResponseSchema } from '@agent-hub/shared'
import { loginRequired, readAccessKey } from './access'

let cached: Promise<string> | undefined

async function requestToken (): Promise<string> {
  const key = readAccessKey()
  const response = await fetch(API_ROUTES.sessionToken, { headers: { accept: 'application/json', ...(key ? { [ACCESS_KEY_HEADER]: key } : {}) } })
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
