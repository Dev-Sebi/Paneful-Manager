import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BIND_HOST } from '@paneful-manager/shared'

/** First file descriptor systemd passes (`SD_LISTEN_FDS_START`). */
export const LISTEN_FDS_START = 3

/** More sockets than `paneful-manager.socket` ever passes points at a foreign or broken environment. */
export const MAX_LISTEN_FDS = 8

const LISTEN_ENV_KEYS = ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES'] as const

/**
 * Reads the listening sockets systemd passed (socket activation, `sd_listen_fds`) in the order of the `ListenStream=`
 * lines, and removes the variables so no child process takes them for its own. Empty when they are for another process.
 */
export function takeListenFds(env: Record<string, string | undefined>, pid: number): number[] {
  const listenPid = env.LISTEN_PID
  const listenFds = env.LISTEN_FDS
  for (const key of LISTEN_ENV_KEYS) {
    delete env[key]
  }
  if (listenPid === undefined || listenFds === undefined || Number(listenPid) !== pid) {
    return []
  }
  const count = Number(listenFds)
  if (!Number.isInteger(count) || count < 1 || count > MAX_LISTEN_FDS) {
    throw new Error(`Invalid LISTEN_FDS "${listenFds}" from systemd: expected 1 to ${MAX_LISTEN_FDS} sockets`)
  }
  return Array.from({ length: count }, (_, index) => LISTEN_FDS_START + index)
}

/** Text served on a passed socket other than `127.0.0.1`, e.g. `[::1]`, which systemd holds only so nobody else can. */
export function untrustedAddressHint(port: number): string {
  return `Paneful Manager only answers on http://${BIND_HOST}:${port}/ - open that address instead of localhost or [::1].\n`
}

/** Serves a passed socket other than the trusted address: 403 with the hint for every request, upgrades are closed. */
export async function listenHintServer(fd: number, port: number): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(403, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    response.end(untrustedAddressHint(port))
  })
  server.on('upgrade', (_request, socket) => {
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ fd }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  if (address === null || (address.address !== '::1' && address.address !== BIND_HOST)) {
    await closeServer(server)
    throw new Error(`Refusing the socket passed as fd ${fd}: it is bound to ${address?.address ?? 'nothing'}, not to loopback`)
  }
  return server
}

/** Closes a server and every connection it still holds. */
export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
}
