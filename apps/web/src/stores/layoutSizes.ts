import { z } from '@paneful-manager/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readStorage, writeStorage } from './storage'

export const LAYOUT_SIZES_STORAGE_KEY = 'paneful-manager.layout-sizes.v1'

/** Sizes in percent of the panes of one split node. */
const SizesSchema = z.array(z.number().positive()).min(2)
/** Split node path to sizes, for one tab. */
const TabSizesSchema = z.record(z.string(), SizesSchema)

type PersistedSizes = Record<string, z.infer<typeof TabSizesSchema>>

/** Smallest share of a split a pane can shrink to, in percent. */
export const MIN_PANE_PERCENT = 10

const SUM_TOLERANCE = 1

function loadSizes (): PersistedSizes {
  const raw = readStorage(LAYOUT_SIZES_STORAGE_KEY)
  const outer = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!outer.success) {
    if (raw !== undefined) {
      console.warn('[layout-sizes] dropped invalid persisted payload')
    }
    return {}
  }
  const result: PersistedSizes = {}
  for (const [tabId, entry] of Object.entries(outer.data)) {
    const parsed = TabSizesSchema.safeParse(entry)
    if (parsed.success) {
      result[tabId] = parsed.data
    } else {
      console.warn('[layout-sizes] dropped invalid sizes of a tab')
    }
  }
  return result
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
    const fits = Math.abs(total - 100) <= SUM_TOLERANCE && saved.every(value => value >= MIN_PANE_PERCENT)
    return fits ? saved : undefined
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
