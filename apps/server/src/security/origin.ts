import { BIND_HOST } from '@paneful-manager/shared'
import type { AddressInfo } from 'node:net'

/** Vite dev server port, allowed as an Origin only in development. */
export const DEV_ORIGIN_PORT = 3000

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'] as const

/** Comma-separated extra dev origins, e.g. a second Vite instance for e2e; honored only in dev mode. */
export const DEV_ORIGINS_ENV_VAR = 'PANEFUL_MANAGER_DEV_ORIGINS'
const DEV_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})$/

/** Keeps exact `http://localhost:<port>` / `http://127.0.0.1:<port>` entries; anything else is reported and dropped. */
export function parseDevOrigins(value: string | undefined, warn: (message: string) => void): string[] {
  const entries = (value ?? '').split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
  return entries.filter(entry => {
    const port = Number(DEV_ORIGIN_PATTERN.exec(entry)?.[1])
    const valid = Number.isInteger(port) && port >= 1 && port <= 65_535
    if (!valid) {
      warn(`Ignoring ${DEV_ORIGINS_ENV_VAR} entry "${entry}": only http://localhost:<port> or http://127.0.0.1:<port> is allowed`)
    }
    return valid
  })
}

/** Defense in depth: checks the address the server actually bound to (`server.address()`). */
export function assertLoopbackAddress(address: AddressInfo | string | null): void {
  const bound = typeof address === 'object' && address !== null ? address.address : String(address)
  if (bound !== BIND_HOST) {
    throw new Error(`Refusing to serve on ${bound}: Paneful Manager only listens on ${BIND_HOST}`)
  }
}

/** Host header check against DNS rebinding: loopback names with the server port, or bare `localhost`. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) {
    return false
  }
  const value = host.toLowerCase()
  return value === 'localhost' || LOOPBACK_NAMES.some(name => value === `${name}:${port}`)
}

/** Exact match against the loopback origins of the server port, plus the Vite and `devOrigins` origins when `dev`. */
export function isAllowedOrigin(origin: string | undefined, port: number, dev: boolean, devOrigins: readonly string[] = []): boolean {
  if (origin === undefined) {
    return false
  }
  const allowed = LOOPBACK_NAMES.map(name => `http://${name}:${port}`)
  if (dev) {
    allowed.push(`http://localhost:${DEV_ORIGIN_PORT}`, `http://127.0.0.1:${DEV_ORIGIN_PORT}`, ...devOrigins)
  }
  return allowed.includes(origin)
}
