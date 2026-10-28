// @vitest-environment jsdom
import { TeamTemplateSchema } from '@paneful-manager/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router'
import { useTabsStore } from '@/stores/tabs'
import { useTeamsStore } from '@/stores/teams'
import { mountWithVuetify } from '@/test/mount'
import { makeTeam } from './fixtures'
import TeamTemplatesPanel from './TeamTemplatesPanel.vue'

const api = vi.hoisted(() => ({
  listTeamTemplates: vi.fn(),
  createTeamTemplate: vi.fn(),
  updateTeamTemplate: vi.fn(),
  deleteTeamTemplate: vi.fn(),
  launchTeamTemplate: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api }))

const alpha = TeamTemplateSchema.parse({
  name: 'alpha',
  description: 'Review crew',
  experimental: true,
  lead: { cwd: '/w' },
  teammates: [{ name: 'tester', prompt: 'p' }, { name: 'docs', prompt: 'p' }],
})
const launch = { template: 'alpha', sessionId: 's1', team: 'session-1a2b3c4d', launchedAt: '2026-01-01T00:00:00.000Z' }

async function mountPanel () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  const push = vi.spyOn(router, 'push').mockResolvedValue(undefined)
  const wrapper = mountWithVuetify(TeamTemplatesPanel, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, push }
}

describe('TeamTemplatesPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    localStorage.clear()
    api.listTeamTemplates.mockResolvedValue({ templates: [alpha], launches: [] })
    api.listSessions.mockResolvedValue({ sessions: [] })
  })

  it('lists templates with teammates and description', async () => {
    const { wrapper } = await mountPanel()
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('2 teammates: tester, docs')
    expect(wrapper.text()).toContain('Review crew')
  })

  it('shows an empty hint', async () => {
    api.listTeamTemplates.mockResolvedValue({ templates: [], launches: [] })
    expect((await mountPanel()).wrapper.text()).toContain('No team templates yet')
  })

  it('launches a template into a new tab and opens it', async () => {
    api.launchTeamTemplate.mockResolvedValue({ launch, claudeVersion: '2.1.311', untestedVersion: false })
    const { wrapper, push } = await mountPanel()
    await wrapper.find('[aria-label="Launch alpha"]').trigger('click')
    await flushPromises()
    expect(api.launchTeamTemplate).toHaveBeenCalledWith('alpha')
    expect(useTabsStore().tabs.map(tab => tab.id)).toEqual(['tab-s1'])
    expect(push).toHaveBeenCalledWith('/workspaces/tab-s1')
    expect(wrapper.text()).toContain('Waiting for the team to appear')
  })

  it('links to the board once the team appears', async () => {
    api.listTeamTemplates.mockResolvedValue({ templates: [alpha], launches: [launch] })
    const { wrapper } = await mountPanel()
    expect(wrapper.find('.team-templates__link').exists()).toBe(false)
    useTeamsStore().teams = [makeTeam('session-1a2b3c4d')]
    await flushPromises()
    expect(wrapper.find('.team-templates__link').attributes('href')).toBe('#team-session-1a2b3c4d')
  })

  it('deletes only after confirmation', async () => {
    api.deleteTeamTemplate.mockResolvedValue({ name: 'alpha', deleted: true })
    const { wrapper } = await mountPanel()
    await wrapper.find('[aria-label="Delete alpha"]').trigger('click')
    await flushPromises()
    expect(api.deleteTeamTemplate).not.toHaveBeenCalled()
    document.body.querySelector<HTMLElement>('[data-pm-confirm]')?.click()
    await flushPromises()
    expect(api.deleteTeamTemplate).toHaveBeenCalledWith('alpha')
    expect(wrapper.text()).not.toContain('Review crew')
  })

  it('validates in the dialog before anything is sent', async () => {
    const { wrapper } = await mountPanel()
    await wrapper.findAll('button').find(button => button.text() === 'New template')?.trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-pm-confirm]')?.click()
    await flushPromises()
    expect(api.createTeamTemplate).not.toHaveBeenCalled()
    expect(document.body.querySelector('.team-template-form__issues')?.textContent).toContain('name')
  })
})
