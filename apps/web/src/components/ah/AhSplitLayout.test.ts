// @vitest-environment jsdom
import type { Layout } from '@agent-hub/shared'
import { enableAutoUnmount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { LAYOUT_SIZES_STORAGE_KEY, useLayoutSizesStore } from '@/stores/layoutSizes'
import { mountWithVuetify } from '@/test/mount'
import AhSplitLayout from './AhSplitLayout.vue'

enableAutoUnmount(afterEach)

function panes (count: number) {
  return Array.from({ length: count }, () => ({}))
}

function mountLayout (layout: Layout, count: number, tabId = 'tab-1') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mountWithVuetify(AhSplitLayout, {
    props: { layout, panes: panes(count), tabId },
    slots: { pane: ({ index }: { index: number }) => h('div', { 'data-pane': index }, `Pane ${index}`) },
    global: { plugins: [pinia] },
  })
  return wrapper
}

function paneIndexes (wrapper: ReturnType<typeof mountLayout>) {
  return wrapper.findAll('[data-pane]').map(el => el.attributes('data-pane'))
}

beforeEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})

describe('AhSplitLayout rendering', () => {
  it('renders a single pane without splitters', async () => {
    const wrapper = mountLayout({ kind: 'single' }, 1)
    await flushPromises()
    expect(paneIndexes(wrapper)).toEqual(['0'])
    expect(wrapper.findAll('.splitpanes__splitter')).toHaveLength(0)
  })

  it('renders a row as one vertical split', async () => {
    const wrapper = mountLayout({ kind: 'row' }, 3)
    await flushPromises()
    expect(paneIndexes(wrapper)).toEqual(['0', '1', '2'])
    expect(wrapper.findAll('.splitpanes--vertical')).toHaveLength(1)
    expect(wrapper.findAll('.splitpanes__splitter')).toHaveLength(2)
  })

  it('renders a column as one horizontal split', async () => {
    const wrapper = mountLayout({ kind: 'column' }, 2)
    await flushPromises()
    expect(wrapper.findAll('.splitpanes--horizontal')).toHaveLength(1)
    expect(wrapper.findAll('.splitpanes__splitter')).toHaveLength(1)
  })

  it('renders grid-2x2 as two rows in a column', async () => {
    const wrapper = mountLayout({ kind: 'grid-2x2' }, 4)
    await flushPromises()
    expect(paneIndexes(wrapper)).toEqual(['0', '1', '2', '3'])
    expect(wrapper.findAll('.splitpanes--horizontal')).toHaveLength(1)
    expect(wrapper.findAll('.splitpanes--vertical')).toHaveLength(2)
  })

  it('renders a custom tree recursively', async () => {
    const wrapper = mountLayout({
      kind: 'custom',
      root: {
        type: 'split',
        direction: 'row',
        children: [
          { type: 'pane', pane: 0, size: 2 },
          { type: 'split', direction: 'column', size: 1, children: [{ type: 'pane', pane: 1 }, { type: 'pane', pane: 2 }] },
        ],
      },
    }, 3)
    await flushPromises()
    expect(paneIndexes(wrapper)).toEqual(['0', '1', '2'])
    expect(wrapper.findAll('.splitpanes--vertical')).toHaveLength(1)
    expect(wrapper.findAll('.splitpanes--horizontal')).toHaveLength(1)
    const outer = wrapper.get('.splitpanes--vertical').findAll(':scope > .splitpanes__pane')
    expect(outer[0]?.attributes('style')).toContain('66.6')
  })

  it('labels the splitters', async () => {
    const wrapper = mountLayout({ kind: 'row' }, 3)
    await flushPromises()
    const labels = wrapper.findAll('.splitpanes__splitter').map(el => el.attributes('aria-label'))
    expect(labels).toEqual(['Resize panes 1 and 2', 'Resize panes 2 and 3'])
    expect(wrapper.get('.splitpanes__splitter').attributes('role')).toBe('separator')
  })
})

describe('AhSplitLayout sizes', () => {
  it('restores persisted sizes on mount', async () => {
    localStorage.setItem(LAYOUT_SIZES_STORAGE_KEY, JSON.stringify({ 'tab-1': { 0: [30, 70] } }))
    const wrapper = mountLayout({ kind: 'row' }, 2)
    await flushPromises()
    const [first, second] = wrapper.findAll('.splitpanes__pane')
    expect(first?.attributes('style')).toContain('30%')
    expect(second?.attributes('style')).toContain('70%')
  })

  it('ignores persisted sizes that do not fit the pane count', async () => {
    localStorage.setItem(LAYOUT_SIZES_STORAGE_KEY, JSON.stringify({ 'tab-1': { 0: [30, 70] } }))
    const wrapper = mountLayout({ kind: 'row' }, 3)
    await flushPromises()
    expect(wrapper.findAll('.splitpanes__pane')[0]?.attributes('style')).toContain('33.3')
  })

  it('persists a keyboard resize and restores it', async () => {
    vi.useFakeTimers()
    const wrapper = mountLayout({ kind: 'row' }, 2)
    await flushPromises()
    await wrapper.get('.splitpanes__splitter').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    const stored = JSON.parse(localStorage.getItem(LAYOUT_SIZES_STORAGE_KEY) ?? '{}') as Record<string, Record<string, number[]>>
    expect(stored['tab-1']?.['0']).toEqual([55, 45])
    expect(wrapper.findAll('.splitpanes__pane')[0]?.attributes('style')).toContain('55%')

    vi.advanceTimersByTime(500)
    expect(wrapper.emitted('resized')).toHaveLength(1)

    wrapper.unmount()
    vi.useRealTimers()
    const again = mountLayout({ kind: 'row' }, 2)
    await flushPromises()
    expect(again.findAll('.splitpanes__pane')[0]?.attributes('style')).toContain('55%')
  })

  it('shrinks with the opposite arrow key', async () => {
    const wrapper = mountLayout({ kind: 'column' }, 2)
    await flushPromises()
    await wrapper.get('.splitpanes__splitter').trigger('keydown', { key: 'ArrowUp' })
    await flushPromises()
    expect(wrapper.findAll('.splitpanes__pane')[0]?.attributes('style')).toContain('45%')
  })

  it('resets to the defaults', async () => {
    localStorage.setItem(LAYOUT_SIZES_STORAGE_KEY, JSON.stringify({ 'tab-1': { 0: [30, 70] }, 'tab-2': { 0: [20, 80] } }))
    const wrapper = mountLayout({ kind: 'row' }, 2)
    await flushPromises()
    ;(wrapper.vm as unknown as { resetSizes: () => void }).resetSizes()
    await flushPromises()
    expect(wrapper.findAll('.splitpanes__pane')[0]?.attributes('style')).toContain('50%')
    const store = useLayoutSizesStore()
    expect(store.sizes['tab-1']).toBeUndefined()
    expect(store.sizes['tab-2']).toBeDefined()
    expect(JSON.parse(localStorage.getItem(LAYOUT_SIZES_STORAGE_KEY) ?? '{}')).not.toHaveProperty('tab-1')
  })
})
