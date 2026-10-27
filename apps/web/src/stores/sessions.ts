import type { WsEvents } from '@/api/ws'
import type { Session } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/client'

export const useSessionsStore = defineStore('sessions', () => {
  const sessions = ref<Session[]>([])
  const loading = ref(false)
  const error = ref<string>()

  const byId = computed(() => new Map(sessions.value.map(session => [session.id, session])))

  async function load () {
    loading.value = true
    try {
      sessions.value = (await api.listSessions()).sessions
      error.value = undefined
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load sessions'
    } finally {
      loading.value = false
    }
  }

  function upsert (session: Session) {
    const index = sessions.value.findIndex(item => item.id === session.id)
    if (index === -1) {
      sessions.value.push(session)
    } else {
      sessions.value[index] = session
    }
  }

  function remove (id: string) {
    sessions.value = sessions.value.filter(session => session.id !== id)
  }

  /** Subscribes to live session events; returns an unsubscribe function. */
  function bind (events: WsEvents) {
    const offs = [
      events.on('session.created', message => upsert(message.session)),
      events.on('session.removed', message => remove(message.sessionId)),
      events.on('state', message => {
        const current = byId.value.get(message.sessionId)
        if (current) {
          upsert({
            ...current,
            state: message.state,
            lifecycle: message.lifecycle,
            exitCode: message.exitCode,
            lastEventAt: new Date().toISOString(),
          })
        }
      }),
    ]
    return () => {
      for (const off of offs) {
        off()
      }
    }
  }

  return { sessions, loading, error, byId, load, upsert, remove, bind }
})
