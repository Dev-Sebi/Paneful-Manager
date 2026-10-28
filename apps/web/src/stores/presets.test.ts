// @vitest-environment jsdom
import { WorkspacePresetSchema } from '@paneful-manager/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresetsStore } from './presets'

const api = vi.hoisted(() => ({
  listPresets: vi.fn(),
  createPreset: vi.fn(),
  updatePreset: vi.fn(),
  deletePreset: vi.fn(),
  launchPreset: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api }))

const alpha = WorkspacePresetSchema.parse({ name: 'alpha', tabs: [{ panes: [{ cwd: '/a' }] }] })
const beta = WorkspacePresetSchema.parse({ name: 'beta', tabs: [{ panes: [{ cwd: '/b' }] }] })

describe('presets store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    api.listSessions.mockResolvedValue({ sessions: [] })
  })

  it('loads presets and records a load error', async () => {
    api.listPresets.mockResolvedValueOnce({ presets: [alpha] })
    const store = usePresetsStore()
    await store.load()
    expect(store.presets).toEqual([alpha])
    api.listPresets.mockRejectedValueOnce(new Error('down'))
    await store.load()
    expect(store.error).toBe('down')
  })

  it('creates sorted and replaces on update', async () => {
    api.createPreset.mockImplementation(async ({ preset }) => ({ preset }))
    api.updatePreset.mockImplementation(async (_name, { preset }) => ({ preset }))
    const store = usePresetsStore()
    await store.save(beta, false)
    await store.save(alpha, false)
    expect(store.presets.map(item => item.name)).toEqual(['alpha', 'beta'])
    await store.save({ ...alpha, description: 'd' }, true)
    expect(api.updatePreset).toHaveBeenCalledWith('alpha', { preset: { ...alpha, description: 'd' } })
    expect(store.presets[0]?.description).toBe('d')
  })

  it('removes a preset after the server confirmed', async () => {
    api.listPresets.mockResolvedValue({ presets: [alpha, beta] })
    api.deletePreset.mockResolvedValue({ name: 'alpha', deleted: true })
    const store = usePresetsStore()
    await store.load()
    await store.remove('alpha')
    expect(store.presets.map(item => item.name)).toEqual(['beta'])
  })

  it('keeps the list when a delete fails', async () => {
    api.listPresets.mockResolvedValue({ presets: [alpha] })
    api.deletePreset.mockRejectedValue(new Error('nope'))
    const store = usePresetsStore()
    await store.load()
    await expect(store.remove('alpha')).rejects.toThrow('nope')
    expect(store.presets).toHaveLength(1)
  })

  it('turns a launch into tabs with ids and refreshes the sessions', async () => {
    api.launchPreset.mockResolvedValue({
      name: 'alpha',
      tabs: [{ title: 'one', layout: { kind: 'single' }, panes: [{ sessionId: 's1' }] }],
    })
    const tabs = await usePresetsStore().launch('alpha')
    expect(tabs).toEqual([{ id: 'tab-s1', title: 'one', layout: { kind: 'single' }, panes: [{ sessionId: 's1' }] }])
    expect(api.listSessions).toHaveBeenCalled()
  })
})
