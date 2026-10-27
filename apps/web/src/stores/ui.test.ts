// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { UI_STORAGE_KEY, useUiStore } from './ui'

describe('ui store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('persists rail and theme', async () => {
    const first = useUiStore()
    first.toggleRail()
    first.setTheme('light')
    await nextTick()

    setActivePinia(createPinia())
    const second = useUiStore()
    expect(second.rail).toBe(true)
    expect(second.theme).toBe('light')
  })

  it('ignores an invalid persisted payload', () => {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ rail: 'yes', theme: 'neon' }))
    const store = useUiStore()
    expect(store.rail).toBe(false)
    expect(store.theme).toBeUndefined()
  })

  it('queues and dismisses snackbars', () => {
    const store = useUiStore()
    store.notify('one')
    store.notify('two')
    const [first] = store.snackbars
    store.dismiss(first?.id ?? -1)
    expect(store.snackbars.map(item => item.text)).toEqual(['two'])
  })
})
