import { type DevicePublicKey, deviceSignatureMessage } from '@paneful-manager/shared'

/** This browser's registration: the server's id for it and the private key, which page code can use but never read. */
export interface StoredDevice {
  id: string
  privateKey: CryptoKey
}

export interface DeviceStore {
  load: () => Promise<StoredDevice | undefined>
  save: (device: StoredDevice) => Promise<void>
}

const DB_NAME = 'paneful-manager'
const STORE_NAME = 'device'
const RECORD_KEY = 'current'

function openDb (): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.addEventListener('upgradeneeded', () => request.result.createObjectStore(STORE_NAME))
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB unavailable')))
  })
}

async function withStore<T> (mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
      request.addEventListener('success', () => resolve(request.result as T))
      request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')))
    })
  } finally {
    db.close()
  }
}

/** IndexedDB keeps the CryptoKey object itself (structured clone), so the private key stays non-extractable. */
export const indexedDbDeviceStore: DeviceStore = {
  load: async () => {
    const value = await withStore<StoredDevice | undefined>('readonly', store => store.get(RECORD_KEY))
    return value && typeof value.id === 'string' && value.privateKey instanceof CryptoKey ? value : undefined
  },
  save: device => withStore('readwrite', store => store.put(device, RECORD_KEY)),
}

/** New ECDSA P-256 key pair; the private half is created non-extractable, the public half goes to the server. */
export async function createDeviceKey (): Promise<{ privateKey: CryptoKey, publicKey: DevicePublicKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
  if (!x || !y) {
    throw new Error('Could not export the device public key')
  }
  return { privateKey: pair.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x, y } }
}

function toBase64Url (bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Signature over the server's nonce in the format the server verifies (raw r|s, base64url). */
export async function signChallenge (privateKey: CryptoKey, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(deviceSignatureMessage(nonce))
  return toBase64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data))
}
