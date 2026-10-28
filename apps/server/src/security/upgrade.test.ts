import { describe, expect, it } from 'vitest'
import { authorizeKeyedUpgrade, authorizeUpgrade, upgradeKey } from './upgrade.js'

const context = { port: 7337, token: 'secret-token', dev: false }
const valid = {
  host: '127.0.0.1:7337',
  origin: 'http://127.0.0.1:7337',
  'sec-websocket-protocol': 'paneful-manager.v1, token.secret-token',
}

const decide = (overrides: Record<string, string | undefined>, dev = false) =>
  authorizeUpgrade({ headers: { ...valid, ...overrides } }, { ...context, dev })

describe('authorizeUpgrade', () => {
  it('accepts a valid upgrade and echoes only the app subprotocol', () => {
    expect(decide({})).toEqual({ ok: true, protocol: 'paneful-manager.v1' })
    expect(decide({ 'sec-websocket-protocol': 'token.secret-token,paneful-manager.v1' }).ok).toBe(true)
  })

  it('rejects a bad Host or Origin with 403', () => {
    for (const overrides of [{ host: 'evil.example:7337' }, { origin: 'https://evil.example' }, { origin: undefined }]) {
      expect(decide(overrides)).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
    }
  })

  it('allows only the 127.0.0.1 Host and Origin in production', () => {
    for (const overrides of [{ host: 'localhost:7337' }, { origin: 'http://localhost:7337' }, { origin: 'http://[::1]:7337' }]) {
      expect(decide(overrides)).toMatchObject({ ok: false, status: 403 })
      expect(decide(overrides, true).ok).toBe(true)
    }
  })

  it('allows the dev origin only in dev mode', () => {
    expect(decide({ origin: 'http://localhost:3000' }).ok).toBe(false)
    expect(decide({ origin: 'http://localhost:3000' }, true).ok).toBe(true)
  })

  it('allows configured dev origins only in dev mode', () => {
    const withExtra = (dev: boolean, origin: string) =>
      authorizeUpgrade({ headers: { ...valid, origin } }, { ...context, dev, devOrigins: ['http://localhost:3001'] }).ok
    expect(withExtra(false, 'http://localhost:3001')).toBe(false)
    expect(withExtra(true, 'http://localhost:3001')).toBe(true)
    expect(withExtra(true, 'https://evil.example')).toBe(false)
  })

  it('requires the app subprotocol', () => {
    for (const protocol of [undefined, 'token.secret-token', 'paneful-manager.v2, token.secret-token']) {
      expect(decide({ 'sec-websocket-protocol': protocol })).toMatchObject({ ok: false, status: 403 })
    }
  })

  it('rejects a missing, wrong or duplicated token with 401', () => {
    for (const protocol of [
      'paneful-manager.v1',
      'paneful-manager.v1, token.wrong',
      'paneful-manager.v1, token.',
      'paneful-manager.v1, token.wrong, token.secret-token',
      'paneful-manager.v1, secret-token',
    ]) {
      expect(decide({ 'sec-websocket-protocol': protocol })).toMatchObject({ ok: false, status: 401, code: 'unauthorized' })
    }
  })
})

describe('authorizeKeyedUpgrade', () => {
  const revalidate = async (): Promise<boolean> => true
  const authenticate = async (key: string | undefined) => {
    if (key === 'script-key') {
      return {}
    }
    return key === 'session-key' ? { revalidate } : undefined
  }
  const keyed = (overrides: Record<string, string | undefined>) =>
    authorizeKeyedUpgrade({ headers: { ...valid, ...overrides } }, context, authenticate)

  it('needs a valid key besides the token, from the header or one key subprotocol', async () => {
    await expect(keyed({})).resolves.toMatchObject({ ok: false, status: 401 })
    await expect(keyed({ 'sec-websocket-protocol': 'paneful-manager.v1, token.secret-token, key.wrong' })).resolves.toMatchObject({ ok: false, status: 401 })
    await expect(keyed({ 'x-paneful-key': 'script-key' })).resolves.toEqual({ ok: true, protocol: 'paneful-manager.v1' })
    await expect(keyed({ 'sec-websocket-protocol': 'paneful-manager.v1, token.secret-token, key.session-key' })).resolves.toEqual({ ok: true, protocol: 'paneful-manager.v1', revalidate })
  })

  it('still checks Host, Origin and the token first', async () => {
    await expect(keyed({ 'x-paneful-key': 'script-key', 'origin': 'https://evil.example' })).resolves.toMatchObject({ ok: false, status: 403 })
    await expect(keyed({ 'x-paneful-key': 'script-key', 'sec-websocket-protocol': 'paneful-manager.v1, token.wrong' })).resolves.toMatchObject({ ok: false, status: 401 })
  })

  it('takes no key from two key subprotocols', () => {
    expect(upgradeKey({ 'sec-websocket-protocol': 'paneful-manager.v1, key.a, key.b' })).toBeUndefined()
    expect(upgradeKey({ 'sec-websocket-protocol': 'paneful-manager.v1, key.a' })).toBe('a')
  })
})
