import { afterEach, describe, expect, it } from 'vitest'
// @vitest-environment jsdom
import { defineComponent, ref } from 'vue'
import { enableAutoUnmount } from '@vue/test-utils'
import { mountWithVuetify } from '@/test/mount'
import AhTab from './AhTab.vue'
import AhTabPanel from './AhTabPanel.vue'
import AhTabs from './AhTabs.vue'

const Harness = defineComponent({
  components: { AhTab, AhTabPanel, AhTabs },
  props: { closable: Boolean, reorderable: Boolean },
  emits: ['close', 'reorder'],
  setup (_, { emit }) {
    const active = ref('a')
    const tabs = ref(['a', 'b', 'c'])
    function close (value: string) {
      emit('close', value)
      tabs.value = tabs.value.filter(v => v !== value)
    }
    return { active, tabs, close, emit }
  },
  template: `
    <AhTabs v-model="active" aria-label="Sessions" :closable="closable" :reorderable="reorderable" @close="close" @reorder="emit('reorder', $event)">
      <AhTab v-for="v in tabs" :key="v" :value="v" :title="'Tab ' + v" :disabled="v === 'x'" />
    </AhTabs>
    <AhTabPanel v-for="v in tabs" :key="v" :value="v">Panel {{ v }}</AhTabPanel>
  `,
})

enableAutoUnmount(afterEach)

function tab (wrapper: ReturnType<typeof mountWithVuetify>, value: string) {
  return wrapper.get(`#ah-tab-${value}`)
}

describe('AhTabs', () => {
  it('wires the ARIA structure', () => {
    const wrapper = mountWithVuetify(Harness)
    const list = wrapper.get('ul[role="tablist"]')
    expect(list.attributes('aria-label')).toBe('Sessions')
    expect(list.attributes('aria-orientation')).toBe('horizontal')
    expect(list.findAll(':scope > li[role="none"]')).toHaveLength(3)
    const a = tab(wrapper, 'a')
    expect(a.element.parentElement?.tagName).toBe('LI')
    expect(a.attributes('aria-controls')).toBe('ah-tabpanel-a')
    expect(a.attributes('aria-selected')).toBe('true')
    expect(tab(wrapper, 'b').attributes('aria-selected')).toBe('false')
    const panel = wrapper.get('#ah-tabpanel-a')
    expect(panel.attributes('role')).toBe('tabpanel')
    expect(panel.attributes('aria-labelledby')).toBe('ah-tab-a')
    expect(panel.attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#ah-tabpanel-b').attributes('hidden')).toBeDefined()
  })

  it('uses roving tabindex', () => {
    const wrapper = mountWithVuetify(Harness)
    expect(tab(wrapper, 'a').attributes('tabindex')).toBe('0')
    expect(tab(wrapper, 'b').attributes('tabindex')).toBe('-1')
    expect(tab(wrapper, 'c').attributes('tabindex')).toBe('-1')
  })

  it('moves and activates with arrows (wrapping), Home and End', async () => {
    const wrapper = mountWithVuetify(Harness)
    await tab(wrapper, 'a').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.id).toBe('ah-tab-b')
    expect(tab(wrapper, 'b').attributes('aria-selected')).toBe('true')
    await tab(wrapper, 'b').trigger('keydown', { key: 'End' })
    expect(document.activeElement?.id).toBe('ah-tab-c')
    await tab(wrapper, 'c').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.id).toBe('ah-tab-a')
    await tab(wrapper, 'a').trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement?.id).toBe('ah-tab-c')
    await tab(wrapper, 'c').trigger('keydown', { key: 'Home' })
    expect(document.activeElement?.id).toBe('ah-tab-a')
  })

  it('closes with Delete and Backspace and focuses the next tab', async () => {
    const wrapper = mountWithVuetify(Harness, { props: { closable: true } })
    document.querySelector<HTMLElement>('#ah-tab-a')?.focus()
    await tab(wrapper, 'a').trigger('keydown', { key: 'Delete' })
    expect(wrapper.emitted('close')?.[0]).toEqual(['a'])
    expect(document.activeElement?.id).toBe('ah-tab-b')
    await tab(wrapper, 'b').trigger('keydown', { key: 'Backspace' })
    expect(document.activeElement?.id).toBe('ah-tab-c')
  })

  it('does not close when tabs are not closable', async () => {
    const wrapper = mountWithVuetify(Harness)
    await tab(wrapper, 'a').trigger('keydown', { key: 'Delete' })
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('renders the close button as a sibling outside the tab with tabindex -1', () => {
    const wrapper = mountWithVuetify(Harness, { props: { closable: true } })
    const close = wrapper.get('li button.ah-tab__close')
    expect(close.attributes('tabindex')).toBe('-1')
    expect(close.attributes('aria-hidden')).toBe('true')
    expect(tab(wrapper, 'a').attributes('aria-keyshortcuts')).toBe('Delete')
    expect(tab(wrapper, 'a').find('button').exists()).toBe(false)
  })

  it('emits reorder on Ctrl+Shift+Arrow only when reorderable', async () => {
    const plain = mountWithVuetify(Harness)
    await tab(plain, 'b').trigger('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    expect(plain.emitted('reorder')).toBeUndefined()
    const wrapper = mountWithVuetify(Harness, { props: { reorderable: true } })
    await tab(wrapper, 'b').trigger('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    expect(wrapper.emitted('reorder')?.[0]).toEqual([{ value: 'b', from: 1, to: 2 }])
  })

  it('shows the matching panel on click', async () => {
    const wrapper = mountWithVuetify(Harness)
    await tab(wrapper, 'c').trigger('click')
    expect(wrapper.get('#ah-tabpanel-c').attributes('hidden')).toBeUndefined()
    expect(wrapper.get('#ah-tabpanel-a').attributes('hidden')).toBeDefined()
  })
})
