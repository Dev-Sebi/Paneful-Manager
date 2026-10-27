import { z } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readStorage, writeStorage } from './storage'

export const LAYOUT_SIZES_STORAGE_KEY = 'agent-hub.layout-sizes.v1'

/** Sizes in percent of the panes of one split node. */
const SizesSchema = z.array(z.number().positive()).min(2)
/** Tab id to split node path to sizes. */
const PersistedSizesSchema = z.record(z.string(), z.record(z.string(), SizesSchema))

type PersistedSizes = z.infer<typeof PersistedSizesSchema>

const SUM_TOLERANCE = 1

function loadSizes (): PersistedSizes {
  const raw = readStorage(LAYOUT_SIZES_STORAGE_KEY)
  const parsed = PersistedSizesSchema.safeParse(raw)
  if (!parsed.success && raw !== undefined) {
    console.warn('[layout-sizes] dropped invalid persisted payload')
  }
  return parsed.success ? parsed.data : {}
}

export const useLayoutSizesStore = defineStore('layoutSizes', () => {
  const sizes = ref<PersistedSizes>(loadSizes())

  /** Saved sizes for a split node, or undefined when none fit the node's pane count. */
  function get (tabId: string, path: string, count: number): number[] | undefined {
    const saved = sizes.value[tabId]?.[path]
    if (!saved || saved.length !== count) {
      return undefined
    }
    const total = saved.reduce((sum, value) => sum + value, 0)
    return Math.abs(total - 100) <= SUM_TOLERANCE ? saved : undefined
  }

  function set (tabId: string, path: string, value: number[]) {
    sizes.value[tabId] = { ...sizes.value[tabId], [path]: value }
  }

  /** Drops every saved size of a tab, so its layout returns to the defaults. */
  function reset (tabId: string) {
    delete sizes.value[tabId]
  }

  /** Drops sizes of tabs that no longer exist. */
  function prune (tabIds: readonly string[]) {
    for (const id of Object.keys(sizes.value)) {
      if (!tabIds.includes(id)) {
        delete sizes.value[id]
      }
    }
  }

  watch(sizes, () => writeStorage(LAYOUT_SIZES_STORAGE_KEY, sizes.value), { deep: true })

  return { sizes, get, set, reset, prune }
})
