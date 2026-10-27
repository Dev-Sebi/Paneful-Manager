import type { AppConfig } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/client'

export const useConfigStore = defineStore('config', () => {
  const config = ref<AppConfig>()
  const loaded = ref(false)
  const error = ref<string>()
  let pending: Promise<void> | undefined

  const agentTeams = computed(() => config.value?.experimental.agentTeams ?? false)
  const confirmCloseTab = computed(() => config.value?.confirmCloseTab ?? true)
  const theme = computed(() => config.value?.theme ?? 'dark')

  async function load () {
    try {
      config.value = (await api.getConfig()).config
      error.value = undefined
      loaded.value = true
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load config'
      loaded.value = false
    }
  }

  /** Loads once; concurrent callers share the request. Use `reload` to force. */
  function ensureLoaded () {
    if (!loaded.value) {
      pending ??= load().finally(() => {
        pending = undefined
      })
    }
    return pending ?? Promise.resolve()
  }

  async function reload () {
    loaded.value = false
    await ensureLoaded()
  }

  return { config, loaded, error, agentTeams, confirmCloseTab, theme, ensureLoaded, reload }
})
