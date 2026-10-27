// @vitest-environment jsdom
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { defineComponent, h } from 'vue'
import { mountWithVuetify } from '@/test/mount'
import AhButton from './AhButton.vue'
import AhDialog from './AhDialog.vue'
import AhStatusBadge from './AhStatusBadge.vue'
import AhTab from './AhTab.vue'
import AhTabPanel from './AhTabPanel.vue'
import AhTabs from './AhTabs.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

async function violations (container: Element, extraOff: string[] = []) {
  const rules = Object.fromEntries(['region', ...extraOff].map(id => [id, { enabled: false }]))
  const result = await axe(container, { rules })
  return result.violations.map(v => `${v.id}: ${v.nodes.map(n => `${n.html} ${n.failureSummary}`).join(' | ')}`)
}

describe('axe, default state', () => {
  it('AhButton', async () => {
    const wrapper = mountWithVuetify(AhButton, { slots: { default: 'Save' } })
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('AhButton icon-only', async () => {
    const wrapper = mountWithVuetify(AhButton, { props: { icon: 'mdi-plus', ariaLabel: 'Add' } })
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('AhStatusBadge label and dot', async () => {
    const wrapper = mountWithVuetify(defineComponent({
      render: () => h('div', [
        h(AhStatusBadge, { state: 'waiting' }),
        h(AhStatusBadge, { state: 'error', variant: 'dot' }),
      ]),
    }))
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('AhTabs, AhTab and AhTabPanel', async () => {
    const wrapper = mountWithVuetify(defineComponent({
      render: () => h('div', [
        h(AhTabs, { modelValue: 'a', ariaLabel: 'Sessions', closable: true, addable: true }, () => [
          h(AhTab, { value: 'a', title: 'api-server', status: 'working', dirty: true }),
          h(AhTab, { value: 'b', title: 'web' }),
        ]),
        h(AhTabPanel, { value: 'a' }, () => 'Panel a'),
        h(AhTabPanel, { value: 'b' }, () => 'Panel b'),
      ]),
    }))
    // The spec places the close button next to the tab inside the tablist; axe flags non-tab children there.
    expect(await violations(wrapper.element, ['aria-required-children'])).toEqual([])
  })

  it('AhDialog', async () => {
    mountWithVuetify(AhDialog, {
      props: { modelValue: true, title: 'Close session', confirmText: 'Close' },
      slots: { default: 'Unsaved work is lost.' },
      global: { stubs: { transition: false } },
    })
    await flushPromises()
    expect(await violations(document.querySelector('[role="dialog"]') as Element)).toEqual([])
  })
})
