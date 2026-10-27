import { DEFAULT_CONFIG, HealthResponseSchema, API_ROUTES } from '@agent-hub/shared'
import { pino } from 'pino'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SHUTDOWN_TIMEOUT_MS, installShutdown, startServer } from './start.js'

describe('startServer', () => {
  it('listens on loopback with an ephemeral port and shuts down', async () => {
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }))
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${server.url}${API_ROUTES.health}`)
    expect(HealthResponseSchema.safeParse(await response.json()).success).toBe(true)
    await expect(server.shutdown()).resolves.toBe(true)
    await expect(fetch(`${server.url}${API_ROUTES.health}`)).rejects.toThrow()
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

describe('shutdown timeout', () => {
  it('warns and resolves false when close hangs', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      vi.doMock('./app.js', () => ({
        buildApp: () => ({
          listen: () => Promise.resolve(),
          server: { address: () => ({ port: 1 }) },
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
