import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICES_FILE, DeviceAuth, MAX_DEVICES, NONCE_TTL_MS, resetDevices, SESSION_TTL_MS } from './device-auth.js'
import { createLoginCode, LOGIN_CODE_FILE } from './login-code.js'
import { createTestDevice } from './test-helpers.js'

let dir: string
let now: number
let auth: DeviceAuth

async function registered(): Promise<{ id: string, device: Awaited<ReturnType<typeof createTestDevice>> }> {
  const device = await createTestDevice()
  const id = await auth.register(await createLoginCode(dir, now), device.publicKey)
  if (id === undefined) {
    throw new Error('registration failed')
  }
  return { id, device }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-devices-'))
  now = Date.now()
  auth = new DeviceAuth(dir, () => now)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('DeviceAuth', () => {
  it('registers a device with the login code and stores only its public key, owner-only', async () => {
    const { id, device } = await registered()
    const file = join(dir, DEVICES_FILE)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { devices: Array<{ id: string, publicKey: unknown }> }
    expect(stored.devices).toEqual([expect.objectContaining({ id, publicKey: device.publicKey })])
  })

  it('refuses registration without the pending code', async () => {
    const device = await createTestDevice()
    expect(await auth.register('a'.repeat(43), device.publicKey)).toBeUndefined()
    const code = await createLoginCode(dir, now)
    expect(await auth.register(code, device.publicKey)).toBeDefined()
    expect(await auth.register(code, device.publicKey)).toBeUndefined()
  })

  it('issues a session key for a signed nonce, once per nonce', async () => {
    const { id, device } = await registered()
    const nonce = auth.challenge()
    const signature = await device.sign(nonce)
    const session = await auth.createSession(id, nonce, signature)
    expect(session?.expiresInSec).toBe(SESSION_TTL_MS / 1000)
    expect(auth.hasSession(session?.key)).toBe(true)
    expect(await auth.createSession(id, nonce, signature)).toBeUndefined()
  })

  it('rejects nonces it did not issue, expired nonces and foreign or wrong signatures', async () => {
    const { id, device } = await registered()
    const other = await createTestDevice()
    const madeUp = 'n'.repeat(43)
    expect(await auth.createSession(id, madeUp, await device.sign(madeUp))).toBeUndefined()
    const expired = auth.challenge()
    now += NONCE_TTL_MS
    expect(await auth.createSession(id, expired, await device.sign(expired))).toBeUndefined()
    const foreign = auth.challenge()
    expect(await auth.createSession(id, foreign, await other.sign(foreign))).toBeUndefined()
    const garbage = auth.challenge()
    expect(await auth.createSession(id, garbage, 'AAAA')).toBeUndefined()
    const unknown = auth.challenge()
    expect(await auth.createSession('u'.repeat(43), unknown, await device.sign(unknown))).toBeUndefined()
  })

  it('lets session keys expire', async () => {
    const { id, device } = await registered()
    const nonce = auth.challenge()
    const session = await auth.createSession(id, nonce, await device.sign(nonce))
    now += SESSION_TTL_MS
    expect(auth.hasSession(session?.key)).toBe(false)
    expect(auth.hasSession(undefined)).toBe(false)
    expect(auth.hasSession('made-up')).toBe(false)
  })

  it('logs every device out on reset', async () => {
    const { id, device } = await registered()
    await createLoginCode(dir, now)
    await resetDevices(dir)
    await expect(stat(join(dir, LOGIN_CODE_FILE))).rejects.toThrow()
    const nonce = auth.challenge()
    expect(await auth.createSession(id, nonce, await device.sign(nonce))).toBeUndefined()
  })

  it('keeps the newest devices only and trusts none from a corrupt file', async () => {
    const first = await registered()
    for (let index = 1; index < MAX_DEVICES; index++) {
      await registered()
    }
    const last = await registered()
    const stored = JSON.parse(await readFile(join(dir, DEVICES_FILE), 'utf8')) as { devices: Array<{ id: string }> }
    expect(stored.devices).toHaveLength(MAX_DEVICES)
    expect(stored.devices.map(device => device.id)).not.toContain(first.id)
    await writeFile(join(dir, DEVICES_FILE), '{ broken')
    const nonce = auth.challenge()
    expect(await auth.createSession(last.id, nonce, await last.device.sign(nonce))).toBeUndefined()
  })
})
