import type { WsEvents } from '@/api/ws'
// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTeam } from '@/components/teams/fixtures'
import { TEAMS_REFRESH_DEBOUNCE_MS, useTeamsStore } from './teams'

const listTeams = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { listTeams } }))

function fakeEvents () {
  let handler: (() => void) | undefined
  const off = vi.fn()
  const events: WsEvents = {
    on: (_type, next) => {
      handler = next as () => void
      return off
    },
  }
  return { events, emit: () => handler?.(), off }
}

describe('teams store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listTeams.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads teams, warnings and the enabled flag', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [makeTeam()], warnings: ['w'] })
    const store = useTeamsStore()
    await store.load()
    expect(store).toMatchObject({ enabled: true, loaded: true, warnings: ['w'], error: undefined })
    expect(store.teams).toHaveLength(1)
  })

  it('keeps the last data and reports an error when a reload fails', async () => {
    listTeams.mockResolvedValueOnce({ enabled: true, teams: [makeTeam()], warnings: [] })
    const store = useTeamsStore()
    await store.load()
    listTeams.mockRejectedValueOnce(new Error('boom'))
    await store.load()
    expect(store.error).toBe('boom')
    expect(store.teams).toHaveLength(1)
  })

  it('reloads once, debounced, after team.changed bursts', async () => {
    listTeams.mockResolvedValue({ enabled: true, teams: [], warnings: [] })
    const store = useTeamsStore()
    const { events, emit, off } = fakeEvents()
    const unbind = store.bind(events)
    emit()
    emit()
    emit()
    expect(listTeams).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TEAMS_REFRESH_DEBOUNCE_MS)
    expect(listTeams).toHaveBeenCalledTimes(1)
    unbind()
    expect(off).toHaveBeenCalled()
  })
})
