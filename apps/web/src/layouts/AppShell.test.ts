// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { loginRequired } from '@/api/access'
import { connection } from '@/api/connection'
import { wsClient } from '@/api/ws'
import AppShell from '@/layouts/AppShell.vue'
import { createAppRouter } from '@/router'
import { useUiStore } from '@/stores/ui'
import { mountWithVuetify } from '@/test/mount'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  listScopes: vi.fn(),
  listSessions: vi.fn(),
  listPresets: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api: mocks }))
vi.mock('@/api/ws', () => ({
  wsClient: { connect: vi.fn(), close: vi.fn(), on: vi.fn(() => vi.fn()), onFatal: vi.fn(() => vi.fn()), send: vi.fn() },
}))

async function mountAt (path: string, agentTeams = false) {
  mocks.getConfig.mockResolvedValue({
    config: { port: 7337, experimental: { agentTeams }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' },
  })
  mocks.listScopes.mockResolvedValue({ scopes: [] })
  mocks.listSessions.mockResolvedValue({ sessions: [] })
  mocks.listPresets.mockResolvedValue({ presets: [] })
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  const wrapper = mountWithVuetify(AppShell, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('AppShell', () => {
  beforeEach(() => {
    loginRequired.value = false
    vi.clearAllMocks()
    localStorage.clear()
    connection.value = 'connecting'
    document.body.innerHTML = ''
  })

  it('renders sidebar links without Teams when the flag is off', async () => {
    const { wrapper } = await mountAt('/workspaces')
    const links = wrapper.findAll('a.v-list-item').map(link => [link.text(), link.attributes('href')])
    expect(links).toEqual([
      ['Workspaces', '/workspaces'],
      ['Skills', '/skills'],
      ['CLAUDE.md', '/claude-md'],
      ['MCP', '/mcp'],
      ['Settings', '/settings'],
    ])
  })

  it('shows Teams when the flag is on', async () => {
    const { wrapper } = await mountAt('/workspaces', true)
    expect(wrapper.findAll('a.v-list-item').map(link => link.text())).toContain('Teams')
  })

  it('shows the workspaces empty state with the presets panel', async () => {
    const { wrapper } = await mountAt('/workspaces')
    expect(wrapper.text()).toContain('No sessions yet')
    expect(wrapper.text()).toContain('Presets')
    expect(wrapper.text()).toContain('No presets yet')
    expect(wrapper.findAll('button').some(button => button.text() === 'New preset')).toBe(true)
  })

  it('shows empty states for scope sections and the 404 view', async () => {
    const skills = await mountAt('/skills')
    expect(skills.wrapper.text()).toContain('No scopes found to manage skills in')
    skills.wrapper.unmount()

    const missing = await mountAt('/does-not-exist')
    expect(missing.wrapper.text()).toContain('Page not found')
  })

  it('switches sections with Ctrl+number and reserves Alt+Shift+N', async () => {
    const { router } = await mountAt('/workspaces')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/skills'), { timeout: 10_000 })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'N', altKey: true, shiftKey: true }))
    expect(useUiStore().snackbars[0]?.text).toBe('New tab is not available yet')
  })

  it('maps the websocket state to the badge', async () => {
    const { wrapper } = await mountAt('/workspaces')
    const badge = () => wrapper.get('.shell__bar .ah-status-badge')
    expect(badge().text()).toBe('Connecting')
    expect(badge().classes()).toContain('ah-status-badge--working')
    connection.value = 'connected'
    await flushPromises()
    expect(badge().text()).toBe('Connected')
    expect(badge().classes()).toContain('ah-status-badge--idle')
    connection.value = 'disconnected'
    await flushPromises()
    expect(badge().text()).toBe('Disconnected')
    expect(badge().classes()).toContain('ah-status-badge--error')
  })

  it('indexes Ctrl+number over the visible sections', async () => {
    const { router } = await mountAt('/workspaces')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '5', ctrlKey: true }))
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/settings'), { timeout: 10_000 })
  })

  it('ignores Ctrl+number while typing and inside the terminal', async () => {
    const { router, wrapper } = await mountAt('/workspaces')
    const input = document.createElement('input')
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const inner = document.createElement('span')
    xterm.append(inner)
    document.body.append(input, xterm)
    for (const target of [input, inner]) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }))
    }
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/workspaces')
    expect(wrapper.exists()).toBe(true)
  })

  it('renders a skip link that targets the main area', async () => {
    const { wrapper } = await mountAt('/workspaces')
    expect(wrapper.get('a.shell__skip').attributes('href')).toBe('#main-content')
    expect(wrapper.find('main#main-content').exists()).toBe(true)
  })

  it('toggles the rail and keeps it in the store', async () => {
    const { wrapper } = await mountAt('/workspaces')
    await wrapper.get('button[aria-label="Collapse sidebar"]').trigger('click')
    expect(useUiStore().rail).toBe(true)
    expect(wrapper.find('.v-navigation-drawer--rail').exists()).toBe(true)
  })

  it('shows the login hint instead of the view and loads nothing without an access key', async () => {
    loginRequired.value = true
    const { wrapper } = await mountAt('/workspaces')
    expect(wrapper.text()).toContain('Open the login URL once in this browser')
    expect(mocks.listSessions).not.toHaveBeenCalled()
    expect(wsClient.connect).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
