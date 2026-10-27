import type { Theme } from '@agent-hub/shared'
import { ThemeSchema, z } from '@agent-hub/shared'
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { readStorage, writeStorage } from './storage'

export const UI_STORAGE_KEY = 'agent-hub.ui.v1'

const PersistedUiSchema = z.strictObject({
  rail: z.boolean().default(false),
  theme: ThemeSchema.optional(),
})

export interface SnackbarMessage {
  id: number
  text: string
  color?: 'error' | 'info' | 'success' | 'warning'
  /** Stays until dismissed instead of timing out. */
  persistent?: boolean
}

/** Persisted UI preferences, read before the app mounts so the first paint uses the saved theme. */
export function loadUiPrefs (): z.infer<typeof PersistedUiSchema> {
  const parsed = PersistedUiSchema.safeParse(readStorage(UI_STORAGE_KEY))
  return parsed.success ? parsed.data : { rail: false }
}

export const useUiStore = defineStore('ui', () => {
  const saved = loadUiPrefs()
  const rail = ref(saved.rail)
  const theme = ref<Theme | undefined>(saved.theme)
  const snackbars = ref<SnackbarMessage[]>([])
  let nextId = 1

  function toggleRail () {
    rail.value = !rail.value
  }

  function setTheme (value: Theme) {
    theme.value = value
  }

  function notify (text: string, color?: SnackbarMessage['color'], persistent = false) {
    snackbars.value.push({ id: nextId++, text, color, persistent })
  }

  function dismiss (id: number) {
    snackbars.value = snackbars.value.filter(item => item.id !== id)
  }

  watch([rail, theme], () => writeStorage(UI_STORAGE_KEY, { rail: rail.value, theme: theme.value }))

  return { rail, theme, snackbars, toggleRail, setTheme, notify, dismiss }
})
