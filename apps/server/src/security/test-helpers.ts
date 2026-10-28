import { deviceSignatureMessage, type DevicePublicKey } from '@agent-hub/shared'

/** A device key made the way the browser makes it: WebCrypto, private half not extractable. */
export async function createTestDevice(): Promise<{ publicKey: DevicePublicKey, sign: (nonce: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    publicKey: { kty: 'EC', crv: 'P-256', x: x ?? '', y: y ?? '' },
    sign: async nonce => {
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(deviceSignatureMessage(nonce)))
      return Buffer.from(signature).toString('base64url')
    },
  }
}
