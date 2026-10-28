// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_KEY_STORAGE_KEY, consumeLoginFragment, initAccess, loginRequired, readAccessKey } from './access'

afterEach(() => {
  localStorage.clear()
  history.replaceState(null, '', '/')
  loginRequired.value = false
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
})
