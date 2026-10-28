import { describe, expect, it } from 'vitest'
import { StaleHookSessions } from './stale.js'

describe('StaleHookSessions', () => {
  it('keeps only live sessions, clears on demand and prunes ended ones', () => {
    const live = new Set(['a', 'b'])
    const stale = new StaleHookSessions(id => live.has(id))
    stale.mark(['a', 'b', 'gone'])
    expect(stale.list()).toEqual(['a', 'b'])
    stale.clear('a')
    expect(stale.list()).toEqual(['b'])
    live.delete('b')
    expect(stale.list()).toEqual([])
    live.add('b')
    expect(stale.list()).toEqual([])
  })
})
