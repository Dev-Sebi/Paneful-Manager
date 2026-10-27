// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createVuetify } from 'vuetify'
import AhCodeEditor from './AhCodeEditor.vue'

const dispose = vi.fn()
const fakeEditor = {
  onDidChangeModelContent: vi.fn(),
  addCommand: vi.fn(),
  getValue: () => '',
  getModel: () => ({ dispose }),
  dispose,
  focus: vi.fn(),
  getSelection: () => null,
  updateOptions: vi.fn(),
}

vi.mock('./monacoLoader', () => ({
  FRONTMATTER_LANGUAGE: 'markdown-frontmatter',
  loadMonaco: () => ({
    Uri: { file: (p: string) => p },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    editor: {
      getModel: () => null,
      createModel: () => ({ getValue: () => 'text', setValue: vi.fn() }),
      create: () => fakeEditor,
      setTheme: vi.fn(),
    },
  }),
}))

describe('AhCodeEditor', () => {
  it('shows a placeholder, then emits ready', async () => {
    const wrapper = mount(AhCodeEditor, {
      props: { modelValue: 'text', ariaLabel: 'Editor' },
      global: { plugins: [createVuetify()], stubs: { VProgressCircular: true } },
    })
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(wrapper.attributes('aria-label')).toBe('Editor')
    wrapper.unmount()
    expect(dispose).toHaveBeenCalled()
  })
})
