// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:7337/" }
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_KEY_STORAGE_KEY, consumeLoginFragment, initAccess, isTrustedHost, loginRequired, readAccessKey, untrustedHost } from './access'

/** Location of the same page reached under another host name, e.g. `localhost`, which may resolve to `::1`. */
function locationAt (hostname: string): Location {
  return { hostname, hash: location.hash, pathname: location.pathname, search: location.search } as Location
}

afterEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  loginRequired.value = false
  untrustedHost.value = false
})

describe('access key', () => {
  it('takes the key from the login URL and strips the fragment', () => {
    history.replaceState(null, '', '/workspaces?x=1#key=abc-DEF_123')
    expect(consumeLoginFragment()).toBe(true)
    expect(localStorage.getItem(ACCESS_KEY_STORAGE_KEY)).toBe('abc-DEF_123')
    expect(location.hash).toBe('')
    expect(`${location.pathname}${location.search}`).toBe('/workspaces?x=1')
  })

  it('ignores other or empty fragments and keeps a stored key', () => {
    localStorage.setItem(ACCESS_KEY_STORAGE_KEY, 'stored')
    for (const hash of ['', '#other=1', '#key=', '#key=%20']) {
      history.replaceState(null, '', `/${hash}`)
      expect(consumeLoginFragment()).toBe(false)
    }
    expect(readAccessKey()).toBe('stored')
  })

  it('flags the login hint only while no key is stored', () => {
    initAccess()
    expect(loginRequired.value).toBe(true)
    history.replaceState(null, '', '/#key=fresh')
    initAccess()
    expect(loginRequired.value).toBe(false)
    expect(readAccessKey()).toBe('fresh')
  })

  it('trusts only the bound address', () => {
    expect(isTrustedHost('127.0.0.1')).toBe(true)
    for (const hostname of ['localhost', '[::1]', '::1', '127.0.0.2', 'LOCALHOST']) {
      expect(isTrustedHost(hostname)).toBe(false)
    }
  })

  it('never stores the key on another host name and drops a key kept there', () => {
    history.replaceState(null, '', '/workspaces#key=abc-DEF_123')
    expect(consumeLoginFragment(locationAt('localhost'))).toBe(false)
    expect(localStorage.getItem(ACCESS_KEY_STORAGE_KEY)).toBeNull()
    expect(location.hash).toBe('')
    localStorage.setItem(ACCESS_KEY_STORAGE_KEY, 'kept-under-localhost')
    initAccess(locationAt('localhost'))
    expect(untrustedHost.value).toBe(true)
    expect(loginRequired.value).toBe(true)
    expect(readAccessKey()).toBeUndefined()
  })
})
