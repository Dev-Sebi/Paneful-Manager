// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { makeTab } from '@/test/fixtures'
import { TABS_STORAGE_KEY, useTabsStore } from './tabs'

function freshStore () {
  setActivePinia(createPinia())
  return useTabsStore()
}

describe('tabs store', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips tabs and the active tab through localStorage', async () => {
    const first = freshStore()
    first.add(makeTab('a'))
    first.add(makeTab('b'))
    first.activate('a')
    await nextTick()

    const second = freshStore()
    expect(second.tabs.map(tab => tab.id)).toEqual(['a', 'b'])
    expect(second.activeId).toBe('a')
  })

  it('upserts a tab in place and activates it', () => {
    const store = freshStore()
    store.add(makeTab('a'))
    store.add(makeTab('b'))
    store.upsert({ ...makeTab('a'), title: 'Renamed' })
    expect(store.tabs.map(tab => [tab.id, tab.title])).toEqual([['a', 'Renamed'], ['b', makeTab('b').title]])
    expect(store.activeId).toBe('a')
    store.upsert(makeTab('c'))
    expect(store.tabs.map(tab => tab.id)).toEqual(['a', 'b', 'c'])
    expect(store.activeId).toBe('c')
  })

  it.each([
    ['not json', '{oops'],
    ['wrong shape', JSON.stringify({ tabs: 'x', activeId: null })],
    ['invalid tab', JSON.stringify({ tabs: [{ id: 'a', title: 't', layout: { kind: 'single' }, panes: [] }], activeId: 'a' })],
    ['extra key', JSON.stringify({ tabs: [], activeId: null, extra: 1 })],
  ])('drops a bad payload (%s)', (_name, payload) => {
    localStorage.setItem(TABS_STORAGE_KEY, payload)
    const store = freshStore()
    expect(store.tabs).toEqual([])
    expect(store.activeId).toBeNull()
  })

  it('drops only the invalid tabs of a persisted list', () => {
    const invalid = { id: 'x', title: 't', layout: { kind: 'single' }, panes: [] }
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs: [makeTab('a'), invalid, makeTab('b')], activeId: 'x' }))
    const store = freshStore()
    expect(store.tabs.map(tab => tab.id)).toEqual(['a', 'b'])
    expect(store.activeId).toBe('a')
  })

    it('falls back to the first tab when the persisted active id is unknown', () => {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify({ tabs: [makeTab('a')], activeId: 'gone' }))
    expect(freshStore().activeId).toBe('a')
  })

  it('activates a neighbour when the active tab closes', () => {
    const store = freshStore()
    store.add(makeTab('a'))
    store.add(makeTab('b'))
    store.add(makeTab('c'))
    store.activate('b')
    store.close('b')
    expect(store.activeId).toBe('c')
    store.close('c')
    expect(store.activeId).toBe('a')
    store.close('a')
    expect(store.activeId).toBeNull()
  })

  it('reorders tabs and ignores unknown ids', () => {
    const store = freshStore()
    store.add(makeTab('a'))
    store.add(makeTab('b'))
    store.move(0, 1)
    expect(store.tabs.map(tab => tab.id)).toEqual(['b', 'a'])
    store.activate('missing')
    expect(store.activeId).toBe('b')
  })
})
