// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { mountWithVuetify } from '@/test/mount'
import PmDialog from './PmDialog.vue'
import source from './PmDialog.vue?raw'

const BODY = '<input id="name" /><button id="extra" type="button">Extra</button>'

function open (props: Record<string, unknown> = {}, body = BODY) {
  return mountWithVuetify(PmDialog, {
    props: { modelValue: true, title: 'Close session', confirmText: 'Close', ...props },
    slots: { default: body },
    global: { stubs: { transition: false } },
  })
}

function panel () {
  return document.querySelector<HTMLElement>('.pm-dialog__panel')
}

function key (target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

enableAutoUnmount(afterEach)

describe('PmDialog layout', () => {
  it('centres the panel inside the full-width Vuetify content box', () => {
    expect(source).toMatch(/\.pm-dialog__content \{[^}]*align-items: center;/)
  })

  it('lets the panel size itself to its max-width instead of the viewport', () => {
    expect(source).toMatch(/\.pm-dialog__panel \{[^}]*width: 100%;/)
  })

  it('applies the content class to the dialog content element', async () => {
    open()
    await flushPromises()
    expect(panel()?.closest('.pm-dialog__content')).not.toBeNull()
  })
})

describe('PmDialog', () => {
  it('does not move focus when mounted closed', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    open({ modelValue: false })
    await flushPromises()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('labels the dialog by its title', async () => {
    open()
    await flushPromises()
    const root = document.querySelector('[role="dialog"]')
    const title = document.querySelector('.pm-dialog__title')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('aria-modal')).toBe('true')
    expect(root?.getAttribute('aria-labelledby')).toBe(title?.id)
  })

  it('uses alertdialog for the danger tone and describes plain text bodies', async () => {
    open({ tone: 'danger' }, 'Unsaved work is lost.')
    await flushPromises()
    const root = document.querySelector('[role="alertdialog"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('aria-describedby')).toBe(document.querySelector('.pm-dialog__body')?.id)
  })

  it('focuses the first body control initially', async () => {
    open()
    await flushPromises()
    expect(document.activeElement?.id).toBe('name')
  })

  it('focuses cancel in the danger tone without body controls', async () => {
    open({ tone: 'danger' }, 'Plain text')
    await flushPromises()
    expect(document.activeElement?.hasAttribute('data-pm-cancel')).toBe(true)
  })

  it('honours initialFocus', async () => {
    open({ initialFocus: '#extra' })
    await flushPromises()
    expect(document.activeElement?.id).toBe('extra')
  })

  it('traps Tab and Shift+Tab inside the panel', async () => {
    open()
    await flushPromises()
    const items = Array.from(panel()?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
    const first = items[0]
    const last = items.at(-1)
    expect(first).toBeDefined()
    last?.focus()
    key(last as Element, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    key(first as Element, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    expect(last?.classList.contains('pm-dialog__close')).toBe(true)
  })

  it('cancels on Escape', async () => {
    const wrapper = open()
    await flushPromises()
    key(document.activeElement as Element, { key: 'Escape' })
    expect(wrapper.emitted('cancel')?.[0]).toEqual(['escape'])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('blocks Escape when persistent and shows the helper text', async () => {
    const wrapper = open({ persistent: true })
    await flushPromises()
    expect(document.querySelector('.pm-dialog__close')).toBeNull()
    key(document.activeElement as Element, { key: 'Escape' })
    await flushPromises()
    expect(wrapper.emitted('close-blocked')).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    const status = document.querySelector('.pm-dialog__blocked')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toBe('Finish or cancel the running action first')
    expect(panel()?.classList.contains('animate__headShake')).toBe(true)
  })

  it('blocks closing while loading', async () => {
    const wrapper = open({ loading: true })
    await flushPromises()
    key(document.activeElement as Element, { key: 'Escape' })
    expect(wrapper.emitted('close-blocked')).toHaveLength(1)
    expect(document.querySelector('.pm-dialog__body')?.getAttribute('aria-busy')).toBe('true')
  })

  it('confirms with Ctrl+Enter except in the danger tone', async () => {
    const wrapper = open()
    await flushPromises()
    key(document.activeElement as Element, { key: 'Enter', ctrlKey: true })
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    const danger = open({ tone: 'danger' })
    await flushPromises()
    key(document.activeElement as Element, { key: 'Enter', ctrlKey: true })
    expect(danger.emitted('confirm')).toBeUndefined()
  })

  it('returns focus to the opener after closing', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = open({ modelValue: false })
    await wrapper.setProps({ modelValue: true })
    await flushPromises()
    expect(document.activeElement?.id).toBe('name')
    await wrapper.setProps({ modelValue: false })
    await flushPromises()
    expect(document.activeElement).toBe(opener)
  })
})
