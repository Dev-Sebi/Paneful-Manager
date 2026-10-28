import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deviceSignatureMessage, DevicePublicKeySchema, type DevicePublicKey, z } from '@agent-hub/shared'
import { consumeLoginCode, LOGIN_CODE_FILE } from './login-code.js'
import { tokenMatches } from './token.js'

/** Registered browser devices (public keys only), mode 0600; deleting it logs every browser out. */
export const DEVICES_FILE = 'devices.json'

/** Oldest registrations are dropped beyond this, so stale browsers do not pile up. */
export const MAX_DEVICES = 20
/** Browser session keys expire after this; the page renews them by signing a new challenge. */
export const SESSION_TTL_MS = 15 * 60 * 1000
export const NONCE_TTL_MS = 60 * 1000
/** Bounds the memory spent on answered nonces and sessions; only registered devices can add to either. */
const MAX_USED_NONCES = 1000
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

interface IssuedSession {
  deviceId: string
  expiresAt: number
}

/** Adds `key`, dropping expired entries and then the oldest ones beyond `max`. */
function remember(map: Map<string, IssuedSession>, key: string, session: IssuedSession, max: number, now: number): void {
  for (const [entry, { expiresAt }] of map) {
    if (expiresAt <= now) {
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
  map.set(key, session)
}

/** `<random>.<expiry ms>.<mac>`: issuing keeps no state, so a flood of challenges cannot push out the owner's. */
function signNonce(secret: Buffer, random: string, expiresAt: number): string {
  const body = `${random}.${expiresAt.toString(36)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** Expiry of a nonce this process issued, or undefined for a forged, foreign or malformed one. */
function nonceExpiry(secret: Buffer, nonce: string): number | undefined {
  const [random, expiry, mac] = nonce.split('.')
  if (random === undefined || expiry === undefined || mac === undefined) {
    return undefined
  }
  const expiresAt = Number.parseInt(expiry, 36)
  return Number.isSafeInteger(expiresAt) && tokenMatches(nonce, signNonce(secret, random, expiresAt)) ? expiresAt : undefined
}

/** True for a point on P-256; `createPublicKey` refuses anything else. */
function isUsableKey(publicKey: DevicePublicKey): boolean {
  try {
    createPublicKey({ key: publicKey, format: 'jwk' })
    return true
  } catch {
    return false
  }
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
  /** Per-process MAC key for nonces; a restart invalidates every nonce. */
  private readonly nonceSecret = randomBytes(32)
  /** Nonces that already bought a session, until they expire; a signature works once. */
  private readonly usedNonces = new Map<string, number>()
  /** Keyed by the SHA-256 of the session key, so lookups do not compare the secret itself. */
  private readonly sessions = new Map<string, IssuedSession>()
  /** Registered device ids, reloaded whenever the devices file changes, so a reset ends every session at once. */
  private known: { stamp: string, ids: Set<string> } | undefined
  private writes: Promise<unknown> = Promise.resolve()

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  challenge(): string {
    return signNonce(this.nonceSecret, randomBytes(16).toString('base64url'), this.now() + NONCE_TTL_MS)
  }

  /** Registers the key when `code` is the pending login code; returns the device id, or undefined. */
  register(code: string, publicKey: DevicePublicKey): Promise<string | undefined> {
    const run = this.writes.then(async () => {
      // Checked before the code is spent, so a key that could never sign does not use up the login URL.
      if (!isUsableKey(publicKey) || !(await consumeLoginCode(this.stateDir, code, this.now()))) {
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
    const expiresAt = nonceExpiry(this.nonceSecret, nonce)
    if (expiresAt === undefined || expiresAt <= this.now() || this.usedNonces.has(nonce)) {
      return undefined
    }
    const device = (await this.readDevices()).find(entry => entry.id === deviceId)
    if (device === undefined || !verifySignature(device.publicKey, nonce, signature) || !this.markUsed(nonce, expiresAt)) {
      return undefined
    }
    const key = randomId()
    remember(this.sessions, digest(key), { deviceId: device.id, expiresAt: this.now() + SESSION_TTL_MS }, MAX_SESSIONS, this.now())
    return { key, expiresInSec: SESSION_TTL_MS / 1000 }
  }

  /** Records an answered nonce; refuses instead of forgetting one that could still be replayed. */
  private markUsed(nonce: string, expiresAt: number): boolean {
    const now = this.now()
    for (const [entry, expiry] of this.usedNonces) {
      if (expiry <= now) {
        this.usedNonces.delete(entry)
      }
    }
    if (this.usedNonces.has(nonce) || this.usedNonces.size >= MAX_USED_NONCES) {
      return false
    }
    this.usedNonces.set(nonce, expiresAt)
    return true
  }

  /** True for an unexpired session key whose device is still registered. */
  async hasSession(key: string | undefined): Promise<boolean> {
    return (await this.sessionDevice(key)) !== undefined
  }

  /** Device behind an unexpired session key while it is still registered; undefined otherwise. */
  async sessionDevice(key: string | undefined): Promise<string | undefined> {
    const session = key === undefined ? undefined : this.sessions.get(digest(key))
    if (session === undefined || session.expiresAt <= this.now()) {
      return undefined
    }
    return (await this.isRegistered(session.deviceId)) ? session.deviceId : undefined
  }

  /** Whether `deviceId` is still in the devices file; a stat per call, the file is parsed only when it changed. */
  async isRegistered(deviceId: string): Promise<boolean> {
    let stamp: string
    try {
      const info = await stat(join(this.stateDir, DEVICES_FILE))
      stamp = `${info.ino}:${info.size}:${info.mtimeMs}`
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') {
        this.known = undefined
        return false
      }
      throw error
    }
    if (this.known?.stamp !== stamp) {
      this.known = { stamp, ids: new Set((await this.readDevices()).map(device => device.id)) }
    }
    return this.known.ids.has(deviceId)
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

/** Logs every browser out: removes the registered devices and any pending login code; the server refuses their sessions from the next request on. */
export async function resetDevices(stateDir: string): Promise<void> {
  await rm(join(stateDir, DEVICES_FILE), { force: true })
  await rm(join(stateDir, LOGIN_CODE_FILE), { force: true })
}
