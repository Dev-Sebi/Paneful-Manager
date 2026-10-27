import type { WsClient } from '@/api/ws'
import type { ServerMessage, WsErrorCode } from '@agent-hub/shared'
import type { Ref } from 'vue'
import { MAX_TERMINAL_SIZE } from '@agent-hub/shared'
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue'

/** Resize frames are sent at most once per quiet period of this length. */
export const RESIZE_DEBOUNCE_MS = 50
/** Input typed while the socket is down is kept up to this many UTF-8 bytes, then dropped. */
export const INPUT_QUEUE_LIMIT_BYTES = 64 * 1024

/** The xterm.js surface the binding needs; a fake implements it in tests. */
export interface AttachTerminal {
  readonly cols: number
  readonly rows: number
  write: (data: string) => void
  reset: () => void
  onData: (listener: (data: string) => void) => { dispose: () => void }
}

export type AttachClient = Pick<WsClient, 'on' | 'send' | 'onOpen'>

export type AttachConnection = 'connecting' | 'connected' | 'exited' | 'failed'

type StateMessage = Extract<ServerMessage, { type: 'state' }>

export interface SessionAttachOptions {
  client: AttachClient
  /** Input is ignored while this returns true. */
  isReadonly?: () => boolean
  onInput?: (data: string) => void
  onState?: (message: StateMessage) => void
  /** The session was removed on the server. */
  onExited?: () => void
  /** Queued input exceeded the limit; called once per outage. */
  onInputDropped?: () => void
}

export interface SessionAttach {
  connection: Readonly<Ref<AttachConnection>>
  /** Last error code for this session, cleared on the next successful attach. */
  errorCode: Readonly<Ref<WsErrorCode | undefined>>
  /** Debounced resize; `force` resends even when the size did not change (pane shown again). */
  resize: (cols: number, rows: number, force?: boolean) => void
  /** Re-attaches with scrollback, e.g. from the failed overlay. */
  retry: () => void
  dispose: () => void
}

function clampSize (value: number): number {
  return Math.min(Math.max(Math.floor(value), 1), MAX_TERMINAL_SIZE)
}

const encoder = new TextEncoder()

/**
 * Binds one terminal to one session over the shared WS client.
 * Output is buffered until the attach's `scrollback` arrives, so the terminal is reset and replayed exactly once.
 */
export function useSessionAttach (sessionId: string, term: AttachTerminal, options: SessionAttachOptions): SessionAttach {
  const { client } = options
  const connection = ref<AttachConnection>('connecting')
  const errorCode = ref<WsErrorCode>()

  /** idle: not attached; awaiting: attach sent, scrollback pending; live: streaming. */
  let phase: 'idle' | 'awaiting' | 'live' = 'idle'
  let pendingOutput: string[] = []
  const inputQueue: string[] = []
  let inputQueueBytes = 0
  let droppedNotified = false
  let lastSent: { cols: number, rows: number } | undefined
  let wanted: { cols: number, rows: number, force: boolean } | undefined
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function attach (): void {
    const cols = clampSize(term.cols)
    const rows = clampSize(term.rows)
    if (!client.send({ type: 'attach', sessionId, cols, rows, scrollback: true })) {
      phase = 'idle'
      return
    }
    phase = 'awaiting'
    pendingOutput = []
    lastSent = { cols, rows }
    if (connection.value !== 'exited') {
      connection.value = 'connecting'
    }
    flushInput()
  }

  function flushInput (): void {
    while (inputQueue.length > 0) {
      const data = inputQueue[0] as string
      if (!client.send({ type: 'input', sessionId, data })) {
        return
      }
      inputQueue.shift()
      inputQueueBytes -= encoder.encode(data).byteLength
    }
    droppedNotified = false
  }

  function queueInput (data: string): void {
    const bytes = encoder.encode(data).byteLength
    if (inputQueueBytes + bytes > INPUT_QUEUE_LIMIT_BYTES) {
      if (!droppedNotified) {
        droppedNotified = true
        options.onInputDropped?.()
      }
      return
    }
    inputQueue.push(data)
    inputQueueBytes += bytes
  }

  function sendInput (data: string): void {
    if (options.isReadonly?.()) {
      return
    }
    options.onInput?.(data)
    if (phase === 'idle' || inputQueue.length > 0 || !client.send({ type: 'input', sessionId, data })) {
      queueInput(data)
    }
  }

  function flushResize (): void {
    resizeTimer = undefined
    const next = wanted
    wanted = undefined
    if (!next || phase === 'idle') {
      return
    }
    if (!next.force && lastSent?.cols === next.cols && lastSent.rows === next.rows) {
      return
    }
    if (client.send({ type: 'resize', sessionId, cols: next.cols, rows: next.rows })) {
      lastSent = { cols: next.cols, rows: next.rows }
    }
  }

  function resize (cols: number, rows: number, force = false): void {
    if (disposed || !(cols >= 1) || !(rows >= 1)) {
      return
    }
    wanted = { cols: clampSize(cols), rows: clampSize(rows), force: force || Boolean(wanted?.force) }
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(flushResize, RESIZE_DEBOUNCE_MS)
  }

  function onScrollback (data: string): void {
    if (phase !== 'awaiting') {
      return
    }
    term.reset()
    term.write(data)
    for (const chunk of pendingOutput) {
      term.write(chunk)
    }
    pendingOutput = []
    phase = 'live'
    errorCode.value = undefined
    if (connection.value !== 'exited') {
      connection.value = 'connected'
    }
  }

  function onOutput (data: string): void {
    if (phase === 'awaiting') {
      pendingOutput.push(data)
    } else if (phase === 'live') {
      term.write(data)
    }
  }

  function onError (code: WsErrorCode): void {
    errorCode.value = code
    if (code === 'not_attached') {
      if (phase === 'live') {
        attach()
      }
      return
    }
    phase = 'idle'
    pendingOutput = []
    if (connection.value !== 'exited') {
      connection.value = 'failed'
    }
  }

  const subscriptions = [
    client.on('scrollback', message => message.sessionId === sessionId && onScrollback(message.data)),
    client.on('output', message => message.sessionId === sessionId && onOutput(message.data)),
    client.on('error', message => message.sessionId === sessionId && onError(message.code)),
    client.on('state', message => {
      if (message.sessionId !== sessionId) {
        return
      }
      if (message.lifecycle === 'exited') {
        connection.value = 'exited'
      } else if (connection.value === 'exited') {
        connection.value = phase === 'live' ? 'connected' : 'connecting'
      }
      options.onState?.(message)
    }),
    client.on('session.removed', message => {
      if (message.sessionId === sessionId) {
        phase = 'idle'
        connection.value = 'exited'
        options.onExited?.()
      }
    }),
    client.onOpen(() => {
      phase = 'idle'
      attach()
    }),
  ]
  const dataSubscription = term.onData(sendInput)

  function dispose (): void {
    if (disposed) {
      return
    }
    disposed = true
    clearTimeout(resizeTimer)
    dataSubscription.dispose()
    for (const off of subscriptions) {
      off()
    }
    if (phase !== 'idle') {
      client.send({ type: 'detach', sessionId })
    }
    phase = 'idle'
  }

  if (getCurrentScope()) {
    onScopeDispose(dispose)
  }

  attach()

  return {
    connection: readonly(connection),
    errorCode: readonly(errorCode),
    resize,
    retry: attach,
    dispose,
  }
}
