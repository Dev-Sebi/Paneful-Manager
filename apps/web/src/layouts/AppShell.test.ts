// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { connection } from '@/api/connection'
import AppShell from '@/layouts/AppShell.vue'
import { createAppRouter } from '@/router'
import { useUiStore } from '@/stores/ui'
import { mountWithVuetify } from '@/test/mount'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  listScopes: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api: mocks }))
vi.mock('@/api/ws', () => ({
  wsClient: { connect: vi.fn(), close: vi.fn(), on: vi.fn(() => vi.fn()), send: vi.fn() },
}))

async function mountAt (path: string, agentTeams = false) {
  mocks.getConfig.mockResolvedValue({
    config: { port: 7337, experimental: { agentTeams }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' },
  })
  mocks.listScopes.mockResolvedValue({ scopes: [] })
  mocks.listSessions.mockResolvedValue({ sessions: [] })
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
    localStorage.clear()
    connection.value = 'unknown'
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

  it('shows the workspaces empty state with the preset CTA', async () => {
    const { wrapper } = await mountAt('/workspaces')
    expect(wrapper.text()).toContain('No sessions yet')
    const cta = wrapper.findAll('button').find(button => button.text() === 'Open preset')
    expect(cta).toBeDefined()
    await cta?.trigger('click')
    expect(useUiStore().snackbars[0]?.text).toBe('Presets are not available yet')
  })

  it('shows empty states for scope sections and the 404 view', async () => {
    const skills = await mountAt('/skills')
    expect(skills.wrapper.text()).toContain('No scopes found to manage skills in')
    skills.wrapper.unmount()

    const missing = await mountAt('/does-not-exist')
    expect(missing.wrapper.text()).toContain('Page not found')
  })

  it('switches sections with Ctrl+number and reserves Ctrl+Shift+T', async () => {
    const { router } = await mountAt('/workspaces')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true }))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true }))
    expect(useUiStore().snackbars[0]?.text).toBe('New tab is not available yet')
  })

  it('shows the connection badge for each reachability state', async () => {
    const { wrapper } = await mountAt('/workspaces')
    const badge = () => wrapper.get('.shell__bar .ah-status-badge')
    connection.value = 'online'
    await flushPromises()
    expect(badge().text()).toBe('Connected')
    expect(badge().classes()).toContain('ah-status-badge--working')
    connection.value = 'offline'
    await flushPromises()
    expect(badge().text()).toBe('Disconnected')
    expect(badge().classes()).toContain('ah-status-badge--error')
  })

  it('toggles the rail and keeps it in the store', async () => {
    const { wrapper } = await mountAt('/workspaces')
    await wrapper.get('button[aria-label="Collapse sidebar"]').trigger('click')
    expect(useUiStore().rail).toBe(true)
    expect(wrapper.find('.v-navigation-drawer--rail').exists()).toBe(true)
  })
})
