// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { defineComponent, h } from 'vue'
import { mountWithVuetify } from '@/test/mount'
import PmButton from './PmButton.vue'
import PmDialog from './PmDialog.vue'
import PmStatusBadge from './PmStatusBadge.vue'
import PmTab from './PmTab.vue'
import PmTabPanel from './PmTabPanel.vue'
import PmTabs from './PmTabs.vue'

enableAutoUnmount(afterEach)

async function violations (container: Element, extraOff: string[] = []) {
  const rules = Object.fromEntries(['region', ...extraOff].map(id => [id, { enabled: false }]))
  const result = await axe(container, { rules })
  return result.violations.map(v => `${v.id}: ${v.nodes.map(n => `${n.html} ${n.failureSummary}`).join(' | ')}`)
}

describe('axe, default state', () => {
  it('PmButton', async () => {
    const wrapper = mountWithVuetify(PmButton, { slots: { default: 'Save' } })
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('PmButton icon-only', async () => {
    const wrapper = mountWithVuetify(PmButton, { props: { icon: 'mdi-plus', ariaLabel: 'Add' } })
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('PmStatusBadge label and dot', async () => {
    const wrapper = mountWithVuetify(defineComponent({
      render: () => h('div', [
        h(PmStatusBadge, { state: 'waiting' }),
        h(PmStatusBadge, { state: 'error', variant: 'dot' }),
      ]),
    }))
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('PmTabs, PmTab and PmTabPanel', async () => {
    const wrapper = mountWithVuetify(defineComponent({
      render: () => h('div', [
        h(PmTabs, { modelValue: 'a', ariaLabel: 'Sessions', closable: true, addable: true }, () => [
          h(PmTab, { value: 'a', title: 'api-server', status: 'working', dirty: true }),
          h(PmTab, { value: 'b', title: 'web' }),
        ]),
        h(PmTabPanel, { value: 'a' }, () => 'Panel a'),
        h(PmTabPanel, { value: 'b' }, () => 'Panel b'),
      ]),
    }))
    expect(await violations(wrapper.element)).toEqual([])
  })

  it('PmDialog', async () => {
    mountWithVuetify(PmDialog, {
      props: { modelValue: true, title: 'Close session', confirmText: 'Close' },
      slots: { default: 'Unsaved work is lost.' },
      global: { stubs: { transition: false } },
    })
    await flushPromises()
    expect(await violations(document.querySelector('[role="dialog"]') as Element)).toEqual([])
  })
})
