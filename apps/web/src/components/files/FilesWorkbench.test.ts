// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useFilesStore } from '@/stores/files'
import { GLOBAL_SCOPE, makeSkillEntry, withContent } from '@/test/fixtures'
import { mountWithVuetify } from '@/test/mount'
import FilesWorkbench from './FilesWorkbench.vue'

const api = vi.hoisted(() => ({
  listScopes: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  createFile: vi.fn(),
  deleteFile: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api, ApiClientError: class extends Error {} }))

const EditorStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue', 'save'],
  setup: (props, { emit }) => () => h('textarea', {
    value: props.modelValue,
    onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
  }),
})

const first = makeSkillEntry('one')
const second = makeSkillEntry('two')

async function setup () {
  api.listScopes.mockResolvedValue({ scopes: [GLOBAL_SCOPE] })
  api.listFiles.mockResolvedValue({ files: [first, second] })
  api.readFile.mockImplementation((path: string) => Promise.resolve({
    file: withContent(path === first.path ? first : second, `content of ${path}`),
  }))
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/skills', component: { render: () => h(FilesWorkbench, { mode: 'skills' }) } },
      { path: '/other', component: { render: () => h('p', 'other') } },
    ],
  })
  await router.push('/skills')
  const wrapper = mountWithVuetify(defineComponent({ render: () => h(RouterView) }), {
    global: { plugins: [router], stubs: { AhCodeEditor: EditorStub } },
  })
  await flushPromises()
  return { wrapper, router }
}

function tree (wrapper: Awaited<ReturnType<typeof setup>>['wrapper'], label: string) {
  const buttons = wrapper.findAll('.scope-tree__file')
  const index = label === 'one' ? 0 : 1
  return buttons[index]
}

function dialogButton (selector: string) {
  document.querySelector<HTMLElement>(selector)?.click()
  return flushPromises()
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

describe('FilesWorkbench unsaved guard', () => {
  it('switches files freely while clean', async () => {
    const { wrapper } = await setup()
    await tree(wrapper, 'one')?.trigger('click')
    await flushPromises()
    await tree(wrapper, 'two')?.trigger('click')
    await flushPromises()
    expect(useFilesStore().current?.path).toBe(second.path)
  })

  it('asks before switching files and keeps editing on cancel', async () => {
    const { wrapper } = await setup()
    await tree(wrapper, 'one')?.trigger('click')
    await flushPromises()
    await wrapper.find('textarea').setValue('edited')
    await tree(wrapper, 'two')?.trigger('click')
    await flushPromises()
    expect(document.querySelector('.ah-dialog__panel')?.textContent).toContain('Unsaved changes')
    await dialogButton('[data-ah-cancel]')
    expect(useFilesStore().current?.path).toBe(first.path)
    expect(useFilesStore().buffer).toBe('edited')
  })

  it('discards the edits and switches on confirm', async () => {
    const { wrapper } = await setup()
    await tree(wrapper, 'one')?.trigger('click')
    await flushPromises()
    await wrapper.find('textarea').setValue('edited')
    await tree(wrapper, 'two')?.trigger('click')
    await flushPromises()
    await dialogButton('[data-ah-confirm]')
    expect(useFilesStore().current?.path).toBe(second.path)
    expect(useFilesStore().dirty).toBe(false)
  })

  it('blocks route changes while dirty and allows them after discarding', async () => {
    const { wrapper, router } = await setup()
    await tree(wrapper, 'one')?.trigger('click')
    await flushPromises()
    await wrapper.find('textarea').setValue('edited')

    const navigation = router.push('/other')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills')
    await dialogButton('[data-ah-cancel]')
    await navigation
    expect(router.currentRoute.value.path).toBe('/skills')

    const second_ = router.push('/other')
    await flushPromises()
    await dialogButton('[data-ah-confirm]')
    await second_
    expect(router.currentRoute.value.path).toBe('/other')
  })

  it('shows list and open errors in a strip outside the editor', async () => {
    const { wrapper } = await setup()
    useFilesStore().error = 'Could not load files'
    await flushPromises()
    expect(wrapper.find('.workbench__error').text()).toBe('Could not load files')
  })

  it('leaves without a prompt when clean', async () => {
    const { router } = await setup()
    await router.push('/other')
    expect(router.currentRoute.value.path).toBe('/other')
  })
})
