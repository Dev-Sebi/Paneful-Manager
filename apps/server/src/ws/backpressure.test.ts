import { parseServerMessage } from '@paneful-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_SLOW_CONSUMER, OutputQueue, type OutputSocket } from './backpressure.js'

class FakeSocket implements OutputSocket {
  bufferedAmount = 0
  sent: string[] = []
  closed: { code: number, reason: string } | undefined

  send(data: string): void {
    this.sent.push(data)
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }

  frames(): unknown[] {
    return this.sent.map(raw => {
      const parsed = parseServerMessage(raw)
      if (!parsed.success) {
        throw new Error(parsed.error)
      }
      return parsed.data
    })
  }
}

const options = { coalesceThreshold: 100, slowConsumerLimit: 1000, flushIntervalMs: 10 }
let socket: FakeSocket
let queue: OutputQueue

beforeEach(() => {
  vi.useFakeTimers()
  socket = new FakeSocket()
  queue = new OutputQueue(socket, options)
})

afterEach(() => {
  queue.dispose()
  vi.useRealTimers()
})

describe('OutputQueue', () => {
  it('sends output immediately below the threshold', () => {
    queue.output('s1', 'a')
    queue.output('s2', 'b')
    expect(socket.frames()).toEqual([
      { type: 'output', sessionId: 's1', data: 'a' },
      { type: 'output', sessionId: 's2', data: 'b' },
    ])
  })

  it('coalesces per session while the buffer is full and flushes when it drains', () => {
    socket.bufferedAmount = 100
    queue.output('s1', 'a')
    queue.output('s2', 'x')
    queue.output('s1', 'b')
    expect(socket.sent).toEqual([])
    vi.advanceTimersByTime(10)
    expect(socket.sent).toEqual([])
    socket.bufferedAmount = 0
    queue.output('s1', 'c')
    expect(socket.sent).toEqual([])
    vi.advanceTimersByTime(10)
    expect(socket.frames()).toEqual([
      { type: 'output', sessionId: 's1', data: 'abc' },
      { type: 'output', sessionId: 's2', data: 'x' },
    ])
    expect(queue.pendingSize).toBe(0)
    queue.output('s1', 'd')
    expect(socket.sent).toHaveLength(3)
  })

  it('closes slow consumers with 4008 and stops sending', () => {
    socket.bufferedAmount = 100
    queue.output('s1', 'x'.repeat(600))
    expect(socket.closed).toBeUndefined()
    queue.output('s1', 'x'.repeat(600))
    expect(socket.closed).toEqual({ code: CLOSE_SLOW_CONSUMER, reason: 'slow consumer' })
    socket.bufferedAmount = 0
    queue.output('s1', 'late')
    vi.advanceTimersByTime(50)
    expect(socket.sent).toEqual([])
  })

  it('counts every frame, including scrollback, against the limit', () => {
    socket.bufferedAmount = 900
    queue.send({ type: 'pong' })
    expect(socket.sent).toHaveLength(1)
    queue.send({ type: 'scrollback', sessionId: 's1', data: 'x'.repeat(200) })
    expect(socket.closed?.code).toBe(CLOSE_SLOW_CONSUMER)
    expect(socket.sent).toHaveLength(1)
  })

  it('counts bytes, not characters', () => {
    socket.bufferedAmount = 100
    queue.output('s1', '€'.repeat(10))
    expect(queue.pendingSize).toBe(30)
  })

  it('drops pending output of a detached session', () => {
    socket.bufferedAmount = 100
    queue.output('s1', 'abc')
    queue.output('s2', 'de')
    queue.drop('s1')
    expect(queue.pendingSize).toBe(2)
    socket.bufferedAmount = 0
    vi.advanceTimersByTime(10)
    expect(socket.frames()).toEqual([{ type: 'output', sessionId: 's2', data: 'de' }])
  })
})
