import { describe, expect, it } from 'vitest'
import { MEMBER_COLOR_TOKENS, memberColorIndex, memberColorVar, relativeTime } from './teamColor'

describe('memberColorVar', () => {
  it('maps a name to a stable token variable, never to a raw color', () => {
    expect(memberColorVar('tester')).toBe(memberColorVar('tester'))
    expect(memberColorVar('red; background: url(x)')).toMatch(/^var\(--ah-color-[a-z-]+\)$/)
    for (const name of ['a', 'b', 'lead', 'tester', '']) {
      expect(memberColorIndex(name)).toBeLessThan(MEMBER_COLOR_TOKENS.length)
    }
  })

  it('spreads different names over several tokens', () => {
    const used = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(memberColorIndex))
    expect(used.size).toBeGreaterThan(2)
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z')
  it('formats past times', () => {
    expect(relativeTime('2026-01-01T11:59:40.000Z', now)).toBe('just now')
    expect(relativeTime('2026-01-01T11:55:00.000Z', now)).toBe('5 minutes ago')
    expect(relativeTime('2026-01-01T09:00:00.000Z', now)).toBe('3 hours ago')
    expect(relativeTime('2025-12-30T12:00:00.000Z', now)).toBe('2 days ago')
    expect(relativeTime('nope', now)).toBe('unknown')
  })
})
