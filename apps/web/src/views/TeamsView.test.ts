// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { connection } from '@/api/connection'
import { makeTask, makeTeam } from '@/components/teams/fixtures'
import { createAppRouter } from '@/router'
import { useSessionsStore } from '@/stores/sessions'
import { useTabsStore } from '@/stores/tabs'
import { makeSession } from '@/test/fixtures'
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
    connection.value = 'connected'
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

  it('opens a team as a tab with one pane per member and switches to it', async () => {
    const team = makeTeam('alpha')
    team.members = [
      { name: 'lead', agentType: 'team-lead', link: { status: 'linked', sessionId: 's1', via: 'pane' } },
      { name: 'tester', link: { status: 'unlinked', reason: 'no-pane' } },
    ]
    listTeams.mockResolvedValue({ enabled: true, teams: [team], warnings: [] })
    const { wrapper, router } = await mountView()
    useSessionsStore().upsert(makeSession('s1'))
    const push = vi.spyOn(router, 'push')
    const button = wrapper.findAll('button').find(item => item.text() === 'Open as tab')
    await button?.trigger('click')
    const tabs = useTabsStore()
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0]).toMatchObject({ id: 'team-alpha', layout: { kind: 'row' }, panes: [{ sessionId: 's1' }, { placeholder: { title: 'tester (Teammate)' } }] })
    expect(push).toHaveBeenCalledWith('/workspaces/team-alpha')
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

  it('shows only open blockers and an Unknown column for unrecognized statuses', async () => {
    const team = makeTeam('alpha')
    team.tasks = [
      makeTask('1', { status: 'completed' }),
      makeTask('2', { status: 'in_progress' }),
      makeTask('3', { blockedBy: ['1', '2'], blocked: true }),
      makeTask('4', { status: 'unknown' }),
    ]
    listTeams.mockResolvedValue({ enabled: true, teams: [team], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.find('[data-testid="task-3"]').text()).toContain('Blocked by #2')
    expect(wrapper.find('[data-testid="task-3"]').text()).not.toContain('#1,')
    expect(wrapper.findAll('h3').map(item => item.text())).toEqual(['Pending 1', 'In progress 1', 'Completed 1', 'Unknown 1'])
  })

  it('shows never for a team without files and reflects the WebSocket state in the badge', async () => {
    connection.value = 'disconnected'
    listTeams.mockResolvedValue({ enabled: true, teams: [{ ...makeTeam('alpha'), lastUpdated: null }], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('Updated never')
    expect(wrapper.text()).toContain('Reconnecting')
  })

  it('sanitizes ids used for aria references', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [makeTeam('my team.1')], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.find('section[aria-labelledby]').attributes('aria-labelledby')).toBe('team-my_team_1')
  })

  it('has no controls that change team data; only Open as tab', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [{ ...makeTeam('alpha'), tasks: [makeTask('1')] }], warnings: [] })
    const { wrapper } = await mountView()
    expect(wrapper.findAll('button, input, textarea, select').map(item => item.text())).toEqual(['Open as tab'])
  })
})
