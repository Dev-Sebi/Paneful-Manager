// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { LAYOUT_SIZES_STORAGE_KEY, useLayoutSizesStore } from './layoutSizes'

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('layout sizes store', () => {
  it('round-trips sizes through localStorage', async () => {
    const store = useLayoutSizesStore()
    store.set('a', '0', [40, 60])
    await nextTick()
    setActivePinia(createPinia())
    expect(useLayoutSizesStore().get('a', '0', 2)).toEqual([40, 60])
  })

  it('rejects sizes that do not match count or total', () => {
    const store = useLayoutSizesStore()
    store.set('a', '0', [40, 60])
    store.set('a', '1', [10, 10])
    expect(store.get('a', '0', 3)).toBeUndefined()
    expect(store.get('a', '1', 2)).toBeUndefined()
    expect(store.get('b', '0', 2)).toBeUndefined()
  })

  it('drops an invalid persisted payload', () => {
    localStorage.setItem(LAYOUT_SIZES_STORAGE_KEY, JSON.stringify({ a: { 0: [-1, 101] } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setActivePinia(createPinia())
    expect(useLayoutSizesStore().sizes).toEqual({})
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('resets and prunes tabs', () => {
    const store = useLayoutSizesStore()
    store.set('a', '0', [50, 50])
    store.set('b', '0', [50, 50])
    store.set('c', '0', [50, 50])
    store.reset('a')
    store.prune(['b'])
    expect(Object.keys(store.sizes)).toEqual(['b'])
  })
})
