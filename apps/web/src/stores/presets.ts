import type { AppTab, WorkspacePreset } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api/client'
import { useSessionsStore } from './sessions'

export const usePresetsStore = defineStore('presets', () => {
  const presets = ref<WorkspacePreset[]>([])
  const loading = ref(false)
  const error = ref<string>()

  async function load () {
    loading.value = true
    try {
      presets.value = (await api.listPresets()).presets
      error.value = undefined
    } catch (error_) {
      error.value = error_ instanceof Error ? error_.message : 'Could not load presets'
    } finally {
      loading.value = false
    }
  }

  /** Creates a new preset, or replaces the existing one with the same name when `existing` is set. */
  async function save (preset: WorkspacePreset, existing: boolean) {
    const { preset: saved } = await (existing ? api.updatePreset(preset.name, { preset }) : api.createPreset({ preset }))
    const index = presets.value.findIndex(item => item.name === saved.name)
    if (index === -1) {
      presets.value = [...presets.value, saved].toSorted((a, b) => a.name.localeCompare(b.name))
    } else {
      presets.value[index] = saved
    }
    return saved
  }

  async function remove (name: string) {
    await api.deletePreset(name)
    presets.value = presets.value.filter(item => item.name !== name)
  }

  /** Starts the preset's sessions and returns its tabs, ready for the tabs store. */
  async function launch (name: string): Promise<AppTab[]> {
    const { tabs } = await api.launchPreset(name)
    await useSessionsStore().load()
    return tabs.map(tab => ({ ...tab, id: `tab-${tab.panes[0]?.sessionId ?? crypto.randomUUID()}` }))
  }

  return { presets, loading, error, load, save, remove, launch }
})
