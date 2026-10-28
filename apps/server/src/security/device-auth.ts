import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceSignatureMessage, DevicePublicKeySchema, type DevicePublicKey, z } from '@agent-hub/shared'
import { consumeLoginCode, LOGIN_CODE_FILE } from './login-code.js'

/** Registered browser devices (public keys only), mode 0600; deleting it logs every browser out. */
export const DEVICES_FILE = 'devices.json'

/** Oldest registrations are dropped beyond this, so stale browsers do not pile up. */
export const MAX_DEVICES = 20
/** Browser session keys expire after this; the page renews them by signing a new challenge. */
export const SESSION_TTL_MS = 15 * 60 * 1000
export const NONCE_TTL_MS = 60 * 1000
/** Bounds the memory other local users can make the server spend on unused nonces and sessions. */
const MAX_NONCES = 1000
const MAX_SESSIONS = 256

const DeviceSchema = z.strictObject({ id: z.string().min(1), publicKey: DevicePublicKeySchema, createdAt: z.string() })
type Device = z.infer<typeof DeviceSchema>
const DevicesFileSchema = z.strictObject({ devices: z.array(DeviceSchema) })

export interface AuthSession {
  key: string
  expiresInSec: number
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code
const digest = (value: string): string => createHash('sha256').update(value).digest('base64url')
const randomId = (): string => randomBytes(32).toString('base64url')

/** Adds `key` with an expiry, dropping expired entries and then the oldest ones beyond `max`. */
function remember(map: Map<string, number>, key: string, expiresAt: number, max: number, now: number): void {
  for (const [entry, expiry] of map) {
    if (expiry <= now) {
      map.delete(entry)
    }
  }
  while (map.size >= max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
  map.set(key, expiresAt)
}

/** Takes `key` out of `map`; true when it was there and unexpired. */
function take(map: Map<string, number>, key: string, now: number): boolean {
  const expiry = map.get(key)
  map.delete(key)
  return expiry !== undefined && expiry > now
}

function verifySignature(publicKey: DevicePublicKey, nonce: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: publicKey, format: 'jwk' })
    return verify('sha256', Buffer.from(deviceSignatureMessage(nonce)), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  } catch {
    return false
  }
}

/**
 * Browser login without a bearer secret in the browser (ADR 0013): a one-time login code registers a
 * non-extractable device key, and each session key is issued only for a signature over a nonce from this process.
 */
export class DeviceAuth {
  private readonly nonces = new Map<string, number>()
  /** Keyed by the SHA-256 of the session key, so lookups do not compare the secret itself. */
  private readonly sessions = new Map<string, number>()
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  challenge(): string {
    const nonce = randomId()
    remember(this.nonces, nonce, this.now() + NONCE_TTL_MS, MAX_NONCES, this.now())
    return nonce
  }

  /** Registers the key when `code` is the pending login code; returns the device id, or undefined. */
  register(code: string, publicKey: DevicePublicKey): Promise<string | undefined> {
    const run = this.writes.then(async () => {
      if (!(await consumeLoginCode(this.stateDir, code, this.now()))) {
        return undefined
      }
      const device: Device = { id: randomId(), publicKey, createdAt: new Date(this.now()).toISOString() }
      await this.writeDevices([...(await this.readDevices()), device].slice(-MAX_DEVICES))
      return device.id
    })
    this.writes = run.catch(() => undefined)
    return run
  }

  /** Issues a session key for a valid signature over an unused nonce; the devices file is read each time, so a reset applies at once. */
  async createSession(deviceId: string, nonce: string, signature: string): Promise<AuthSession | undefined> {
    if (!take(this.nonces, nonce, this.now())) {
      return undefined
    }
    const device = (await this.readDevices()).find(entry => entry.id === deviceId)
    if (device === undefined || !verifySignature(device.publicKey, nonce, signature)) {
      return undefined
    }
    const key = randomId()
    remember(this.sessions, digest(key), this.now() + SESSION_TTL_MS, MAX_SESSIONS, this.now())
    return { key, expiresInSec: SESSION_TTL_MS / 1000 }
  }

  hasSession(key: string | undefined): boolean {
    if (key === undefined) {
      return false
    }
    const expiry = this.sessions.get(digest(key))
    return expiry !== undefined && expiry > this.now()
  }

  private async readDevices(): Promise<Device[]> {
    let content: string
    try {
      content = await readFile(join(this.stateDir, DEVICES_FILE), 'utf8')
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        return []
      }
      throw error
    }
    try {
      return DevicesFileSchema.parse(JSON.parse(content)).devices
    } catch {
      // A corrupt file trusts no device; the next registration replaces it.
      return []
    }
  }

  private async writeDevices(devices: Device[]): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
    const file = join(this.stateDir, DEVICES_FILE)
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify({ devices }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await rename(temp, file)
    } finally {
      await rm(temp, { force: true })
    }
  }
}

/** Logs every browser out: removes the registered devices and any pending login code. Sessions already issued run out within `SESSION_TTL_MS`. */
export async function resetDevices(stateDir: string): Promise<void> {
  await rm(join(stateDir, DEVICES_FILE), { force: true })
  await rm(join(stateDir, LOGIN_CODE_FILE), { force: true })
}
