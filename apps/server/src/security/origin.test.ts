import { BIND_HOST } from '@paneful-manager/shared'
import { describe, expect, it, vi } from 'vitest'
import { assertLoopbackAddress, isAllowedHost, isAllowedOrigin, parseDevOrigins } from './origin.js'
import { createSessionToken, tokenMatches } from './token.js'

describe('assertLoopbackAddress', () => {
  it('accepts only the loopback bind address', () => {
    expect(() => assertLoopbackAddress({ address: BIND_HOST, family: 'IPv4', port: 1 })).not.toThrow()
    for (const address of ['0.0.0.0', '::', '::1', '192.168.1.10']) {
      expect(() => assertLoopbackAddress({ address, family: 'IPv4', port: 1 })).toThrow(/Refusing to serve/)
    }
    expect(() => assertLoopbackAddress('/tmp/paneful-manager.sock')).toThrow(/Refusing to serve/)
    expect(() => assertLoopbackAddress(null)).toThrow(/Refusing to serve/)
  })
})

describe('isAllowedHost', () => {
  it('allows only 127.0.0.1 with the port in production', () => {
    expect(isAllowedHost('127.0.0.1:7337', 7337)).toBe(true)
    for (const host of ['localhost:7337', '[::1]:7337', 'localhost', 'LocalHost:7337']) {
      expect(isAllowedHost(host, 7337)).toBe(false)
    }
  })

  it('allows loopback names with the port and bare localhost in dev mode', () => {
    for (const host of ['localhost:7337', '127.0.0.1:7337', '[::1]:7337', 'localhost', 'LocalHost:7337']) {
      expect(isAllowedHost(host, 7337, true)).toBe(true)
    }
  })

  it('rejects other hosts, ports and missing values', () => {
    for (const host of [undefined, '', '127.0.0.1', '[::1]', 'localhost:80', 'localhost.:7337', 'evil.localhost:7337', 'a.example:7337']) {
      expect(isAllowedHost(host, 7337)).toBe(false)
      expect(isAllowedHost(host, 7337, true)).toBe(false)
    }
  })
})

describe('isAllowedOrigin', () => {
  it('allows only the 127.0.0.1 origin of the port in production', () => {
    expect(isAllowedOrigin('http://127.0.0.1:7337', 7337, false)).toBe(true)
    for (const origin of ['http://localhost:7337', 'http://[::1]:7337']) {
      expect(isAllowedOrigin(origin, 7337, false)).toBe(false)
    }
  })

  it('allows the loopback origins of the port in dev mode', () => {
    for (const origin of ['http://localhost:7337', 'http://127.0.0.1:7337', 'http://[::1]:7337']) {
      expect(isAllowedOrigin(origin, 7337, true)).toBe(true)
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

  it('allows extra dev origins only in dev mode and never foreign ones', () => {
    const extra = ['http://localhost:3001']
    expect(isAllowedOrigin('http://localhost:3001', 7337, false, extra)).toBe(false)
    expect(isAllowedOrigin('http://localhost:3001', 7337, true, extra)).toBe(true)
    expect(isAllowedOrigin('http://evil.example', 7337, true, extra)).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:3001', 7337, true, extra)).toBe(false)
  })
})

describe('parseDevOrigins', () => {
  it('keeps exact loopback http origins with a port', () => {
    const warn = vi.fn()
    expect(parseDevOrigins(' http://localhost:3001 ,http://127.0.0.1:4000,', warn)).toEqual(['http://localhost:3001', 'http://127.0.0.1:4000'])
    expect(parseDevOrigins(undefined, warn)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops and reports everything else', () => {
    const warn = vi.fn()
    const rejected = [
      'http://evil.example:3001', 'https://localhost:3001', 'http://localhost', 'http://localhost:3001/',
      'http://[::1]:3001', 'http://localhost:0', 'http://localhost:70000', 'http://localhost.evil.example:3001', '*',
    ]
    expect(parseDevOrigins(rejected.join(','), warn)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(rejected.length)
    expect(warn.mock.calls[0]?.[0]).toMatch(/PANEFUL_MANAGER_DEV_ORIGINS/)
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
