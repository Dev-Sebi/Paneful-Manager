import { ACCESS_KEY_FRAGMENT_PARAM, BIND_HOST } from '@agent-hub/shared'
import { ref } from 'vue'

/** localStorage is scoped to scheme, host and port, so no other local server can read the key. */
export const ACCESS_KEY_STORAGE_KEY = 'agent-hub.access-key.v1'

/** True while no key is stored or the server rejected it; the shell shows the login hint then. */
export const loginRequired = ref(false)

/** True when the page runs on another host name than the bound address; the key is never kept there. */
export const untrustedHost = ref(false)

/**
 * Only the bound address is safe for the key: `localhost` and `[::1]` may reach `::1`,
 * where another local user can listen on the same port and read this origin's storage.
 */
export function isTrustedHost (hostname: string): boolean {
  return hostname === BIND_HOST
}

function storage (): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function readAccessKey (): string | undefined {
  return storage()?.getItem(ACCESS_KEY_STORAGE_KEY) ?? undefined
}

/**
 * Stores the key from a login URL (`#key=<key>`) and removes the fragment from the address bar and history entry.
 * On an untrusted host the fragment is removed without storing the key.
 */
export function consumeLoginFragment (loc: Location = location, hist: History = history): boolean {
  const key = new URLSearchParams(loc.hash.slice(1)).get(ACCESS_KEY_FRAGMENT_PARAM)?.trim()
  if (!key) {
    return false
  }
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`)
  if (!isTrustedHost(loc.hostname)) {
    return false
  }
  storage()?.setItem(ACCESS_KEY_STORAGE_KEY, key)
  return true
}

/** Takes a key from the URL if present, then flags the login hint when none is stored; drops keys kept on an untrusted host. */
export function initAccess (loc: Location = location, hist: History = history): void {
  consumeLoginFragment(loc, hist)
  untrustedHost.value = !isTrustedHost(loc.hostname)
  if (untrustedHost.value) {
    storage()?.removeItem(ACCESS_KEY_STORAGE_KEY)
  }
  loginRequired.value = readAccessKey() === undefined
}
