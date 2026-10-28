import type { Scope } from '@paneful-manager/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'

export const useScopesStore = defineStore('scopes', () => {
  const scopes = ref<Scope[]>([])
  const loading = ref(false)
  const error = ref<string>()

  async function load () {
    loading.value = true
    try {
      scopes.value = (await api.listScopes()).scopes
      error.value = undefined
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load scopes'
    } finally {
      loading.value = false
    }
  }

  return { scopes, loading, error, load }
})
