import type { Session } from '@agent-hub/shared'
import { computed, ref } from 'vue'
import { api, ApiClientError } from '@/api/client'
import { useConfigStore } from '@/stores/config'
import { useSessionsStore } from '@/stores/sessions'
import { isTeamTab, useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'

/**
 * Close flow for app tabs: asks first (unless disabled), kills all of the tab's sessions (exited ones too), then removes the tab.
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

  /** Sessions the tab owns: team tabs own none, other tabs only those no other tab shows. */
  function tabSessions (tabId: string): Session[] {
    const tab = tabs.tabs.find(item => item.id === tabId)
    if (!tab || isTeamTab(tabId)) {
      return []
    }
    const elsewhere = new Set(tabs.tabs.filter(item => item.id !== tabId).flatMap(item => item.panes.map(pane => pane.sessionId)))
    return tab.panes.flatMap(pane => (pane.sessionId === undefined || elsewhere.has(pane.sessionId) ? [] : sessions.byId.get(pane.sessionId) ?? []))
  }

  function liveSessions (tabId: string): Session[] {
    return tabSessions(tabId).filter(session => session.lifecycle !== 'exited')
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

  async function closeNow (tabId: string) {
    const failures = (await Promise.all(tabSessions(tabId).map(session => kill(session)))).filter(message => message !== undefined)
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
    if (liveSessions(tabId).length === 0) {
      await closeNow(tabId)
    } else if (config.confirmCloseTab) {
      dontAskAgain.value = false
      pendingTabId.value = tabId
    } else {
      await closeNow(tabId)
    }
  }

  async function confirm () {
    const tabId = pendingTabId.value
    if (tabId === undefined || busy.value) {
      return
    }
    busy.value = true
    try {
      await closeNow(tabId)
      // The choice is persisted even when a kill failed: the user already declined the prompt.
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
