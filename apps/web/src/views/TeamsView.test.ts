// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { makeTask, makeTeam } from '@/components/teams/fixtures'
import { createAppRouter } from '@/router'
import { mountWithVuetify } from '@/test/mount'
import TeamsView from './TeamsView.vue'

const listTeams = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { listTeams } }))
vi.mock('@/api/ws', () => ({ wsClient: { on: vi.fn(() => vi.fn()) } }))

async function mountView () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  const wrapper = mountWithVuetify(TeamsView, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router }
}

describe('TeamsView', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    listTeams.mockReset()
  })

  it('shows the flag explanation with a settings link when disabled', async () => {
    listTeams.mockResolvedValue({ enabled: false, teams: [], warnings: [] })
    const { wrapper, router } = await mountView()
    expect(wrapper.text()).toContain('experimental.agentTeams')
    const push = vi.spyOn(router, 'push')
    await wrapper.find('button').trigger('click')
    expect(push).toHaveBeenCalledWith('/settings')
  })

  it('renders three columns with cards, owner, active form and blocked badge', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [makeTeam('alpha')], warnings: [] })
    const { wrapper } = await mountView()
    const headings = wrapper.findAll('h3').map(item => item.text())
    expect(headings).toEqual(['Pending 1', 'In progress 1', 'Completed 1'])
    expect(wrapper.find('[data-testid="task-2"]').text()).toContain('Writing tests')
    expect(wrapper.find('[data-testid="task-2"]').text()).toContain('tester')
    expect(wrapper.find('[data-testid="task-3"]').text()).toContain('Blocked by #2')
    expect(wrapper.find('[data-testid="task-1"]').text()).not.toContain('Blocked')
    expect(wrapper.text()).toContain('Updated just now')
    expect(wrapper.findAll('[aria-label="Members"] li').map(item => item.text())).toEqual(['lead', 'tester'])
  })

  it('never injects member colors from the file into styles', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [makeTeam('alpha')], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.html()).not.toContain('javascript:')
    expect(wrapper.find('.team-board__dot').attributes('style')).toMatch(/var\(--ah-color-/)
  })

  it('expands and collapses the description', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [makeTeam('alpha')], warnings: [] })
    const { wrapper } = await mountView()
    const toggle = wrapper.find('[data-testid="task-2"] .task-card__toggle')
    const description = wrapper.find('#task-desc-alpha-2')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(description.isVisible()).toBe(false)
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('#task-desc-alpha-2').isVisible()).toBe(true)
  })

  it('lists parse warnings in an alert and shows an empty hint without teams', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [], warnings: ['alpha/1.json: invalid JSON, skipped'] })
    const { wrapper } = await mountView()
    expect(wrapper.find('[role="alert"]').text()).toContain('alpha/1.json: invalid JSON, skipped')
    expect(wrapper.text()).toContain('No team task lists found')
  })

  it('shows a load error as an alert and an error badge', async () => {
    listTeams.mockRejectedValue(new Error('offline'))
    const { wrapper } = await mountView()
    expect(wrapper.find('[role="alert"]').text()).toBe('offline')
    expect(wrapper.find('.ah-status-badge--error').exists()).toBe(true)
  })

  it('has no mutating controls beyond description toggles', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [{ ...makeTeam('alpha'), tasks: [makeTask('1')] }], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.findAll('button, input, textarea, select')).toHaveLength(0)
  })
})
