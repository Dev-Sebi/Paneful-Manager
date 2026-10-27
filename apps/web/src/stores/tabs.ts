import type { AppTab } from '@agent-hub/shared'
import { AppTabSchema, z } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readStorage, writeStorage } from './storage'

export const TABS_STORAGE_KEY = 'agent-hub.tabs.v1'

const PersistedTabsSchema = z.strictObject({
  tabs: z.array(AppTabSchema),
  activeId: z.string().nullable(),
})

function loadTabs (): z.infer<typeof PersistedTabsSchema> {
  const raw = readStorage(TABS_STORAGE_KEY)
  const parsed = PersistedTabsSchema.safeParse(raw)
  if (!parsed.success) {
    if (raw !== undefined) {
      console.warn('[tabs] dropped invalid persisted tabs payload')
    }
    return { tabs: [], activeId: null }
  }
  const { tabs, activeId } = parsed.data
  return { tabs, activeId: tabs.some(tab => tab.id === activeId) ? activeId : (tabs[0]?.id ?? null) }
}

export const useTabsStore = defineStore('tabs', () => {
  const saved = loadTabs()
  const tabs = ref<AppTab[]>(saved.tabs)
  const activeId = ref<string | null>(saved.activeId)
  /** Reserved for unacknowledged output; not persisted. */
  const dirty = ref<Record<string, boolean>>({})

  function add (tab: AppTab) {
    tabs.value.push(tab)
    activeId.value = tab.id
  }

  /** Replaces the tab with the same id in place, or adds it; either way it becomes active. */
  function upsert (tab: AppTab) {
    const index = tabs.value.findIndex(item => item.id === tab.id)
    if (index === -1) {
      add(tab)
      return
    }
    tabs.value[index] = tab
    activeId.value = tab.id
  }

  function close (id: string) {
    const index = tabs.value.findIndex(tab => tab.id === id)
    if (index === -1) {
      return
    }
    tabs.value.splice(index, 1)
    delete dirty.value[id]
    if (activeId.value === id) {
      activeId.value = (tabs.value[index] ?? tabs.value[index - 1])?.id ?? null
    }
  }

  function activate (id: string) {
    if (tabs.value.some(tab => tab.id === id)) {
      activeId.value = id
    }
  }

  function move (from: number, to: number) {
    const [moved] = tabs.value.splice(from, 1)
    if (moved) {
      tabs.value.splice(to, 0, moved)
    }
  }

  function setDirty (id: string, value: boolean) {
    dirty.value[id] = value
  }

  watch([tabs, activeId], () => writeStorage(TABS_STORAGE_KEY, { tabs: tabs.value, activeId: activeId.value }), { deep: true })

  return { tabs, activeId, dirty, add, upsert, close, activate, move, setDirty }
})
