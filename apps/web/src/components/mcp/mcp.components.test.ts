// @vitest-environment jsdom
import type * as Client from '@/api/client'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/api/client'
import { makeMcpEntry } from '@/test/fixtures'
import { mountWithVuetify } from '@/test/mount'
import McpRemoveDialog from './McpRemoveDialog.vue'
import McpServerDetail from './McpServerDetail.vue'
import McpServerDialog from './McpServerDialog.vue'

const mcpApi = vi.hoisted(() => ({ list: vi.fn(), upsert: vi.fn(), remove: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({
  ...(await importOriginal<typeof Client>()),
  api: { mcp: mcpApi },
}))

enableAutoUnmount(afterEach)

const stubs = { global: { stubs: { transition: false } } }

function dialogText () {
  return document.querySelector('.ah-dialog__panel')?.textContent ?? ''
}

function field (label: string) {
  const labelEl = Array.from(document.querySelectorAll('label')).find(item => item.textContent === label)
  return document.querySelector<HTMLInputElement>(`#${labelEl?.getAttribute('for')}`)
}

function type (element: HTMLInputElement | null, value: string) {
  if (!element) {
    throw new Error('field not found')
  }
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function button (text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.includes(text))
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const fn of Object.values(mcpApi)) {
    fn.mockReset()
  }
  mcpApi.list.mockResolvedValue({ mode: 'cli', servers: [] })
})

describe('McpServerDetail', () => {
  it('shows keys with masked values and set state, never a secret', () => {
    const entry = makeMcpEntry('a', { config: { transport: 'stdio', command: 'npx', args: [], env: { API_KEY: { masked: true, set: true }, EMPTY: { masked: true, set: false } } } })
    const wrapper = mountWithVuetify(McpServerDetail, { props: { entry } })
    const rows = wrapper.findAll('tbody tr').map(row => row.findAll('td').map(cell => cell.text()))
    expect(rows).toEqual([['API_KEY', '••••value set, hidden', 'set'], ['EMPTY', '••••no value', 'not set']])
  })

  it('emits edit and remove', async () => {
    const wrapper = mountWithVuetify(McpServerDetail, { props: { entry: makeMcpEntry('a') } })
    const buttons = wrapper.findAll('button')
    await buttons.find(item => item.text() === 'Edit')?.trigger('click')
    await buttons.find(item => item.text() === 'Remove')?.trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })
})

describe('McpRemoveDialog', () => {
  it('names the server and scope and warns about OAuth tokens for remote servers', () => {
    const entry = makeMcpEntry('docs', { scope: { kind: 'project', projectPath: '/work/app' }, config: { transport: 'http', url: 'https://x.test', headers: {} } })
    mountWithVuetify(McpRemoveDialog, { props: { modelValue: true, entry }, ...stubs })
    expect(dialogText()).toContain('Remove docs from the project scope (.mcp.json) of /work/app?')
    expect(dialogText()).toContain('OAuth tokens')
  })

  it('omits the OAuth warning for stdio servers', () => {
    mountWithVuetify(McpRemoveDialog, { props: { modelValue: true, entry: makeMcpEntry('a') }, ...stubs })
    expect(dialogText()).not.toContain('OAuth')
  })

  it('removes with name and scope and shows API errors inline', async () => {
    mcpApi.remove.mockRejectedValueOnce(new ApiClientError(409, 'conflict', 'File changed'))
    mountWithVuetify(McpRemoveDialog, { props: { modelValue: true, entry: makeMcpEntry('a') }, ...stubs })
    button('Remove')?.click()
    await flushPromises()
    expect(mcpApi.remove).toHaveBeenCalledWith({ name: 'a', scope: { kind: 'user' } })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('File changed')
  })
})

describe('McpServerDialog', () => {
  it('rejects reserved names inline and does not call the API', async () => {
    mountWithVuetify(McpServerDialog, { props: { modelValue: true }, ...stubs })
    type(field('Name'), 'computer-use')
    await flushPromises()
    expect(dialogText()).toContain('is reserved by Claude Code')
    button('Save')?.click()
    await flushPromises()
    expect(mcpApi.upsert).not.toHaveBeenCalled()
  })

  it('sends keep for an untouched masked row and never prefills it', async () => {
    mcpApi.upsert.mockResolvedValue({ server: makeMcpEntry('a'), created: false })
    const wrapper = mountWithVuetify(McpServerDialog, { props: { modelValue: true, entry: makeMcpEntry('a') }, ...stubs })
    await flushPromises()
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    expect(inputs[0]?.value).toBe('')
    expect(inputs[0]?.placeholder).toBe('unchanged, leave empty to keep')
    button('Save')?.click()
    await flushPromises()
    expect(mcpApi.upsert.mock.calls[0]?.[0]).toMatchObject({ name: 'a', config: { env: { API_KEY: { keep: true }, PATH: '/usr/bin' } } })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('shows the API error inline and keeps the dialog open', async () => {
    mcpApi.upsert.mockRejectedValue(new ApiClientError(409, 'conflict', 'Server a already exists'))
    const wrapper = mountWithVuetify(McpServerDialog, { props: { modelValue: true }, ...stubs })
    type(field('Name'), 'a')
    type(field('Command'), 'npx')
    await flushPromises()
    button('Save')?.click()
    await flushPromises()
    expect(document.querySelector('.mcp-form__error')?.textContent).toBe('Server a already exists')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
