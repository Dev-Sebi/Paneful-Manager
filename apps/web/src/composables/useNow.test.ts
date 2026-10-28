import { afterEach, describe, expect, it, vi } from 'vitest'
// @vitest-environment jsdom
import { effectScope } from 'vue'
import { formatElapsed, useNow } from './useNow'

describe('formatElapsed', () => {
  it.each([
    [-5, '0s'],
    [12_000, '12s'],
    [59_999, '59s'],
    [180_000, '3m'],
    [3_900_000, '1h 5m'],
    [7_200_000, '2h'],
    [90_000_000, '1d 1h'],
    [172_800_000, '2d'],
  ])('formats %d ms as %s', (ms, label) => {
    expect(formatElapsed(ms)).toBe(label)
  })
})

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one interval across users and stops after the last one', () => {
    vi.useFakeTimers()
    const first = effectScope()
    const second = effectScope()
    const a = first.run(() => useNow())
    second.run(() => useNow())
    expect(vi.getTimerCount()).toBe(1)

    const before = a?.value ?? 0
    vi.advanceTimersByTime(2000)
    expect(a?.value).toBeGreaterThanOrEqual(before + 2000)

    first.stop()
    expect(vi.getTimerCount()).toBe(1)
    second.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
