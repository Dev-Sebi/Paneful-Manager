import type { DeviceStore } from './device'
import {
  ACCESS_KEY_HEADER,
  API_ROUTES,
  ApiErrorSchema,
  AuthChallengeResponseSchema,
  AuthSessionResponseSchema,
  BIND_HOST,
  LOGIN_FRAGMENT_PARAM,
  RegisterDeviceResponseSchema,
} from '@paneful-manager/shared'
import { ref } from 'vue'
import { createDeviceKey, indexedDbDeviceStore, signChallenge } from './device'

/** Where builds before the device login (and the rename) kept the access key itself; it is deleted on every start. */
export const LEGACY_ACCESS_KEY_STORAGE_KEY = 'agent-hub.access-key.v1'

/** True while the server refuses this browser; the shell shows the login hint then. */
export const loginRequired = ref(false)

/** True when the login URL just opened was already used or has expired. */
export const loginCodeRejected = ref(false)

/** True when the page runs on another host name than the bound address; no login happens there. */
export const untrustedHost = ref(false)

let deviceStore: DeviceStore = indexedDbDeviceStore
/** One-time code from the login URL; only ever in memory until the server consumed it. */
let pendingCode: string | undefined
/** Session key of this page, in memory only; a new page load signs a new challenge. */
let session: Promise<string | undefined> | undefined
let currentKey: string | undefined

/** Test seam for the IndexedDB device store; also forgets the current session. */
export function useDeviceStore (store: DeviceStore): void {
  deviceStore = store
  pendingCode = undefined
  session = undefined
  currentKey = undefined
}

/**
 * Only the bound address is safe: `localhost` and `[::1]` may reach `::1`,
 * where another local user can listen on the same port and own that origin.
 */
export function isTrustedHost (hostname: string): boolean {
  return hostname === BIND_HOST
}

function dropLegacyKey (): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_ACCESS_KEY_STORAGE_KEY)
  } catch {
    // Storage blocked: there is nothing to delete either.
  }
}

/**
 * Takes the one-time code from a login URL (`#login=<code>`) and removes the fragment from the address bar and history entry.
 * On an untrusted host the fragment is removed and the code dropped.
 */
export function consumeLoginFragment (loc: Location = location, hist: History = history): boolean {
  const code = new URLSearchParams(loc.hash.slice(1)).get(LOGIN_FRAGMENT_PARAM)?.trim()
  if (!code) {
    return false
  }
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`)
  if (!isTrustedHost(loc.hostname)) {
    return false
  }
  pendingCode = code
  session = undefined
  currentKey = undefined
  return true
}

/** Runs before the router reads the URL: drops keys of older builds and takes a login code from the URL. */
export function initAccess (loc: Location = location, hist: History = history): void {
  dropLegacyKey()
  consumeLoginFragment(loc, hist)
  untrustedHost.value = !isTrustedHost(loc.hostname)
  if (untrustedHost.value) {
    loginRequired.value = true
  }
}

async function postJson (route: string, body: object): Promise<Response> {
  return fetch(route, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

async function register (code: string): Promise<boolean> {
  const { privateKey, publicKey } = await createDeviceKey()
  const response = await postJson(API_ROUTES.authRegister, { code, publicKey })
  if (!response.ok) {
    return false
  }
  const { deviceId } = RegisterDeviceResponseSchema.parse(await response.json())
  await deviceStore.save({ id: deviceId, privateKey })
  return true
}

/** Signs a fresh server nonce with the stored device key; undefined when this browser has no device or the server refuses it. */
async function establish (): Promise<string | undefined> {
  if (untrustedHost.value) {
    return undefined
  }
  const code = pendingCode
  pendingCode = undefined
  if (code !== undefined && !(await register(code))) {
    loginCodeRejected.value = true
    loginRequired.value = true
    return undefined
  }
  const device = await deviceStore.load()
  if (device === undefined) {
    return undefined
  }
  const challenge = await fetch(API_ROUTES.authChallenge, { headers: { accept: 'application/json' } })
  if (!challenge.ok) {
    throw new Error(`Challenge failed with status ${challenge.status}`)
  }
  const { nonce } = AuthChallengeResponseSchema.parse(await challenge.json())
  const response = await postJson(API_ROUTES.authSession, { deviceId: device.id, nonce, signature: await signChallenge(device.privateKey, nonce) })
  if (response.status === 401) {
    loginRequired.value = true
    return undefined
  }
  if (!response.ok) {
    throw new Error(`Session request failed with status ${response.status}`)
  }
  loginCodeRejected.value = false
  loginRequired.value = false
  return AuthSessionResponseSchema.parse(await response.json()).key
}

/**
 * Session key for `X-Paneful-Key`, established once per page. Undefined without a usable device:
 * the request then goes out without it and the server decides (scripts and e2e send the access key themselves).
 * A failure to reach the server is not remembered, so the next request tries again.
 */
export function sessionKey (): Promise<string | undefined> {
  session ??= establish().then(
    key => {
      currentKey = key
      return key
    },
    () => {
      session = undefined
      return undefined
    },
  )
  return session
}

/** Replaces a session key the server no longer accepts (expired, server restarted); parallel callers share one renewal. */
export function renewSession (rejected: string): Promise<string | undefined> {
  if (currentKey === rejected) {
    session = undefined
    currentKey = undefined
  }
  return sessionKey()
}

async function isLoginRequired (response: Response): Promise<boolean> {
  if (response.status !== 401) {
    return false
  }
  const body: unknown = await response.clone().json().catch(() => undefined)
  return ApiErrorSchema.safeParse(body).data?.code === 'login_required'
}

function withKey (init: RequestInit, key: string | undefined): RequestInit {
  const headers = new Headers(init.headers)
  if (key !== undefined) {
    headers.set(ACCESS_KEY_HEADER, key)
  }
  return { ...init, headers }
}

/** `fetch` with the session key; renews the key once when the server answers `login_required`. */
export async function authorizedFetch (route: string, init: RequestInit = {}): Promise<Response> {
  const key = await sessionKey()
  const response = await fetch(route, withKey(init, key))
  if (key === undefined || !(await isLoginRequired(response))) {
    return response
  }
  const fresh = await renewSession(key)
  return fresh === undefined ? response : fetch(route, withKey(init, fresh))
}
