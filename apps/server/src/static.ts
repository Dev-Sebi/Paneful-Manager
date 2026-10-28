import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, WS_PATH } from '@agent-hub/shared'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply } from 'fastify'

export const WEB_DIST_ENV_VAR = 'AGENT_HUB_WEB_DIST'

/** Release layout: `apps/server/dist/static.js` next to `apps/web/dist`. */
const PACKAGED_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))

/**
 * Strict CSP for the SPA. `connect-src` allows the page's own origin plus WebSockets to exactly this server's port
 * on the loopback names the Host check accepts; `'self'` alone does not cover `ws:` in every browser.
 */
export function contentSecurityPolicy(port: number): string {
  return [
    "default-src 'self'",
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port} ws://[::1]:${port}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const INDEX_FILE = 'index.html'

/**
 * Directory of the built web app: `AGENT_HUB_WEB_DIST` when set, else the packaged path.
 * Returns undefined when it has no `index.html`, so dev setups without a web build serve the API only.
 */
export function resolveWebDist(env: Record<string, string | undefined>, packaged = PACKAGED_WEB_DIST): string | undefined {
  const configured = env[WEB_DIST_ENV_VAR]?.trim()
  const dir = configured ? resolve(configured) : packaged
  return isAbsolute(dir) && existsSync(join(dir, INDEX_FILE)) ? dir : undefined
}

function setHeaders(reply: FastifyReply, path: string, port: number): void {
  if (path.endsWith('.html')) {
    reply.header('content-security-policy', contentSecurityPolicy(port))
    reply.header('cache-control', 'no-cache')
  } else if (/[/\\]assets[/\\]/.test(path)) {
    reply.header('cache-control', HASHED_ASSET_CACHE_CONTROL)
  } else {
    reply.header('cache-control', 'no-cache')
  }
}

function isReserved(path: string): boolean {
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`) || path === WS_PATH
}

/**
 * Serves the SPA from `root`; unknown non-API paths without a file extension fall back to `index.html`.
 * `getPort` is read per response because tests listen on port 0.
 */
export function registerStatic(app: FastifyInstance, root: string, getPort: () => number): void {
  app.register(async scope => {
    await scope.register(fastifyStatic, { root, wildcard: false, cacheControl: false, dotfiles: 'deny', setHeaders: (reply: FastifyReply, path: string) => setHeaders(reply, path, getPort()) })
    scope.get('/*', (request, reply) => {
      const path = request.url.split('?', 1)[0] ?? ''
      const lastSegment = path.slice(path.lastIndexOf('/') + 1)
      if (isReserved(path) || lastSegment.includes('.')) {
        return reply.callNotFound()
      }
      return reply.sendFile(INDEX_FILE)
    })
  })
}
