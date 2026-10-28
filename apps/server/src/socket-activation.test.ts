import { API_ROUTES, HealthResponseSchema } from '@paneful-manager/shared'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LISTEN_FDS_START, MAX_LISTEN_FDS, takeListenFds, untrustedAddressHint } from './socket-activation.js'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const START_MODULE = fileURLToPath(new URL('start.ts', import.meta.url))

describe('takeListenFds', () => {
  it('returns the fds for this process and removes the variables', () => {
    const env: Record<string, string | undefined> = { LISTEN_PID: '42', LISTEN_FDS: '2', LISTEN_FDNAMES: 'a:b', OTHER: 'x' }
    expect(takeListenFds(env, 42)).toEqual([LISTEN_FDS_START, LISTEN_FDS_START + 1])
    expect(env).toEqual({ OTHER: 'x' })
  })

  it('ignores sockets meant for another process, but still removes the variables', () => {
    const env: Record<string, string | undefined> = { LISTEN_PID: '41', LISTEN_FDS: '1' }
    expect(takeListenFds(env, 42)).toEqual([])
    expect(env).toEqual({})
    expect(takeListenFds({ LISTEN_FDS: '1' }, 42)).toEqual([])
    expect(takeListenFds({}, 42)).toEqual([])
  })

  it('refuses a broken count', () => {
    for (const count of ['0', 'x', '1.5', String(MAX_LISTEN_FDS + 1)]) {
      expect(() => takeListenFds({ LISTEN_PID: '42', LISTEN_FDS: count }, 42)).toThrow(/Invalid LISTEN_FDS/)
    }
  })
})

/** Listens like systemd's socket unit would; resolves undefined when the address is not available here. */
async function listenOn(host: string): Promise<Server | undefined> {
  const server = createServer()
  return new Promise(resolve => {
    server.once('error', () => resolve(undefined))
    server.listen({ host, port: 0 }, () => resolve(server))
  })
}

function fdOf(server: Server): number {
  return (server as unknown as { _handle: { fd: number } })._handle.fd
}

function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

/** Child script: plays the activated service, with LISTEN_PID set to its own pid as systemd does. */
function childCode(): string {
  return [
    `process.env.LISTEN_PID = String(process.pid)`,
    `const { startServer } = await import(${JSON.stringify(START_MODULE)})`,
    `const { DEFAULT_CONFIG } = await import('@paneful-manager/shared')`,
    `const { pino } = await import('pino')`,
    `const server = await startServer({ ...DEFAULT_CONFIG, port: 1 }, pino({ level: 'silent' }))`,
    `process.stdout.write(JSON.stringify({ port: server.port, cleaned: process.env.LISTEN_FDS === undefined && process.env.LISTEN_PID === undefined }) + '\\n')`,
    `process.on('SIGTERM', () => { server.shutdown().then(() => process.exit(0)) })`,
  ].join('\n')
}

let child: ChildProcess | undefined
let temp: string | undefined

afterEach(async () => {
  child?.kill('SIGTERM')
  child = undefined
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

function get(host: string, port: number, path: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, headers: { host: `${host.includes(':') ? `[${host}]` : host}:${port}` } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('socket activation', () => {
  it('serves on the passed 127.0.0.1 socket and answers the [::1] socket with the address hint', async () => {
    temp = await mkdtemp(join(tmpdir(), 'paneful-manager-socket-'))
    const v4 = await listenOn('127.0.0.1')
    const v6 = await listenOn('::1')
    if (v4 === undefined) {
      throw new Error('cannot listen on 127.0.0.1')
    }
    const sockets = v6 === undefined ? [v4] : [v4, v6]
    const v4Port = portOf(v4)
    const v6Port = v6 === undefined ? 0 : portOf(v6)
    const env = {
      ...process.env,
      LISTEN_FDS: String(sockets.length),
      NODE_ENV: 'production',
      XDG_STATE_HOME: join(temp, 'state'),
      XDG_CONFIG_HOME: join(temp, 'config'),
      CLAUDE_CONFIG_DIR: join(temp, 'claude'),
      TMUX_TMPDIR: temp,
    }
    // The child gets each socket at fd 3, 4, ... like from systemd; the test's own copies are closed right after.
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode()], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'inherit', ...sockets.map(fdOf)],
    })
    await Promise.all(sockets.map(socket => new Promise(resolve => socket.close(resolve))))
    const line = await new Promise<string>((resolve, reject) => {
      let out = ''
      child?.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('\n')) {
          resolve(out.split('\n')[0] ?? '')
        }
      })
      child?.once('exit', code => reject(new Error(`server exited with ${code}`)))
    })
    const started = JSON.parse(line) as { port: number, cleaned: boolean }
    expect(started.port).toBe(v4Port)
    expect(started.cleaned).toBe(true)

    const health = await get('127.0.0.1', v4Port, API_ROUTES.health)
    expect(health.status).toBe(200)
    expect(HealthResponseSchema.safeParse(JSON.parse(health.body)).success).toBe(true)
    if (v6 !== undefined) {
      const hint = await get('::1', v6Port, API_ROUTES.health)
      expect(hint.status).toBe(403)
      expect(hint.body).toBe(untrustedAddressHint(v4Port))
    }
  }, 30_000)
})
