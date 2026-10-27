import { BIND_HOST } from '@agent-hub/shared'
import { describe, expect, it } from 'vitest'
import { assertLoopbackAddress, isAllowedHost, isAllowedOrigin } from './origin.js'
import { createSessionToken, tokenMatches } from './token.js'

describe('assertLoopbackAddress', () => {
  it('accepts only the loopback bind address', () => {
    expect(() => assertLoopbackAddress({ address: BIND_HOST, family: 'IPv4', port: 1 })).not.toThrow()
    for (const address of ['0.0.0.0', '::', '::1', '192.168.1.10']) {
      expect(() => assertLoopbackAddress({ address, family: 'IPv4', port: 1 })).toThrow(/Refusing to serve/)
    }
    expect(() => assertLoopbackAddress('/tmp/agent-hub.sock')).toThrow(/Refusing to serve/)
    expect(() => assertLoopbackAddress(null)).toThrow(/Refusing to serve/)
  })
})

describe('isAllowedHost', () => {
  it('allows loopback names with the port and bare localhost', () => {
    for (const host of ['localhost:7337', '127.0.0.1:7337', '[::1]:7337', 'localhost', 'LocalHost:7337']) {
      expect(isAllowedHost(host, 7337)).toBe(true)
    }
  })

  it('rejects other hosts, ports and missing values', () => {
    for (const host of [undefined, '', '127.0.0.1', '[::1]', 'localhost:80', 'localhost.:7337', 'evil.localhost:7337', 'a.example:7337']) {
      expect(isAllowedHost(host, 7337)).toBe(false)
    }
  })
})

describe('isAllowedOrigin', () => {
  it('allows the loopback origins of the port', () => {
    for (const origin of ['http://localhost:7337', 'http://127.0.0.1:7337', 'http://[::1]:7337']) {
      expect(isAllowedOrigin(origin, 7337, false)).toBe(true)
    }
  })

  it('rejects other origins', () => {
    for (const origin of [undefined, 'null', 'https://localhost:7337', 'http://localhost', 'http://localhost:7337/', 'http://evil.example']) {
      expect(isAllowedOrigin(origin, 7337, false)).toBe(false)
    }
  })

  it('allows the Vite dev origins only in dev mode', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      expect(isAllowedOrigin(origin, 7337, false)).toBe(false)
      expect(isAllowedOrigin(origin, 7337, true)).toBe(true)
    }
    expect(isAllowedOrigin('http://[::1]:3000', 7337, true)).toBe(false)
  })
})

describe('session token', () => {
  it('is 32 random bytes in base64url', () => {
    const token = createSessionToken()
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(token).not.toBe(createSessionToken())
  })

  it('compares exactly', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    for (const candidate of [undefined, '', 'ab', 'abcd', 'ABC']) {
      expect(tokenMatches(candidate, 'abc')).toBe(false)
    }
  })
})
