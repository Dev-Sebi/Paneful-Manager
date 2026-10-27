import type { WsEvents } from '@/api/ws'
import type { Team } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'

/** Bursts of `team.changed` frames collapse into one reload. */
export const TEAMS_REFRESH_DEBOUNCE_MS = 300

export const useTeamsStore = defineStore('teams', () => {
  const enabled = ref(false)
  const teams = ref<Team[]>([])
  const warnings = ref<string[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  async function load () {
    loading.value = true
    try {
      const response = await api.listTeams()
      enabled.value = response.enabled
      teams.value = response.teams
      warnings.value = response.warnings
      error.value = undefined
      loaded.value = true
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load teams'
    } finally {
      loading.value = false
    }
  }

  function scheduleLoad () {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, TEAMS_REFRESH_DEBOUNCE_MS)
  }

  /** Subscribes to `team.changed`; returns an unsubscribe function. */
  function bind (events: WsEvents) {
    const off = events.on('team.changed', scheduleLoad)
    return () => {
      off()
      clearTimeout(timer)
      timer = undefined
    }
  }

  return { enabled, teams, warnings, loading, loaded, error, load, bind }
})
