// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router'
import { useConfigStore } from '@/stores/config'
import { useUiStore } from '@/stores/ui'

const getConfig = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { getConfig } }))

function configWith (agentTeams: boolean) {
  return { config: { port: 7337, experimental: { agentTeams }, confirmCloseTab: true, projects: [], logLevel: 'info', theme: 'dark' } }
}

describe('router', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    getConfig.mockReset()
  })

  it('redirects / to /workspaces', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/')
    expect(router.currentRoute.value.fullPath).toBe('/workspaces')
  })

  it('redirects /teams to /workspaces with a snackbar when the flag is off', async () => {
    getConfig.mockResolvedValue(configWith(false))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/teams')
    expect(router.currentRoute.value.path).toBe('/workspaces')
    expect(useUiStore().snackbars[0]?.text).toBe('Agent teams are disabled')
  })

  it('redirects /teams when the config cannot be loaded', async () => {
    getConfig.mockRejectedValue(new Error('offline'))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/teams')
    expect(router.currentRoute.value.path).toBe('/workspaces')
    expect(useConfigStore().error).toBe('offline')
  })

  it('allows /teams when the flag is on', async () => {
    getConfig.mockResolvedValue(configWith(true))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/teams')
    expect(router.currentRoute.value.path).toBe('/teams')
    expect(useUiStore().snackbars).toHaveLength(0)
  })

  it('loads the config once for repeated guarded navigations', async () => {
    getConfig.mockResolvedValue(configWith(true))
    const router = createAppRouter(createMemoryHistory())
    await router.push('/teams')
    await router.push('/skills')
    await router.push('/teams')
    expect(getConfig).toHaveBeenCalledTimes(1)
  })

  it('resolves unknown paths to the not-found route', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/nope/deeper')
    expect(router.currentRoute.value.name).toBe('not-found')
  })

  it('registers the dev gallery route in dev builds', () => {
    expect(createAppRouter(createMemoryHistory()).hasRoute('dev-components')).toBe(import.meta.env.DEV)
  })
})
