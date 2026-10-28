// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountWithVuetify } from '@/test/mount'
import PmButton from './PmButton.vue'

enableAutoUnmount(afterEach)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PmButton', () => {
  it('emits click and renders a native button', async () => {
    const wrapper = mountWithVuetify(PmButton, { slots: { default: 'Save' } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
    expect(wrapper.get('button').attributes('type')).toBe('button')
  })

  it('ignores clicks while loading, keeps focus and sets aria-busy', async () => {
    const wrapper = mountWithVuetify(PmButton, { props: { loading: true }, slots: { default: 'Save' } })
    const button = wrapper.get('button')
    button.element.focus()
    await button.trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.pm-spinner').exists()).toBe(true)
    expect(document.activeElement).toBe(button.element)
  })

  it('does not emit click while disabled', async () => {
    const wrapper = mountWithVuetify(PmButton, { props: { disabled: true }, slots: { default: 'Save' } })
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('exposes pressed and shortcut state', () => {
    const wrapper = mountWithVuetify(PmButton, { props: { pressed: true, shortcut: 'Alt+Shift+N' }, slots: { default: 'New' } })
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('button').attributes('aria-keyshortcuts')).toBe('Alt+Shift+N')
  })

  it('omits aria-pressed when pressed is undefined', () => {
    const wrapper = mountWithVuetify(PmButton, { slots: { default: 'Save' } })
    expect(wrapper.get('button').attributes('aria-pressed')).toBeUndefined()
  })

  it('warns when an icon-only button has no ariaLabel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mountWithVuetify(PmButton, { props: { icon: 'mdi-plus' } })
    await flushPromises()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ariaLabel'))
  })

  it('does not warn when the icon-only button is labelled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mountWithVuetify(PmButton, { props: { icon: 'mdi-plus', ariaLabel: 'Add' } })
    await flushPromises()
    expect(warn).not.toHaveBeenCalled()
    expect(wrapper.get('button').attributes('aria-label')).toBe('Add')
  })
})
