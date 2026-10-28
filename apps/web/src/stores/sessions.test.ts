import type { WsEvents } from '@/api/ws'
// @vitest-environment jsdom
import type { ServerMessage } from '@agent-hub/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSession } from '@/test/fixtures'
import { useSessionsStore } from './sessions'

const listSessions = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { listSessions } }))

function fakeEvents () {
  const handlers = new Map<string, Array<(message: never) => void>>()
  const events: WsEvents = {
    on: (type, handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler as (message: never) => void])
      return () => handlers.set(type, [])
    },
  }
  const emit = (message: ServerMessage) => {
    for (const handler of handlers.get(message.type) ?? []) {
      handler(message as never)
    }
  }
  return { events, emit }
}

describe('sessions store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listSessions.mockReset()
  })

  it('loads the list from the API', async () => {
    listSessions.mockResolvedValue({ sessions: [makeSession('a')] })
    const store = useSessionsStore()
    await store.load()
    expect(store.sessions.map(session => session.id)).toEqual(['a'])
  })

  it('keeps the list and records the error when loading fails', async () => {
    listSessions.mockRejectedValue(new Error('down'))
    const store = useSessionsStore()
    await store.load()
    expect(store.error).toBe('down')
  })

  it('applies created, state and removed events', () => {
    const store = useSessionsStore()
    const { events, emit } = fakeEvents()
    store.bind(events)

    emit({ type: 'session.created', session: makeSession('a') })
    emit({ type: 'session.created', session: makeSession('a', { title: 'renamed' }) })
    expect(store.sessions).toHaveLength(1)
    expect(store.byId.get('a')?.title).toBe('renamed')

    emit({ type: 'state', sessionId: 'a', state: 'error', lifecycle: 'exited', exitCode: 2 })
    expect(store.byId.get('a')).toMatchObject({ state: 'error', lifecycle: 'exited', exitCode: 2 })

    emit({ type: 'state', sessionId: 'unknown', state: 'idle', lifecycle: 'running' })
    expect(store.sessions).toHaveLength(1)

    emit({ type: 'session.removed', sessionId: 'a' })
    expect(store.sessions).toHaveLength(0)
  })

  it('keeps stateSince from state events and falls back sensibly', () => {
    const store = useSessionsStore()
    const { events, emit } = fakeEvents()
    store.bind(events)
    emit({ type: 'session.created', session: makeSession('a', { state: 'idle', stateSince: '2026-10-27T10:00:00.000Z' }) })

    emit({ type: 'state', sessionId: 'a', state: 'idle', lifecycle: 'running' })
    expect(store.byId.get('a')?.stateSince).toBe('2026-10-27T10:00:00.000Z')

    emit({ type: 'state', sessionId: 'a', state: 'working', lifecycle: 'running', stateSince: '2026-10-27T10:05:00.000Z' })
    expect(store.byId.get('a')?.stateSince).toBe('2026-10-27T10:05:00.000Z')

    emit({ type: 'state', sessionId: 'a', state: 'waiting', lifecycle: 'running' })
    expect(store.byId.get('a')?.stateSince).not.toBe('2026-10-27T10:05:00.000Z')
  })

  it('stops applying events after unbinding', () => {
    const store = useSessionsStore()
    const { events, emit } = fakeEvents()
    const unbind = store.bind(events)
    unbind()
    emit({ type: 'session.created', session: makeSession('a') })
    expect(store.sessions).toHaveLength(0)
  })
})
