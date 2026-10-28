import { ACCESS_KEY_FRAGMENT_PARAM } from '@agent-hub/shared'
import { ref } from 'vue'

/** localStorage is scoped to scheme, host and port, so no other local server can read the key. */
export const ACCESS_KEY_STORAGE_KEY = 'agent-hub.access-key.v1'

/** True while no key is stored or the server rejected it; the shell shows the login hint then. */
export const loginRequired = ref(false)

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

/** Stores the key from a login URL (`#key=<key>`) and removes the fragment from the address bar and history entry. */
export function consumeLoginFragment (loc: Location = location, hist: History = history): boolean {
  const key = new URLSearchParams(loc.hash.slice(1)).get(ACCESS_KEY_FRAGMENT_PARAM)?.trim()
  if (!key) {
    return false
  }
  storage()?.setItem(ACCESS_KEY_STORAGE_KEY, key)
  hist.replaceState(hist.state, '', `${loc.pathname}${loc.search}`)
  return true
}

/** Takes a key from the URL if present, then flags the login hint when none is stored. */
export function initAccess (loc: Location = location, hist: History = history): void {
  consumeLoginFragment(loc, hist)
  loginRequired.value = readAccessKey() === undefined
}
