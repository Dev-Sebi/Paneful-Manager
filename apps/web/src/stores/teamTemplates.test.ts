// @vitest-environment jsdom
import { TeamTemplateSchema } from '@paneful-manager/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTeamTemplatesStore } from './teamTemplates'

const api = vi.hoisted(() => ({
  listTeamTemplates: vi.fn(),
  createTeamTemplate: vi.fn(),
  updateTeamTemplate: vi.fn(),
  deleteTeamTemplate: vi.fn(),
  launchTeamTemplate: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api }))

function template (name: string) {
  return TeamTemplateSchema.parse({ name, experimental: true, lead: { cwd: '/w' }, teammates: [{ name: 'tester', prompt: 'p' }] })
}

const launch = { template: 'alpha', sessionId: 's1', team: 'session-1a2b3c4d', launchedAt: '2026-01-01T00:00:00.000Z' }

describe('team templates store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    api.listSessions.mockResolvedValue({ sessions: [] })
  })

  it('loads templates and launches and records a load error', async () => {
    api.listTeamTemplates.mockResolvedValueOnce({ templates: [template('alpha')], launches: [launch] })
    const store = useTeamTemplatesStore()
    await store.load()
    expect(store.templates.map(item => item.name)).toEqual(['alpha'])
    expect(store.launchesOf('alpha')).toEqual([launch])
    api.listTeamTemplates.mockRejectedValueOnce(new Error('Not found'))
    await store.load()
    expect(store.error).toBe('Not found')
  })

  it('creates sorted, replaces on update and removes with its launches', async () => {
    api.createTeamTemplate.mockImplementation(async ({ template: value }) => ({ template: value }))
    api.updateTeamTemplate.mockImplementation(async (_name, { template: value }) => ({ template: value }))
    api.deleteTeamTemplate.mockResolvedValue({ name: 'alpha', deleted: true })
    const store = useTeamTemplatesStore()
    await store.save(template('beta'), false)
    await store.save(template('alpha'), false)
    expect(store.templates.map(item => item.name)).toEqual(['alpha', 'beta'])
    await store.save({ ...template('alpha'), description: 'd' }, true)
    expect(api.updateTeamTemplate).toHaveBeenCalledWith('alpha', { template: { ...template('alpha'), description: 'd' } })
    store.launches = [launch]
    await store.remove('alpha')
    expect(store.templates.map(item => item.name)).toEqual(['beta'])
    expect(store.launches).toEqual([])
  })

  it('turns a launch into a single-pane tab and refreshes the sessions', async () => {
    api.launchTeamTemplate.mockResolvedValue({ launch, claudeVersion: '2.1.311', untestedVersion: false })
    const store = useTeamTemplatesStore()
    const launched = await store.launch('alpha')
    expect(launched.tab).toEqual({ id: 'tab-s1', title: 'alpha', layout: { kind: 'single' }, panes: [{ sessionId: 's1' }] })
    expect(store.launchesOf('alpha')).toEqual([launch])
    expect(api.listSessions).toHaveBeenCalled()
  })
})
