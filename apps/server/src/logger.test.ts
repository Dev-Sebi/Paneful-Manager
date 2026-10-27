import { DEFAULT_CONFIG } from '@agent-hub/shared'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { createLogger } from './logger.js'

const TOKEN = 'log-secret-token'

function capture() {
  const stream = new PassThrough()
  const chunks: string[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  return { logger: createLogger('info', {}, stream), output: () => chunks.join('') }
}

describe('createLogger', () => {
  it('redacts credential headers', () => {
    const { logger, output } = capture()
    logger.info(
      {
        req: {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'x-agent-hub-token': TOKEN,
            'x-agent-hub-hook-token': TOKEN,
            'sec-websocket-protocol': `agent-hub.v1, token.${TOKEN}`,
            host: 'localhost:7337',
          },
        },
      },
      'request',
    )
    expect(output()).toContain('localhost:7337')
    expect(output()).not.toContain(TOKEN)
  })

  it('redacts credential headers nested under any key', () => {
    const { logger, output } = capture()
    logger.info({ upgrade: { headers: { 'sec-websocket-protocol': `token.${TOKEN}`, 'x-agent-hub-hook-token': TOKEN } } }, 'upgrade')
    expect(output()).toContain('upgrade')
    expect(output()).not.toContain(TOKEN)
  })

  it('keeps the token out of request logs', async () => {
    const { logger, output } = capture()
    const app = buildApp({ config: DEFAULT_CONFIG, logger, sessionToken: TOKEN, dev: false })
    app.post('/api/test-mutation', () => ({}))
    await app.inject({ method: 'POST', url: '/api/test-mutation', headers: { host: 'localhost', origin: 'http://localhost:7337', 'x-agent-hub-token': TOKEN } })
    await app.inject({ method: 'GET', url: '/api/session-token', headers: { host: 'localhost' } })
    await app.close()
    expect(output()).toContain('incoming request')
    expect(output()).not.toContain(TOKEN)
  })
})
