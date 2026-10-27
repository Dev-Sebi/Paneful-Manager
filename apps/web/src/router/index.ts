import type { RouterHistory } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { useConfigStore } from '@/stores/config'
import { useUiStore } from '@/stores/ui'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    requiresAgentTeams?: boolean
  }
}

export function createAppRouter (history: RouterHistory = createWebHistory()) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: '/workspaces' },
      { path: '/workspaces', name: 'workspaces', component: () => import('@/views/WorkspacesView.vue'), meta: { title: 'Workspaces' } },
      { path: '/workspaces/:tabId', name: 'workspace-tab', component: () => import('@/views/WorkspacesView.vue'), meta: { title: 'Workspaces' } },
      { path: '/skills', name: 'skills', component: () => import('@/views/SkillsView.vue'), meta: { title: 'Skills' } },
      { path: '/claude-md', name: 'claude-md', component: () => import('@/views/ClaudeMdView.vue'), meta: { title: 'CLAUDE.md' } },
      { path: '/mcp', name: 'mcp', component: () => import('@/views/McpView.vue'), meta: { title: 'MCP' } },
      {
        path: '/teams',
        name: 'teams',
        component: () => import('@/views/TeamsView.vue'),
        meta: { title: 'Teams', requiresAgentTeams: true },
      },
      { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: 'Settings' } },
      ...(import.meta.env.DEV
        ? [{ path: '/dev/components', name: 'dev-components', component: () => import('@/views/dev/ComponentsView.vue'), meta: { title: 'Components' } }]
        : []),
      { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue'), meta: { title: 'Not found' } },
    ],
  })

  router.beforeEach(async to => {
    if (!to.meta.requiresAgentTeams) {
      return true
    }
    const config = useConfigStore()
    await config.ensureLoaded()
    if (config.agentTeams) {
      return true
    }
    useUiStore().notify('Agent teams are disabled')
    return { path: '/workspaces' }
  })

  router.afterEach(to => {
    document.title = to.meta.title ? `${to.meta.title} - Agent Hub` : 'Agent Hub'
  })

  return router
}
