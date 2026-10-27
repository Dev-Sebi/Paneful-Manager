import type { Session } from '@agent-hub/shared'
import { computed, ref } from 'vue'
import { api, ApiClientError } from '@/api/client'
import { useConfigStore } from '@/stores/config'
import { useSessionsStore } from '@/stores/sessions'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'

/**
 * Close flow for app tabs: asks first (unless disabled), kills the tab's sessions, then removes the tab.
 * Closing the browser or unfocusing a tab must never reach this code: sessions live in tmux.
 */
export function useCloseTab () {
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const config = useConfigStore()
  const ui = useUiStore()

  const pendingTabId = ref<string>()
  const dontAskAgain = ref(false)
  const busy = ref(false)

  const pendingSessions = computed(() => (pendingTabId.value ? liveSessions(pendingTabId.value) : []))

  function liveSessions (tabId: string): Session[] {
    const tab = tabs.tabs.find(item => item.id === tabId)
    const found = (tab?.panes ?? []).flatMap(pane => sessions.byId.get(pane.sessionId) ?? [])
    return found.filter(session => session.lifecycle !== 'exited')
  }

  async function kill (session: Session): Promise<string | undefined> {
    try {
      await api.killSession(session.id)
    } catch (error) {
      if (!(error instanceof ApiClientError && error.status === 404)) {
        return `${session.title}: ${error instanceof Error ? error.message : 'Could not be killed'}`
      }
    }
    sessions.remove(session.id)
    return undefined
  }

  async function closeNow (tabId: string, live: Session[]) {
    const failures = (await Promise.all(live.map(session => kill(session)))).filter(message => message !== undefined)
    if (failures.length > 0) {
      ui.notify(`Could not kill ${failures.length} session(s): ${failures.join('; ')}`, 'error')
      return false
    }
    tabs.close(tabId)
    return true
  }

  async function rememberChoice () {
    try {
      await config.patch({ confirmCloseTab: false })
    } catch (error) {
      ui.notify(error instanceof Error ? error.message : 'Could not save the setting', 'error')
    }
  }

  /** Entry point for tab close buttons and the keyboard shortcut. */
  async function closeTab (tabId: string) {
    const live = liveSessions(tabId)
    if (live.length === 0) {
      tabs.close(tabId)
    } else if (config.confirmCloseTab) {
      dontAskAgain.value = false
      pendingTabId.value = tabId
    } else {
      await closeNow(tabId, live)
    }
  }

  async function confirm () {
    const tabId = pendingTabId.value
    if (tabId === undefined || busy.value) {
      return
    }
    busy.value = true
    try {
      await closeNow(tabId, liveSessions(tabId))
      if (dontAskAgain.value) {
        await rememberChoice()
      }
    } finally {
      busy.value = false
      pendingTabId.value = undefined
    }
  }

  function cancel () {
    if (!busy.value) {
      pendingTabId.value = undefined
    }
  }

  return { closeTab, confirm, cancel, pendingTabId, pendingSessions, dontAskAgain, busy }
}
