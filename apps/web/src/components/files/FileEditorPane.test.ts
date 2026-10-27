// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useFilesStore } from '@/stores/files'
import { HASH_A, HASH_B, HASH_C, makeSkillEntry, withContent, WORKTREE_SCOPE } from '@/test/fixtures'
import { mountWithVuetify } from '@/test/mount'
import FileEditorPane from './FileEditorPane.vue'

const api = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock('@/api/client', () => {
  class ApiClientError extends Error {
    status: number
    code: string
    details: unknown
    constructor (status: number, code: string, message: string, details?: unknown) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  return { api, ApiClientError }
})

const { ApiClientError } = await import('@/api/client')

const EditorStub = defineComponent({
  props: { modelValue: { type: String, default: '' }, ariaLabel: { type: String, default: '' } },
  emits: ['update:modelValue', 'save'],
  setup: (props, { emit }) => () => h('textarea', {
    'aria-label': props.ariaLabel,
    'value': props.modelValue,
    'onInput': (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    'onKeydown': (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === 's') {
        emit('save')
      }
    },
  }),
})

const entry = makeSkillEntry('demo', WORKTREE_SCOPE)
const GOOD = '---\nname: demo\ndescription: Does things\n---\nBody'

async function mountPane (content = GOOD) {
  api.readFile.mockResolvedValue({ file: withContent(entry, content) })
  api.listFiles.mockResolvedValue({ files: [entry] })
  const files = useFilesStore()
  await files.open(entry.path)
  const wrapper = mountWithVuetify(FileEditorPane, {
    props: { emptyIcon: 'mdi-file', emptyMessage: 'Nothing open' },
    global: { stubs: { AhCodeEditor: EditorStub } },
  })
  return { wrapper, files }
}

async function edit (wrapper: Awaited<ReturnType<typeof mountPane>>['wrapper'], value: string) {
  const area = wrapper.find('textarea')
  await area.setValue(value)
}

function button (wrapper: Awaited<ReturnType<typeof mountPane>>['wrapper'], label: string) {
  const found = wrapper.findAll('button').find(item => item.text() === label)
  if (!found) {
    throw new Error(`no button ${label}`)
  }
  return found
}

beforeEach(() => {
  setActivePinia(createPinia())
  for (const fn of Object.values(api)) {
    fn.mockReset()
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FileEditorPane', () => {
  it('shows the empty state without an open file', () => {
    const wrapper = mountWithVuetify(FileEditorPane, {
      props: { emptyIcon: 'mdi-file', emptyMessage: 'Nothing open' },
      global: { stubs: { AhCodeEditor: EditorStub } },
    })
    expect(wrapper.text()).toContain('Nothing open')
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('renders header, scope chip, branch and a disabled Save while clean', async () => {
    const { wrapper } = await mountPane()
    expect(wrapper.find('.file-pane__path').text()).toBe(entry.relPath)
    expect(wrapper.text()).toContain('feat-x')
    expect(wrapper.text()).toContain('feat/x')
    expect(wrapper.find('.file-pane__dot').exists()).toBe(false)
    expect(button(wrapper, 'Save').attributes('disabled')).toBeDefined()
  })

  it('shows the dirty dot and saves with the expected hash', async () => {
    const { wrapper, files } = await mountPane()
    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    await edit(wrapper, `${GOOD} more`)
    expect(wrapper.find('.file-pane__dot').exists()).toBe(true)
    await button(wrapper, 'Save').trigger('click')
    await flushPromises()
    expect(api.writeFile).toHaveBeenCalledWith({ path: entry.path, content: `${GOOD} more`, expectedHash: HASH_A })
    expect(files.dirty).toBe(false)
    expect(wrapper.find('.file-pane__dot').exists()).toBe(false)
  })

  it('saves from the editor save event', async () => {
    const { wrapper } = await mountPane()
    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    await edit(wrapper, 'changed')
    await wrapper.find('textarea').trigger('keydown', { key: 's', ctrlKey: true })
    await flushPromises()
    expect(api.writeFile).toHaveBeenCalledTimes(1)
  })

  it('does not save a clean file', async () => {
    const { wrapper } = await mountPane()
    await wrapper.find('textarea').trigger('keydown', { key: 's', ctrlKey: true })
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('previews frontmatter and hints at missing fields', async () => {
    const { wrapper } = await mountPane()
    expect(wrapper.find('.file-pane__fields').text()).toContain('Does things')
    expect(wrapper.find('.file-pane__hints').exists()).toBe(false)
    await edit(wrapper, '---\nname: other\n---\nBody')
    const hints = wrapper.find('.file-pane__hints').text()
    expect(hints).toContain('Missing "description"')
    expect(hints).toContain('differs from the folder name')
    await edit(wrapper, 'no frontmatter')
    expect(wrapper.find('.file-pane__hints').text()).toContain('No frontmatter block')
  })

  it('shows the conflict banner and overwrites only after confirmation', async () => {
    const { wrapper } = await mountPane()
    await edit(wrapper, 'mine')
    api.writeFile.mockRejectedValueOnce(new ApiClientError(409, 'conflict', 'changed', { currentHash: HASH_C }))
    await button(wrapper, 'Save').trigger('click')
    await flushPromises()
    expect(wrapper.find('.conflict-banner').exists()).toBe(true)
    expect(wrapper.find('textarea').element.value).toBe('mine')

    api.writeFile.mockResolvedValue({ file: { ...entry, hash: HASH_B } })
    await button(wrapper, 'Overwrite').trigger('click')
    await flushPromises()
    expect(api.writeFile).toHaveBeenCalledTimes(1)
    document.querySelector<HTMLElement>('[data-ah-confirm]')?.click()
    await flushPromises()
    expect(api.writeFile).toHaveBeenLastCalledWith({ path: entry.path, content: 'mine', expectedHash: HASH_C })
    expect(wrapper.find('.conflict-banner').exists()).toBe(false)
  })

  it('reloads from disk on request', async () => {
    const { wrapper, files } = await mountPane()
    await edit(wrapper, 'mine')
    files.diskChange = { removed: false, hash: HASH_C }
    await flushPromises()
    api.readFile.mockResolvedValue({ file: { ...withContent(entry, 'disk'), hash: HASH_C } })
    await button(wrapper, 'Reload from disk').trigger('click')
    await flushPromises()
    expect(wrapper.find('textarea').element.value).toBe('disk')
    expect(wrapper.find('.conflict-banner').exists()).toBe(false)
  })

  it('disables Delete and the banner actions while saving', async () => {
    const { wrapper, files } = await mountPane()
    await edit(wrapper, 'mine')
    files.diskChange = { removed: false, hash: HASH_C }
    files.saving = true
    await flushPromises()
    expect(button(wrapper, 'Delete').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'Reload from disk').attributes('disabled')).toBeDefined()
    expect(button(wrapper, 'Overwrite').attributes('disabled')).toBeDefined()
  })

  it('labels the section with the file path and shows only file-level errors', async () => {
    const { wrapper, files } = await mountPane()
    const section = wrapper.find('section.file-pane')
    expect(wrapper.find(`#${section.attributes('aria-labelledby')}`).text()).toBe(entry.relPath)
    files.error = 'list failed'
    files.fileError = 'save failed'
    await flushPromises()
    expect(wrapper.find('.file-pane__error').text()).toBe('save failed')
  })

  it('emits delete', async () => {
    const { wrapper } = await mountPane()
    await button(wrapper, 'Delete').trigger('click')
    expect(wrapper.emitted('delete')).toHaveLength(1)
  })
})
