// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mountWithVuetify } from '@/test/mount'
import PmStatusBadge from './PmStatusBadge.vue'

const LABELS = {
  working: 'Working',
  waiting: 'Waiting for input',
  error: 'Error',
  idle: 'Idle',
} as const

describe('PmStatusBadge', () => {
  it.each(Object.entries(LABELS))('dot variant for %s has an aria-label', (state, label) => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: state as keyof typeof LABELS, variant: 'dot' } })
    const marker = wrapper.get('[role="img"]')
    expect(marker.attributes('aria-label')).toBe(label)
    expect(wrapper.classes()).toContain(`pm-status-badge--${state}`)
  })

  it('label variant shows text and hides the marker', () => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: 'waiting' } })
    expect(wrapper.text()).toBe('Waiting for input')
    expect(wrapper.get('.pm-status-badge__marker').attributes('aria-hidden')).toBe('true')
  })

  it('uses the label prop as accessible name', () => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: 'idle', variant: 'dot', label: 'api-server idle' } })
    expect(wrapper.get('[role="img"]').attributes('aria-label')).toBe('api-server idle')
  })

  it('pulses once when entering waiting, then emits attention-end', async () => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: 'working' } })
    expect(wrapper.classes()).not.toContain('animate__pulse')
    await wrapper.setProps({ state: 'waiting' })
    expect(wrapper.classes()).toContain('animate__pulse')
    await wrapper.trigger('animationend')
    expect(wrapper.classes()).not.toContain('animate__pulse')
    expect(wrapper.emitted('attention-end')).toHaveLength(1)
  })

  it('does not pulse on mount with an already waiting state', () => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: 'waiting' } })
    expect(wrapper.classes()).not.toContain('animate__pulse')
  })

  it('announces state changes in a polite live region', async () => {
    const wrapper = mountWithVuetify(PmStatusBadge, { props: { state: 'working', announce: true } })
    const live = wrapper.get('[role="status"]')
    expect(live.text()).toBe('')
    await wrapper.setProps({ state: 'error' })
    expect(live.text()).toBe('Error')
  })
})
