import { ACCESS_KEY_HEADER, DEFAULT_CONFIG, HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER, SESSION_TOKEN_HEADER, SessionTokenResponseSchema, HealthResponseSchema, API_ROUTES, ListMcpServersResponseSchema } from '@agent-hub/shared'
import { pino } from 'pino'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HOOK_TOKEN_FILE, HOOK_TOKEN_VERSION_FILE } from './hooks/token.js'
import { RunError } from './process/exec.js'
import { ACCESS_KEY_FILE, portArgument, resolveLoginUrl } from './security/access-key.js'
import { RELEASE_VERSION, SHUTDOWN_TIMEOUT_MS, installShutdown, startServer } from './start.js'
import { Tmux } from './tmux/tmux.js'

const rootPackage = createRequire(import.meta.url)('../../../package.json') as { name: string, version: string }

/** tmux wrapper whose server is never running, so tests never touch a real socket. */
function missingTmux(): Tmux {
  return new Tmux({ run: async () => {
    throw new RunError('failed', 'exit', 1, '', 'no server running on /tmp/tmux-1000/agent-hub\n')
  } })
}

describe('startServer', () => {
  it('listens on loopback with an ephemeral port and shuts down', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'agent-hub-start-'))
    const env = { ...process.env, XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: join(stateHome, 'config') }
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), { env, tmux: missingTmux() })
    expect(await readdir(join(stateHome, 'agent-hub'))).toContain('sessions')
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${server.url}${API_ROUTES.health}`)
    expect(HealthResponseSchema.safeParse(await response.json()).success).toBe(true)
    await expect(server.shutdown()).resolves.toBe(true)
    await expect(fetch(`${server.url}${API_ROUTES.health}`)).rejects.toThrow()
    await rm(stateHome, { recursive: true, force: true })
  })
})

describe('installShutdown', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('shuts down once, ignores a second signal and exits 0', async () => {
    const proc = new EventEmitter()
    const shutdown = vi.fn().mockResolvedValue(true)
    const exit = vi.fn()
    installShutdown({ shutdown }, proc, exit, logger)
    proc.emit('SIGTERM')
    proc.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('ignoring'))
  })

  it('exits 1 when shutdown reports a timeout or fails', async () => {
    for (const result of [() => Promise.resolve(false), () => Promise.reject(new Error('x'))]) {
      const proc = new EventEmitter()
      const exit = vi.fn()
      installShutdown({ shutdown: result }, proc, exit, logger)
      proc.emit('SIGINT')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    }
  })
})

describe('bind assertion', () => {
  it('closes the server and fails when it is not bound to loopback', async () => {
    vi.resetModules()
    const close = vi.fn().mockResolvedValue(undefined)
    vi.doMock('./app.js', () => ({
      buildApp: () => ({
        listen: () => Promise.resolve(),
        server: { address: () => ({ address: '0.0.0.0', family: 'IPv4', port: 1 }) },
        close,
      }),
    }))
    try {
      const mocked = await import('./start.js')
      await expect(mocked.startServer({ ...DEFAULT_CONFIG, port: 1 }, pino({ level: 'silent' }))).rejects.toThrow(/Refusing to serve/)
      expect(close).toHaveBeenCalled()
    } finally {
      vi.doUnmock('./app.js')
    }
  })
})

describe('shutdown timeout', () => {
  it('warns and resolves false when close hangs', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      vi.doMock('./app.js', () => ({
        buildApp: () => ({
          listen: () => Promise.resolve(),
          server: { address: () => ({ address: '127.0.0.1', port: 1 }) },
          close: () => new Promise<void>(() => undefined),
        }),
      }))
      const mocked = await import('./start.js')
      const warn = vi.fn()
      const server = await mocked.startServer({ ...DEFAULT_CONFIG, port: 1 }, { warn } as never)
      const result = server.shutdown()
      await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
      await expect(result).resolves.toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      vi.doUnmock('./app.js')
      vi.useRealTimers()
    }
  })
})

async function accessKeyOf(stateHome: string): Promise<string> {
  return (await readFile(join(stateHome, 'agent-hub', ACCESS_KEY_FILE), 'utf8')).trim()
}

describe('access key', () => {
  it('is created owner-only, guards the API and builds the login URL', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'agent-hub-start-'))
    const env = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: stateHome }
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), { env, tmux: missingTmux() })
    try {
      const file = join(stateHome, 'agent-hub', ACCESS_KEY_FILE)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      const key = await accessKeyOf(stateHome)
      expect(key).toMatch(/^[\w-]{43}$/)
      expect((await fetch(`${server.url}${API_ROUTES.sessionToken}`)).status).toBe(401)
      expect((await fetch(`${server.url}${API_ROUTES.sessionToken}`, { headers: { [ACCESS_KEY_HEADER]: key } })).status).toBe(200)
      expect((await fetch(`${server.url}${API_ROUTES.health}`)).status).toBe(200)
      expect(await resolveLoginUrl({ ...env, AGENT_HUB_PORT: String(server.port) }, [])).toBe(`http://127.0.0.1:${server.port}/#key=${key}`)
      expect(await resolveLoginUrl(env, ['--port', '3000'])).toBe(`http://127.0.0.1:3000/#key=${key}`)
    } finally {
      await server.shutdown()
      await rm(stateHome, { recursive: true, force: true })
    }
  })

  it('login URL fails clearly before the first start and on a bad port', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'agent-hub-start-'))
    await expect(resolveLoginUrl({ XDG_STATE_HOME: stateHome }, [])).rejects.toThrow(/start Agent Hub once/)
    expect(() => portArgument(['--port', 'x'])).toThrow(/--port/)
    expect(portArgument([])).toBeUndefined()
    await rm(stateHome, { recursive: true, force: true })
  })
})

describe('file service wiring', () => {
  it('serves the file and MCP routes and refuses a backup dir inside a scope', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'agent-hub-start-'))
    const env = { CLAUDE_CONFIG_DIR: '/nonexistent/claude', XDG_STATE_HOME: stateHome }
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), { env, tmux: missingTmux() })
    const headers = { [ACCESS_KEY_HEADER]: await accessKeyOf(stateHome) }
    const response = await fetch(`${server.url}${API_ROUTES.files}`, { headers })
    expect(response.status).toBe(200)
    const mcp = await fetch(`${server.url}${API_ROUTES.mcp}`, { headers })
    expect(mcp.status).toBe(200)
    expect(ListMcpServersResponseSchema.parse(await mcp.json()).servers).toEqual([])
    await server.shutdown()
    await rm(stateHome, { recursive: true, force: true })
    await expect(startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), {
      env: { CLAUDE_CONFIG_DIR: '/nonexistent/claude', XDG_STATE_HOME: '/nonexistent/claude/state' },
    })).rejects.toThrow(/outside the scope/)
  })
})

describe('hook token rotation', () => {
  it('renews a token from an older build on start and rotates it on an explicit install', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'agent-hub-start-'))
    const state = join(stateHome, 'agent-hub')
    const legacy = 'l'.repeat(43)
    await mkdir(state, { recursive: true, mode: 0o700 })
    await writeFile(join(state, HOOK_TOKEN_FILE), `${legacy}\n`, { mode: 0o600 })
    const env = { CLAUDE_CONFIG_DIR: join(stateHome, 'claude'), XDG_STATE_HOME: stateHome, XDG_CONFIG_HOME: stateHome }
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }), { env, tmux: missingTmux() })
    const tokenOnDisk = async () => (await readFile(join(state, HOOK_TOKEN_FILE), 'utf8')).trim()
    const hook = (token: string) => fetch(`${server.url}${API_ROUTES.hooks}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HOOK_TOKEN_HEADER]: token, [HOOK_SESSION_HEADER]: 'someSession' },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    })
    try {
      const renewed = await tokenOnDisk()
      expect(renewed).not.toBe(legacy)
      expect(await readFile(join(state, HOOK_TOKEN_VERSION_FILE), 'utf8')).toBe(`${RELEASE_VERSION}\n`)
      expect(rootPackage.name).toBe('agent-hub')
      expect((await hook(legacy)).status).toBe(401)
      expect((await hook(renewed)).status).toBe(204)

      const key = await accessKeyOf(stateHome)
      const { token } = SessionTokenResponseSchema.parse(await (await fetch(`${server.url}${API_ROUTES.sessionToken}`, { headers: { [ACCESS_KEY_HEADER]: key } })).json())
      const install = await fetch(`${server.url}${API_ROUTES.hooksInstall}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url, [ACCESS_KEY_HEADER]: key, [SESSION_TOKEN_HEADER]: token },
        body: '{}',
      })
      expect(install.status).toBe(200)
      const rotated = await tokenOnDisk()
      expect(rotated).not.toBe(renewed)
      expect((await hook(renewed)).status).toBe(401)
      expect((await hook(rotated)).status).toBe(204)
    } finally {
      await server.shutdown()
      await rm(stateHome, { recursive: true, force: true })
    }
  })
})
