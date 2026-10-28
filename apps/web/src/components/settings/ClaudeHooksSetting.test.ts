// @vitest-environment jsdom
import type { HookStatus } from '@agent-hub/shared'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountWithVuetify } from '@/test/mount'
import ClaudeHooksSetting from './ClaudeHooksSetting.vue'

const status = vi.hoisted(() => vi.fn())
const install = vi.hoisted(() => vi.fn())
const uninstall = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ api: { hooks: { status, install, uninstall } } }))

function hookStatus (overrides: Partial<HookStatus> = {}): HookStatus {
  return {
    settingsPath: '/home/user/.claude/settings.json',
    installed: false,
    portMatches: true,
    installedEvents: [],
    statusAvailable: false,
    reasons: [{ code: 'not_installed', source: '/home/user/.claude/settings.json', message: 'Agent Hub hooks are not installed' }],
    ...overrides,
  }
}

async function mountSetting () {
  const wrapper = mountWithVuetify(ClaudeHooksSetting)
  await flushPromises()
  return wrapper
}

function switchInput (wrapper: Awaited<ReturnType<typeof mountSetting>>) {
  return wrapper.find('input[type="checkbox"]')
}

describe('ClaudeHooksSetting', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    status.mockReset()
    install.mockReset()
    uninstall.mockReset()
  })

  it('shows the installed state and the settings path', async () => {
    status.mockResolvedValue(hookStatus({ installed: true, statusAvailable: true, reasons: [] }))
    const wrapper = await mountSetting()
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('/home/user/.claude/settings.json')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('installs the hooks and shows the new status', async () => {
    status.mockResolvedValue(hookStatus())
    install.mockResolvedValue({ changed: true, status: hookStatus({ installed: true, statusAvailable: true, reasons: [] }) })
    const wrapper = await mountSetting()
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(false)
    await switchInput(wrapper).setValue(true)
    await flushPromises()
    expect(install).toHaveBeenCalledTimes(1)
    expect(uninstall).not.toHaveBeenCalled()
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(true)
  })

  it('uninstalls the hooks', async () => {
    status.mockResolvedValue(hookStatus({ installed: true, reasons: [] }))
    uninstall.mockResolvedValue({ changed: true, status: hookStatus() })
    const wrapper = await mountSetting()
    await switchInput(wrapper).setValue(false)
    await flushPromises()
    expect(uninstall).toHaveBeenCalledTimes(1)
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('keeps the server state and shows the error when a change fails', async () => {
    status.mockResolvedValue(hookStatus())
    install.mockRejectedValue(new Error('settings.json is not valid JSON; fix it before installing hooks'))
    const wrapper = await mountSetting()
    await switchInput(wrapper).setValue(true)
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('Could not install the hooks: settings.json is not valid JSON')
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(false)
  })

  it('lists blocking settings but not the plain not-installed reason', async () => {
    status.mockResolvedValue(hookStatus({
      reasons: [
        { code: 'not_installed', source: '/s.json', message: 'Agent Hub hooks are not installed' },
        { code: 'disable_all_hooks', source: '/etc/claude-code/managed-settings.json', message: 'disableAllHooks is set' },
      ],
    }))
    const wrapper = await mountSetting()
    const problems = wrapper.find('[role="status"]').text()
    expect(problems).toContain('disableAllHooks is set')
    expect(problems).not.toContain('not installed')
  })

  it('shows a load error with a working retry', async () => {
    status.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce(hookStatus({ installed: true, reasons: [] }))
    const wrapper = await mountSetting()
    expect(wrapper.find('[role="alert"]').text()).toContain('Could not read the hook status: Network error')
    expect(switchInput(wrapper).attributes('disabled')).toBeDefined()
    await wrapper.find('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect((switchInput(wrapper).element as HTMLInputElement).checked).toBe(true)
  })
})
