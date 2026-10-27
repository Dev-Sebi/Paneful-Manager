import { DEFAULT_CONFIG, HealthResponseSchema, API_ROUTES } from '@agent-hub/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { startServer } from './start.js'

describe('startServer', () => {
  it('listens on loopback with an ephemeral port and shuts down', async () => {
    const server = await startServer({ ...DEFAULT_CONFIG, port: 0 }, pino({ level: 'silent' }))
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${server.url}${API_ROUTES.health}`)
    expect(HealthResponseSchema.safeParse(await response.json()).success).toBe(true)
    await expect(server.shutdown()).resolves.toBeUndefined()
    await expect(fetch(`${server.url}${API_ROUTES.health}`)).rejects.toThrow()
  })
})
