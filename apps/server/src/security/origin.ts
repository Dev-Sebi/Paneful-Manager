import { BIND_HOST } from '@agent-hub/shared'

/** Vite dev server port, allowed as an Origin only in development. */
export const DEV_ORIGIN_PORT = 3000

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'] as const

/** Defense in depth: refuses to bind anything but loopback. */
export function assertLoopbackBind(host: string): void {
  if (host !== BIND_HOST) {
    throw new Error(`Refusing to bind to ${host}: Agent Hub only listens on ${BIND_HOST}`)
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

/** Exact match against the loopback origins of the server port, plus the Vite dev origins when `dev`. */
export function isAllowedOrigin(origin: string | undefined, port: number, dev: boolean): boolean {
  if (origin === undefined) {
    return false
  }
  const allowed = LOOPBACK_NAMES.map(name => `http://${name}:${port}`)
  if (dev) {
    allowed.push(`http://localhost:${DEV_ORIGIN_PORT}`, `http://127.0.0.1:${DEV_ORIGIN_PORT}`)
  }
  return allowed.includes(origin)
}
