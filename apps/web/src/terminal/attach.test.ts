import type { AttachClient, AttachTerminal } from './attach'
import type { ClientMessageInput, ServerMessage, ServerMessageType } from '@paneful-manager/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { INPUT_FRAME_LIMIT_BYTES, INPUT_QUEUE_LIMIT_BYTES, RESIZE_DEBOUNCE_MS, splitInput, useSessionAttach } from './attach'

class FakeClient implements AttachClient {
  open = true
  sent: ClientMessageInput[] = []
  private handlers = new Map<string, Set<(message: never) => void>>()
  private openHandlers = new Set<() => void>()

  send = (message: ClientMessageInput) => {
    if (!this.open) {
      return false
    }
    this.sent.push(message)
    return true
  }

  on: AttachClient['on'] = <T extends ServerMessageType>(type: T, handler: (message: Extract<ServerMessage, { type: T }>) => void) => {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (message: never) => void)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler as (message: never) => void)
    }
  }

  onOpen = (handler: () => void) => {
    this.openHandlers.add(handler)
    return () => {
      this.openHandlers.delete(handler)
    }
  }

  emit (message: ServerMessage) {
    for (const handler of this.handlers.get(message.type) ?? []) {
      handler(message as never)
    }
  }

  reconnect () {
    this.open = true
    for (const handler of this.openHandlers) {
      handler()
    }
  }

  listenerCount () {
    return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0) + this.openHandlers.size
  }

  ofType<T extends ClientMessageInput['type']> (type: T) {
    return this.sent.filter((message): message is Extract<ClientMessageInput, { type: T }> => message.type === type)
  }
}

class FakeTerminal implements AttachTerminal {
  cols = 80
  rows = 24
  log: string[] = []
  private listener: ((data: string) => void) | undefined

  write (data: string) {
    this.log.push(`write:${data}`)
  }

  reset () {
    this.log.push('reset')
  }

  onData (listener: (data: string) => void) {
    this.listener = listener
    return { dispose: () => {
      this.listener = undefined
    } }
  }

  type (data: string) {
    this.listener?.(data)
  }
}

const ID = 's1'

function setup (options: { open?: boolean } = {}) {
  const client = new FakeClient()
  client.open = options.open ?? true
  const term = new FakeTerminal()
  const scope = effectScope()
  const onExited = vi.fn()
  const onInputDropped = vi.fn()
  const onState = vi.fn()
  const attach = scope.run(() => useSessionAttach(ID, term, { client, onExited, onInputDropped, onState }))
  if (!attach) {
    throw new Error('scope did not run')
  }
  return { client, term, scope, attach, onExited, onInputDropped, onState }
}

describe('useSessionAttach', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('attaches on start with the terminal size and scrollback', () => {
    const { client, attach } = setup()
    expect(client.sent).toEqual([{ type: 'attach', sessionId: ID, cols: 80, rows: 24, scrollback: true }])
    expect(attach.connection.value).toBe('connecting')
  })

  it('buffers output that arrives before the scrollback and writes everything once in order', () => {
    const { client, term, attach } = setup()
    client.emit({ type: 'output', sessionId: ID, data: 'early' })
    client.emit({ type: 'output', sessionId: 'other', data: 'foreign' })
    expect(term.log).toEqual([])
    client.emit({ type: 'scrollback', sessionId: ID, data: 'history' })
    client.emit({ type: 'output', sessionId: ID, data: 'live' })
    client.emit({ type: 'scrollback', sessionId: ID, data: 'duplicate' })
    expect(term.log).toEqual(['reset', 'write:history', 'write:early', 'write:live'])
    expect(attach.connection.value).toBe('connected')
  })

  it('debounces resize, sends the last size and skips unchanged or empty sizes', () => {
    const { client, attach } = setup()
    client.emit({ type: 'scrollback', sessionId: ID, data: '' })
    attach.resize(100, 30)
    attach.resize(120, 40)
    attach.resize(0, 40)
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS - 1)
    expect(client.ofType('resize')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(client.ofType('resize')).toEqual([{ type: 'resize', sessionId: ID, cols: 120, rows: 40 }])
    attach.resize(120, 40)
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS)
    expect(client.ofType('resize')).toHaveLength(1)
    attach.resize(120, 40, true)
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS)
    expect(client.ofType('resize')).toHaveLength(2)
  })

  it('forwards raw input without changing it', () => {
    const { client, term } = setup()
    term.type('echo hi\r')
    term.type('  \n\u001B[A')
    expect(client.ofType('input').map(message => message.data)).toEqual(['echo hi\r', '  \n\u001B[A'])
  })

  it('queues input during a reconnect and flushes it after the re-attach', () => {
    const { client, term } = setup()
    client.emit({ type: 'scrollback', sessionId: ID, data: '' })
    client.open = false
    term.type('a')
    term.type('b')
    expect(client.ofType('input')).toEqual([])
    client.reconnect()
    const types = client.sent.map(message => message.type)
    expect(types.slice(-3)).toEqual(['attach', 'input', 'input'])
    expect(client.ofType('input').map(message => message.data)).toEqual(['a', 'b'])
  })

  it('drops input beyond the queue limit and everything after it until the queue drains', () => {
    const { client, term, onInputDropped } = setup()
    client.open = false
    term.type('x'.repeat(INPUT_QUEUE_LIMIT_BYTES - 1))
    term.type('yy')
    term.type('z')
    expect(onInputDropped).toHaveBeenCalledTimes(1)
    client.reconnect()
    expect(client.ofType('input').map(message => message.data)).toEqual(['x'.repeat(INPUT_QUEUE_LIMIT_BYTES - 1)])
    term.type('after')
    expect(client.ofType('input').at(-1)?.data).toBe('after')
  })

  it('splits large input into ordered frames on code point boundaries', () => {
    const { client, term } = setup()
    client.emit({ type: 'scrollback', sessionId: ID, data: '' })
    const paste = `${'a'.repeat(INPUT_FRAME_LIMIT_BYTES - 1)}😀${'b'.repeat(10)}`
    term.type(paste)
    const frames = client.ofType('input').map(message => message.data)
    expect(frames.join('')).toBe(paste)
    expect(frames).toHaveLength(2)
    expect(frames[0]).toBe('a'.repeat(INPUT_FRAME_LIMIT_BYTES - 1))
    expect(frames[1]?.startsWith('😀')).toBe(true)
  })

  it('re-attaches after a reconnect and resets the terminal before the new scrollback', () => {
    const { client, term } = setup()
    client.emit({ type: 'scrollback', sessionId: ID, data: 'one' })
    client.emit({ type: 'output', sessionId: ID, data: 'two' })
    client.open = false
    client.reconnect()
    expect(client.ofType('attach')).toHaveLength(2)
    client.emit({ type: 'output', sessionId: ID, data: 'three' })
    client.emit({ type: 'scrollback', sessionId: ID, data: 'one two' })
    expect(term.log).toEqual(['reset', 'write:one', 'write:two', 'reset', 'write:one two', 'write:three'])
  })

  it('detaches while paused, ignores reconnects and re-attaches with scrollback on resume', () => {
    const { client, term, attach } = setup()
    client.emit({ type: 'scrollback', sessionId: ID, data: 'one' })
    attach.pause()
    expect(client.sent.at(-1)).toEqual({ type: 'detach', sessionId: ID })
    client.emit({ type: 'output', sessionId: ID, data: 'late' })
    client.reconnect()
    expect(client.ofType('attach')).toHaveLength(1)
    attach.resize(90, 30)
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS)
    expect(client.ofType('resize')).toEqual([])
    attach.resume()
    expect(client.ofType('attach')).toHaveLength(2)
    client.emit({ type: 'scrollback', sessionId: ID, data: 'one two' })
    expect(term.log).toEqual(['reset', 'write:one', 'reset', 'write:one two'])
  })

  it('attaches once the socket opens when it was closed at start', () => {
    const { client } = setup({ open: false })
    expect(client.sent).toEqual([])
    client.reconnect()
    expect(client.ofType('attach')).toHaveLength(1)
  })

  it('detaches and unsubscribes when the scope is disposed', () => {
    const { client, scope, term } = setup()
    scope.stop()
    expect(client.sent.at(-1)).toEqual({ type: 'detach', sessionId: ID })
    expect(client.listenerCount()).toBe(0)
    term.type('ignored')
    expect(client.ofType('input')).toEqual([])
  })

  it('shows failure on tmux_unavailable and recovers with retry', () => {
    const { client, attach } = setup()
    client.emit({ type: 'error', sessionId: ID, code: 'tmux_unavailable', message: 'down' })
    expect(attach.connection.value).toBe('failed')
    expect(attach.errorCode.value).toBe('tmux_unavailable')
    attach.retry()
    expect(client.ofType('attach')).toHaveLength(2)
    client.emit({ type: 'scrollback', sessionId: ID, data: '' })
    expect(attach.connection.value).toBe('connected')
    expect(attach.errorCode.value).toBeUndefined()
  })

  it('reports exit from state frames and session removal', () => {
    const { client, attach, onExited, onState } = setup()
    client.emit({ type: 'state', sessionId: ID, state: 'idle', lifecycle: 'exited', exitCode: 2 })
    expect(attach.connection.value).toBe('exited')
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 2 }))
    client.emit({ type: 'session.removed', sessionId: ID })
    expect(onExited).toHaveBeenCalledTimes(1)
  })
})

describe('splitInput', () => {
  it('keeps every chunk within the byte limit without cutting code points', () => {
    expect(splitInput('', 4)).toEqual([])
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef'])
    expect(splitInput('ab€c', 4)).toEqual(['ab', '€c'])
    expect(splitInput('😀😀', 4)).toEqual(['😀', '😀'])
    expect(splitInput('a😀', 4)).toEqual(['a', '😀'])
  })
})
