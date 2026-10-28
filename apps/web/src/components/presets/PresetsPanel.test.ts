// @vitest-environment jsdom
import { WorkspacePresetSchema } from '@paneful-manager/shared'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router'
import { useTabsStore } from '@/stores/tabs'
import { mountWithVuetify } from '@/test/mount'
import PresetsPanel from './PresetsPanel.vue'

const api = vi.hoisted(() => ({
  listPresets: vi.fn(),
  createPreset: vi.fn(),
  updatePreset: vi.fn(),
  deletePreset: vi.fn(),
  launchPreset: vi.fn(),
  listSessions: vi.fn(),
}))
vi.mock('@/api/client', () => ({ api }))

const alpha = WorkspacePresetSchema.parse({ name: 'alpha', description: 'Demo', autostart: true, tabs: [{ panes: [{ cwd: '/a' }] }] })

async function mountPanel () {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory())
  const wrapper = mountWithVuetify(PresetsPanel, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

describe('PresetsPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    for (const fn of Object.values(api)) {
      fn.mockReset()
    }
    localStorage.clear()
    api.listPresets.mockResolvedValue({ presets: [alpha] })
    api.listSessions.mockResolvedValue({ sessions: [] })
  })

  it('lists presets with description and autostart badge', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('Demo')
    expect(wrapper.text()).toContain('Autostart')
  })

  it('shows an empty hint', async () => {
    api.listPresets.mockResolvedValue({ presets: [] })
    expect((await mountPanel()).text()).toContain('No presets yet')
  })

  it('launches a preset into the tabs store', async () => {
    api.launchPreset.mockResolvedValue({
      name: 'alpha',
      tabs: [{ title: 'alpha', layout: { kind: 'single' }, panes: [{ sessionId: 's1' }] }],
    })
    const wrapper = await mountPanel()
    await wrapper.find('[aria-label="Launch alpha"]').trigger('click')
    await flushPromises()
    expect(api.launchPreset).toHaveBeenCalledWith('alpha')
    expect(useTabsStore().tabs.map(tab => tab.id)).toEqual(['tab-s1'])
    expect(wrapper.emitted('launched')).toHaveLength(1)
  })

  it('deletes only after confirmation', async () => {
    api.deletePreset.mockResolvedValue({ name: 'alpha', deleted: true })
    const wrapper = await mountPanel()
    await wrapper.find('[aria-label="Delete alpha"]').trigger('click')
    await flushPromises()
    expect(api.deletePreset).not.toHaveBeenCalled()
    const confirm = document.body.querySelector<HTMLElement>('[data-pm-confirm]')
    confirm?.click()
    await flushPromises()
    expect(api.deletePreset).toHaveBeenCalledWith('alpha')
    expect(wrapper.text()).not.toContain('Demo')
  })

  it('validates in the dialog before anything is sent', async () => {
    const wrapper = await mountPanel()
    const create = wrapper.findAll('button').find(button => button.text() === 'New preset')
    await create?.trigger('click')
    await flushPromises()
    document.body.querySelector<HTMLElement>('[data-pm-confirm]')?.click()
    await flushPromises()
    expect(api.createPreset).not.toHaveBeenCalled()
    expect(document.body.querySelector('.preset-form__issues')?.textContent).toContain('name')
  })
})
