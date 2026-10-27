import { describe, expect, it } from 'vitest'
import { authorizeUpgrade } from './upgrade.js'

const context = { port: 7337, token: 'secret-token', dev: false }
const valid = {
  host: 'localhost:7337',
  origin: 'http://localhost:7337',
  'sec-websocket-protocol': 'agent-hub.v1, token.secret-token',
}

const decide = (overrides: Record<string, string | undefined>, dev = false) =>
  authorizeUpgrade({ headers: { ...valid, ...overrides } }, { ...context, dev })

describe('authorizeUpgrade', () => {
  it('accepts a valid upgrade and echoes only the app subprotocol', () => {
    expect(decide({})).toEqual({ ok: true, protocol: 'agent-hub.v1' })
    expect(decide({ 'sec-websocket-protocol': 'token.secret-token,agent-hub.v1' }).ok).toBe(true)
  })

  it('rejects a bad Host or Origin with 403', () => {
    for (const overrides of [{ host: 'evil.example:7337' }, { origin: 'https://evil.example' }, { origin: undefined }]) {
      expect(decide(overrides)).toMatchObject({ ok: false, status: 403, code: 'forbidden' })
    }
  })

  it('allows the dev origin only in dev mode', () => {
    expect(decide({ origin: 'http://localhost:3000' }).ok).toBe(false)
    expect(decide({ origin: 'http://localhost:3000' }, true).ok).toBe(true)
  })

  it('requires the app subprotocol', () => {
    for (const protocol of [undefined, 'token.secret-token', 'agent-hub.v2, token.secret-token']) {
      expect(decide({ 'sec-websocket-protocol': protocol })).toMatchObject({ ok: false, status: 403 })
    }
  })

  it('rejects a missing, wrong or duplicated token with 401', () => {
    for (const protocol of [
      'agent-hub.v1',
      'agent-hub.v1, token.wrong',
      'agent-hub.v1, token.',
      'agent-hub.v1, token.wrong, token.secret-token',
      'agent-hub.v1, secret-token',
    ]) {
      expect(decide({ 'sec-websocket-protocol': protocol })).toMatchObject({ ok: false, status: 401, code: 'unauthorized' })
    }
  })
})
