// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay, createWsClient } from './ws'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor (readonly url: string, readonly protocols: string[]) {
    FakeSocket.instances.push(this)
  }

  addEventListener (type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send (data: string) {
    this.sent.push(data)
  }

  close () {
    this.readyState = 3
  }

  emit (type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  open () {
    this.readyState = 1
    this.emit('open')
  }

  drop () {
    this.readyState = 3
    this.emit('close')
  }
}

function setup () {
  let counter = 0
  const getToken = vi.fn(async () => 'cached')
  const refreshToken = vi.fn(async () => `fresh-${++counter}`)
  const client = createWsClient({
    url: 'ws://host/ws?v=1',
    createSocket: (url, protocols) => new FakeSocket(url, protocols) as unknown as WebSocket,
    getToken,
    refreshToken,
  })
  return { client, getToken, refreshToken }
}

const last = () => FakeSocket.instances.at(-1) as FakeSocket

describe('ws client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeSocket.instances = []
  })
  afterEach(() => vi.useRealTimers())

  it('computes a capped exponential backoff', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(attempt => backoffDelay(attempt))).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000])
  })

  it('connects with the version query and subprotocols', async () => {
    const { client, getToken } = setup()
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(last().url).toBe('ws://host/ws?v=1')
    expect(last().protocols).toEqual(['agent-hub.v1', 'token.cached'])
  })

  it('reconnects with growing delays and a fresh token each time', async () => {
    const { client, refreshToken } = setup()
    client.connect()
    await vi.advanceTimersByTimeAsync(0)

    last().drop()
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(last().protocols[1]).toBe('token.fresh-1')

    last().drop()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(3)
    expect(refreshToken).toHaveBeenCalledTimes(2)
  })

  it('resets the backoff after a successful open', async () => {
    const { client } = setup()
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    last().drop()
    await vi.advanceTimersByTimeAsync(500)
    last().open()
    last().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('retries when the token cannot be fetched', async () => {
    const { client, refreshToken } = setup()
    refreshToken.mockRejectedValueOnce(new Error('down'))
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    last().drop()
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after close()', async () => {
    const { client } = setup()
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    client.close()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('dispatches parsed messages by type and ignores invalid frames', async () => {
    const { client } = setup()
    const removed = vi.fn()
    const off = client.on('session.removed', removed)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)

    last().emit('message', { data: 'not json' })
    last().emit('message', { data: JSON.stringify({ type: 'bogus' }) })
    last().emit('message', { data: JSON.stringify({ type: 'pong' }) })
    last().emit('message', { data: JSON.stringify({ type: 'session.removed', sessionId: 'a' }) })
    expect(removed).toHaveBeenCalledExactlyOnceWith({ type: 'session.removed', sessionId: 'a' })

    off()
    last().emit('message', { data: JSON.stringify({ type: 'session.removed', sessionId: 'b' }) })
    expect(removed).toHaveBeenCalledTimes(1)
  })

  it('sends only while the socket is open', async () => {
    const { client } = setup()
    expect(client.send({ type: 'ping' })).toBe(false)
    client.connect()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.send({ type: 'ping' })).toBe(false)
    last().open()
    expect(client.send({ type: 'ping' })).toBe(true)
    expect(last().sent).toEqual(['{"type":"ping"}'])
  })
})
