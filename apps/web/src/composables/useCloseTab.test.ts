// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as client from '@/api/client'
import { useConfigStore } from '@/stores/config'
import { useSessionsStore } from '@/stores/sessions'
import { useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { makeSession, makeTab } from '@/test/fixtures'
import { useCloseTab } from './useCloseTab'

const { killSession, patchConfig } = vi.hoisted(() => ({ killSession: vi.fn(), patchConfig: vi.fn() }))

vi.mock('@/api/client', async importOriginal => ({
  ...await importOriginal<typeof client>(),
  api: { killSession, patchConfig },
}))

function setup (confirmCloseTab = true) {
  setActivePinia(createPinia())
  const tabs = useTabsStore()
  const sessions = useSessionsStore()
  const config = useConfigStore()
  config.config = { port: 7337, experimental: { agentTeams: false }, confirmCloseTab, projects: [], logLevel: 'info', theme: 'dark' }
  tabs.add(makeTab('a'))
  sessions.upsert(makeSession('s-a'))
  patchConfig.mockImplementation(async (patch: object) => ({ config: { ...config.config, ...patch }, restartRequired: false }))
  killSession.mockImplementation(async (id: string) => ({ id, killed: true }))
  return { tabs, sessions, config, ui: useUiStore(), flow: useCloseTab() }
}

describe('useCloseTab', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('closes a tab without live sessions immediately', async () => {
    const { tabs, sessions, flow } = setup()
    sessions.remove('s-a')
    await flow.closeTab('a')
    expect(tabs.tabs).toEqual([])
    expect(killSession).not.toHaveBeenCalled()
  })

  it('asks first, then kills the sessions and removes the tab', async () => {
    const { tabs, flow } = setup()
    await flow.closeTab('a')
    expect(flow.pendingTabId.value).toBe('a')
    expect(flow.pendingSessions.value.map(session => session.title)).toEqual(['session s-a'])
    expect(tabs.tabs).toHaveLength(1)
    await flow.confirm()
    expect(killSession).toHaveBeenCalledWith('s-a')
    expect(tabs.tabs).toEqual([])
    expect(flow.pendingTabId.value).toBeUndefined()
    expect(patchConfig).not.toHaveBeenCalled()
  })

  it('does nothing on cancel', async () => {
    const { tabs, flow } = setup()
    await flow.closeTab('a')
    flow.cancel()
    expect(flow.pendingTabId.value).toBeUndefined()
    expect(tabs.tabs).toHaveLength(1)
    expect(killSession).not.toHaveBeenCalled()
  })

  it('persists dont-ask-again and skips the dialog afterwards', async () => {
    const { tabs, sessions, config, flow } = setup()
    await flow.closeTab('a')
    flow.dontAskAgain.value = true
    await flow.confirm()
    expect(patchConfig).toHaveBeenCalledWith({ confirmCloseTab: false })
    expect(config.confirmCloseTab).toBe(false)

    tabs.add(makeTab('b'))
    sessions.upsert(makeSession('s-b'))
    await flow.closeTab('b')
    expect(flow.pendingTabId.value).toBeUndefined()
    expect(killSession).toHaveBeenLastCalledWith('s-b')
    expect(tabs.tabs).toEqual([])
  })

  it('kills without asking when confirmation is off', async () => {
    const { tabs, flow } = setup(false)
    await flow.closeTab('a')
    expect(killSession).toHaveBeenCalledOnce()
    expect(tabs.tabs).toEqual([])
  })

  it('keeps the tab and shows one snackbar when a kill fails', async () => {
    const { tabs, sessions, ui, flow } = setup()
    tabs.tabs[0]?.panes.push({ sessionId: 's-x' })
    sessions.upsert(makeSession('s-x'))
    killSession.mockImplementation(async (id: string) => {
      if (id === 's-x') {
        throw new client.ApiClientError(500, 'internal', 'boom')
      }
      return { id, killed: true }
    })
    await flow.closeTab('a')
    await flow.confirm()
    expect(tabs.tabs).toHaveLength(1)
    expect(ui.snackbars).toHaveLength(1)
    expect(ui.snackbars[0]?.text).toContain('boom')
    expect(sessions.byId.has('s-a')).toBe(false)
  })
})
