import type { ServerMessage } from '@agent-hub/shared'

/** At or above this `bufferedAmount`, output is coalesced per session. */
export const COALESCE_THRESHOLD_BYTES = 1024 * 1024
/** Socket buffer plus pending output above this closes the connection as a slow consumer. */
export const SLOW_CONSUMER_LIMIT_BYTES = 8 * 1024 * 1024
export const FLUSH_INTERVAL_MS = 25
export const CLOSE_SLOW_CONSUMER = 4008

export interface OutputSocket {
  readonly bufferedAmount: number
  send: (data: string) => void
  close: (code: number, reason: string) => void
}

export interface OutputQueueOptions {
  coalesceThreshold?: number
  slowConsumerLimit?: number
  flushIntervalMs?: number
}

/** Per-connection output policy: send, coalesce while the socket buffer is full, close with 4008 when too far behind. */
export class OutputQueue {
  private readonly pending = new Map<string, string[]>()
  private pendingBytes = 0
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly coalesceThreshold: number
  private readonly slowConsumerLimit: number
  private readonly flushIntervalMs: number

  constructor(
    private readonly socket: OutputSocket,
    options: OutputQueueOptions = {},
  ) {
    this.coalesceThreshold = options.coalesceThreshold ?? COALESCE_THRESHOLD_BYTES
    this.slowConsumerLimit = options.slowConsumerLimit ?? SLOW_CONSUMER_LIMIT_BYTES
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
  }

  get pendingSize(): number {
    return this.pendingBytes
  }

  /** Sends a frame right away; every frame counts against the slow-consumer limit. */
  send(message: ServerMessage): void {
    if (this.closed) {
      return
    }
    const frame = JSON.stringify(message)
    if (this.isOverLimit(Buffer.byteLength(frame))) {
      this.closeSlow()
      return
    }
    this.socket.send(frame)
  }

  output(sessionId: string, data: string): void {
    if (this.closed) {
      return
    }
    const chunks = this.pending.get(sessionId)
    if (chunks === undefined && this.socket.bufferedAmount < this.coalesceThreshold) {
      this.send({ type: 'output', sessionId, data })
      return
    }
    if (chunks === undefined) {
      this.pending.set(sessionId, [data])
    } else {
      chunks.push(data)
    }
    this.pendingBytes += Buffer.byteLength(data)
    if (this.isOverLimit(0)) {
      this.closeSlow()
      return
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushIntervalMs)
  }

  /** Drops pending output of a session (after detach). */
  drop(sessionId: string): void {
    const chunks = this.pending.get(sessionId)
    if (chunks !== undefined) {
      this.pendingBytes -= chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0)
      this.pending.delete(sessionId)
    }
  }

  /** Sends every pending session as one frame once the socket buffer drained; otherwise retries later. */
  flush(): void {
    this.timer = undefined
    if (this.closed || this.pending.size === 0) {
      return
    }
    if (this.socket.bufferedAmount >= this.coalesceThreshold) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs)
      return
    }
    const entries = [...this.pending]
    this.pending.clear()
    this.pendingBytes = 0
    for (const [sessionId, chunks] of entries) {
      this.send({ type: 'output', sessionId, data: chunks.join('') })
    }
  }

  dispose(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.pendingBytes = 0
  }

  private isOverLimit(extraBytes: number): boolean {
    return this.socket.bufferedAmount + this.pendingBytes + extraBytes > this.slowConsumerLimit
  }

  private closeSlow(): void {
    this.dispose()
    this.socket.close(CLOSE_SLOW_CONSUMER, 'slow consumer')
  }
}
