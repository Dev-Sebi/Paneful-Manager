// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createVuetify } from 'vuetify'
import AhCodeEditor from './AhCodeEditor.vue'

interface FakeModel {
  uri: string | undefined
  value: string
  dispose: ReturnType<typeof vi.fn>
  getValue: () => string
  setValue: ReturnType<typeof vi.fn>
  pushEditOperations: ReturnType<typeof vi.fn>
  pushStackElement: ReturnType<typeof vi.fn>
  getFullModelRange: () => object
}

const state = vi.hoisted(() => ({
  models: new Map<string | undefined, unknown>(),
  created: [] as unknown[],
  editorDispose: vi.fn(),
  setTheme: vi.fn(),
  setModelLanguage: vi.fn(),
  commands: [] as Array<() => void>,
  contentListener: undefined as undefined | (() => void),
  currentModel: undefined as undefined | { value: string },
}))

function makeModel (uri: string | undefined, value: string): FakeModel {
  const model: FakeModel = {
    uri,
    value,
    dispose: vi.fn(() => state.models.delete(uri)),
    getValue: () => model.value,
    setValue: vi.fn((v: string) => {
      model.value = v
    }),
    pushEditOperations: vi.fn((_s: unknown, ops: Array<{ text: string }>) => {
      model.value = ops[0]?.text ?? ''
    }),
    pushStackElement: vi.fn(),
    getFullModelRange: () => ({}),
  }
  state.models.set(uri, model)
  state.created.push(model)
  return model
}

vi.mock('./monacoLoader', () => ({
  FRONTMATTER_LANGUAGE: 'markdown-frontmatter',
  loadMonaco: () => ({
    Uri: { file: (p: string) => p },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
    editor: {
      getModel: (uri: string) => state.models.get(uri) ?? null,
      createModel: (value: string, _lang: string, uri?: string) => makeModel(uri, value),
      setModelLanguage: state.setModelLanguage,
      setTheme: state.setTheme,
      create: (_el: HTMLElement, options: { model: FakeModel }) => {
        let model = options.model
        state.currentModel = model
        return {
          onDidChangeModelContent: (cb: () => void) => {
            state.contentListener = cb
          },
          addCommand: (_key: number, cb: () => void) => {
            state.commands.push(cb)
          },
          getValue: () => model.value,
          getModel: () => model,
          setModel: (next: FakeModel) => {
            model = next
          },
          getSelections: () => null,
          dispose: state.editorDispose,
          focus: vi.fn(),
          getSelection: () => null,
          updateOptions: vi.fn(),
        }
      },
    },
  }),
}))

function mountEditor (props: Record<string, unknown> = {}) {
  const vuetify = createVuetify({ theme: { themes: { light: { dark: false }, dark: { dark: true } }, defaultTheme: 'light' } })
  const wrapper = mount(AhCodeEditor, {
    props: { modelValue: 'text', ariaLabel: 'Editor', ...props },
    global: { plugins: [vuetify], stubs: { VProgressCircular: true } },
  })
  return { wrapper, vuetify }
}

describe('AhCodeEditor', () => {
  it('shows a placeholder, then emits ready', async () => {
    const { wrapper } = mountEditor()
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('disposes editor and own model; mounting twice leaves no models behind', async () => {
    state.editorDispose.mockClear()
    for (let i = 0; i < 2; i++) {
      const { wrapper } = mountEditor({ path: 'a/SKILL.md' })
      await flushPromises()
      expect(state.models.size).toBe(1)
      wrapper.unmount()
      expect(state.models.size).toBe(0)
    }
    expect(state.editorDispose).toHaveBeenCalledTimes(2)
  })

  it('does not dispose a reused model and applies the language to it', async () => {
    const shared = makeModel('shared.md', 'text')
    state.setModelLanguage.mockClear()
    const { wrapper } = mountEditor({ path: 'shared.md' })
    await flushPromises()
    expect(state.setModelLanguage).toHaveBeenCalledWith(shared, 'markdown-frontmatter')
    wrapper.unmount()
    expect(shared.dispose).not.toHaveBeenCalled()
    state.models.clear()
  })

  it('applies external changes as edits, not setValue', async () => {
    const { wrapper } = mountEditor()
    await flushPromises()
    const model = state.currentModel as unknown as FakeModel
    await wrapper.setProps({ modelValue: 'changed' })
    expect(model.pushEditOperations).toHaveBeenCalledTimes(1)
    expect(model.pushStackElement).toHaveBeenCalledTimes(2)
    expect(model.setValue).not.toHaveBeenCalled()
    expect(model.value).toBe('changed')
    wrapper.unmount()
  })

  it('emits update:modelValue only for edits that differ from the prop', async () => {
    const { wrapper } = mountEditor()
    await flushPromises()
    const model = state.currentModel as unknown as FakeModel
    state.contentListener?.()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    model.value = 'typed'
    state.contentListener?.()
    expect(wrapper.emitted('update:modelValue')).toEqual([['typed']])
    wrapper.unmount()
  })

  it('switches the Monaco theme with Vuetify', async () => {
    const { wrapper, vuetify } = mountEditor()
    await flushPromises()
    vuetify.theme.change('dark')
    await flushPromises()
    expect(state.setTheme).toHaveBeenLastCalledWith(expect.stringContaining('dark'))
    wrapper.unmount()
  })

  it('emits save on Ctrl+S', async () => {
    state.commands.length = 0
    const { wrapper } = mountEditor()
    await flushPromises()
    state.commands[0]?.()
    expect(wrapper.emitted('save')).toHaveLength(1)
    wrapper.unmount()
  })
})
