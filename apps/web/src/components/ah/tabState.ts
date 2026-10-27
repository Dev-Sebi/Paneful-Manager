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
}

export const AH_TABS_KEY: InjectionKey<AhTabsContext> = Symbol('ah-tabs')
