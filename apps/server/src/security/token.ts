import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, base64url; generated once per boot and never persisted. */
export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

/** Constant-time compare; hashing first hides the length of the expected token. */
export function tokenMatches(candidate: string | undefined, expected: string): boolean {
  return candidate !== undefined && timingSafeEqual(digest(candidate), digest(expected))
}
