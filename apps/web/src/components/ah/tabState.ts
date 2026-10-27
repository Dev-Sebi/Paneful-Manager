import type { InjectionKey, Ref } from 'vue'
import { reactive } from 'vue'

/** Values of currently selected tabs; panels live outside the tablist, so they read this page-wide set. */
export const selectedTabs = reactive(new Set<string>())

export const TAB_ID_PREFIX = 'ah-tab-'
export const TABPANEL_ID_PREFIX = 'ah-tabpanel-'

export interface AhTabsContext {
  activeValue: Ref<string | undefined>
  closable: Ref<boolean>
  ready: Ref<boolean>
  /** Registered tabs in mount order, value to disabled flag. */
  registry: Map<string, boolean>
  select: (value: string) => void
  close: (value: string, title: string) => void
  /** Called while the focused tab unmounts so focus moves to a neighbour. */
  removed: (el: HTMLElement) => void
}

export const AH_TABS_KEY: InjectionKey<AhTabsContext> = Symbol('ah-tabs')

const mounted = new Map<string, number>()

/** Registers a tab value page-wide, warns on duplicates in dev and returns the release function. */
export function claimTabValue (value: string): () => void {
  const count = mounted.get(value) ?? 0
  if (import.meta.env.DEV && count > 0) {
    console.warn(`[AhTab] Duplicate tab value "${value}"; values must be unique per page.`)
  }
  mounted.set(value, count + 1)
  return () => {
    const left = (mounted.get(value) ?? 1) - 1
    if (left <= 0) {
      mounted.delete(value)
    } else {
      mounted.set(value, left)
    }
  }
}
