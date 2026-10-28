// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:7337/" }
import type { DeviceStore, StoredDevice } from './device'
import { API_ROUTES, type DevicePublicKey, deviceSignatureMessage } from '@paneful-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '@/test/fixtures'
import {
  authorizedFetch,
  consumeLoginFragment,
  initAccess,
  isTrustedHost,
  LEGACY_ACCESS_KEY_STORAGE_KEY,
  loginCodeRejected,
  loginRequired,
  untrustedHost,
  useDeviceStore,
} from './access'

const CODE = 'c'.repeat(43)

/** Location of the same page reached under another host name, e.g. `localhost`, which may resolve to `::1`. */
function locationAt (hostname: string): Location {
  return { hostname, hash: location.hash, pathname: location.pathname, search: location.search } as Location
}

function memoryStore (): DeviceStore & { device?: StoredDevice } {
  const store: DeviceStore & { device?: StoredDevice } = {
    load: async () => store.device,
    save: async device => {
      store.device = device
    },
  }
  return store
}

function fromBase64Url (value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.codePointAt(0) ?? 0)
}

/** Minimal stand-in for the server's device login: one login code, nonces, signature check, session keys. */
function fakeServer () {
  const server = {
    code: CODE as string | undefined,
    devices: new Map<string, CryptoKey>(),
    nonces: new Set<string>(),
    sessions: new Set<string>(),
    sessionsIssued: 0,
    /** Session key header of every API call (not the login routes). */
    apiKeys: [] as Array<string | null>,
  }
  const refuse = () => jsonResponse({ code: 'login_required', message: 'no' }, 401)
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const route = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
    if (route === API_ROUTES.authRegister) {
      if (body.code !== server.code) {
        return refuse()
      }
      server.code = undefined
      const id = `device-${server.devices.size}`.padEnd(43, 'd')
      const key = await crypto.subtle.importKey('jwk', body.publicKey as DevicePublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      server.devices.set(id, key)
      return jsonResponse({ deviceId: id })
    }
    if (route === API_ROUTES.authChallenge) {
      const nonce = `nonce-${server.nonces.size}-${Math.random()}`.replace('.', '').padEnd(43, 'n')
      server.nonces.add(nonce)
      return jsonResponse({ nonce })
    }
    if (route === API_ROUTES.authSession) {
      const key = server.devices.get(body.deviceId as string)
      const nonce = body.nonce as string
      const fresh = server.nonces.delete(nonce)
      const signed = key !== undefined && await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(body.signature as string), new TextEncoder().encode(deviceSignatureMessage(nonce)),
      )
      if (!fresh || !signed) {
        return refuse()
      }
      const session = `session-${++server.sessionsIssued}`.padEnd(43, 's')
      server.sessions.add(session)
      return jsonResponse({ key: session, expiresInSec: 900 })
    }
    const presented = new Headers(init?.headers).get('x-paneful-key')
    server.apiKeys.push(presented)
    return presented !== null && server.sessions.has(presented) ? jsonResponse({ ok: true }) : refuse()
  }
  return { server, fetchMock: vi.fn(handler) }
}

let store: ReturnType<typeof memoryStore>
let fake: ReturnType<typeof fakeServer>

beforeEach(() => {
  store = memoryStore()
  useDeviceStore(store)
  fake = fakeServer()
  vi.stubGlobal('fetch', fake.fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  history.replaceState(null, '', '/')
  loginRequired.value = false
  loginCodeRejected.value = false
  untrustedHost.value = false
})

/** A new page load: same browser storage, nothing in memory. */
function reloadPage (): void {
  useDeviceStore(store)
}

describe('login fragment', () => {
  it('takes the one-time code from the login URL, strips the fragment and stores nothing in localStorage', () => {
    history.replaceState(null, '', `/workspaces?x=1#login=${CODE}`)
    expect(consumeLoginFragment()).toBe(true)
    expect(location.hash).toBe('')
    expect(`${location.pathname}${location.search}`).toBe('/workspaces?x=1')
    expect(localStorage).toHaveLength(0)
  })

  it('ignores other or empty fragments', () => {
    for (const hash of ['', '#other=1', '#login=', '#login=%20', '#key=old-access-key']) {
      history.replaceState(null, '', `/${hash}`)
      expect(consumeLoginFragment()).toBe(false)
    }
  })

  it('trusts only the bound address', () => {
    expect(isTrustedHost('127.0.0.1')).toBe(true)
    for (const hostname of ['localhost', '[::1]', '::1', '127.0.0.2', 'LOCALHOST']) {
      expect(isTrustedHost(hostname)).toBe(false)
    }
  })

  it('never logs in on another host name', async () => {
    history.replaceState(null, '', `/workspaces#login=${CODE}`)
    initAccess(locationAt('localhost'))
    expect(location.hash).toBe('')
    expect(untrustedHost.value).toBe(true)
    expect(loginRequired.value).toBe(true)
    await authorizedFetch('/api/x')
    expect(fake.server.code).toBe(CODE)
    expect(store.device).toBeUndefined()
  })

  it('deletes the access key that older builds kept in localStorage', () => {
    localStorage.setItem(LEGACY_ACCESS_KEY_STORAGE_KEY, 'old-access-key')
    initAccess()
    expect(localStorage.getItem(LEGACY_ACCESS_KEY_STORAGE_KEY)).toBeNull()
  })
})

describe('device login', () => {
  it('registers a non-extractable device key with the code and sends only the session key', async () => {
    history.replaceState(null, '', `/#login=${CODE}`)
    initAccess()
    expect((await authorizedFetch('/api/x')).ok).toBe(true)
    expect(fake.server.code).toBeUndefined()
    const privateKey = store.device?.privateKey
    expect(privateKey?.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('jwk', privateKey as CryptoKey)).rejects.toThrow()
    expect(fake.server.apiKeys).toEqual([expect.stringMatching(/^session-1/)])
    expect(JSON.stringify(fake.fetchMock.mock.calls)).not.toContain('"d":')
  })

  it('signs a fresh challenge on every page load without a new login URL', async () => {
    history.replaceState(null, '', `/#login=${CODE}`)
    initAccess()
    await authorizedFetch('/api/x')
    await authorizedFetch('/api/x')
    reloadPage()
    initAccess()
    expect((await authorizedFetch('/api/x')).ok).toBe(true)
    expect(fake.server.apiKeys).toEqual([expect.stringMatching(/^session-1/), expect.stringMatching(/^session-1/), expect.stringMatching(/^session-2/)])
  })

  it('renews an expired session key once, shared by parallel requests', async () => {
    history.replaceState(null, '', `/#login=${CODE}`)
    initAccess()
    await authorizedFetch('/api/x')
    fake.server.sessions.clear()
    const responses = await Promise.all([authorizedFetch('/api/x'), authorizedFetch('/api/y')])
    expect(responses.every(response => response.ok)).toBe(true)
    expect(fake.server.sessionsIssued).toBe(2)
  })

  it('shows the login hint for a used or expired login URL', async () => {
    fake.server.code = undefined
    history.replaceState(null, '', `/#login=${CODE}`)
    initAccess()
    expect((await authorizedFetch('/api/x')).status).toBe(401)
    expect(loginCodeRejected.value).toBe(true)
    expect(loginRequired.value).toBe(true)
    expect(store.device).toBeUndefined()
    expect(fake.server.apiKeys).toEqual([null])
  })

  it('shows the login hint once the server forgot the device (logged out)', async () => {
    history.replaceState(null, '', `/#login=${CODE}`)
    initAccess()
    await authorizedFetch('/api/x')
    fake.server.devices.clear()
    reloadPage()
    expect((await authorizedFetch('/api/x')).status).toBe(401)
    expect(loginRequired.value).toBe(true)
    expect(loginCodeRejected.value).toBe(false)
  })

  it('sends requests without a key when this browser has no device, so the server decides', async () => {
    initAccess()
    expect((await authorizedFetch('/api/x')).status).toBe(401)
    expect(fake.server.apiKeys).toEqual([null])
    expect(fake.fetchMock).toHaveBeenCalledTimes(1)
  })
})
