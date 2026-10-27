import { describe, expect, it } from 'vitest'
import { defaultSizes, layoutToTree } from './layoutTree'

function sizesOf (tree: ReturnType<typeof layoutToTree>) {
  if (tree.type !== 'split') {
    throw new Error('expected a split')
  }
  return defaultSizes(tree)
}

describe('layoutToTree', () => {
  it('uses pane sizes as weights in a row', () => {
    expect(sizesOf(layoutToTree({ kind: 'row' }, [{ size: 1 }, { size: 3 }]))).toEqual([25, 75])
  })

  it('uses pane sizes as weights in a column', () => {
    expect(sizesOf(layoutToTree({ kind: 'column' }, [{ size: 1 }, { size: 1 }, { size: 2 }]))).toEqual([25, 25, 50])
  })

  it('gives unsized children the average of the given weights', () => {
    const sizes = sizesOf(layoutToTree({ kind: 'row' }, [{ size: 1 }, {}, { size: 3 }]))
    expect(sizes[0]).toBeCloseTo(100 / 6)
    expect(sizes[1]).toBeCloseTo(100 / 3)
    expect(sizes[2]).toBeCloseTo(50)
  })

  it('keeps pane weights inside the rows of grid-2x2', () => {
    const tree = layoutToTree({ kind: 'grid-2x2' }, [{ size: 1 }, { size: 3 }, {}, {}])
    if (tree.type !== 'split') {
      throw new Error('expected a split')
    }
    const [top, bottom] = tree.children
    expect(top?.type === 'split' ? defaultSizes(top) : []).toEqual([25, 75])
    expect(bottom?.type === 'split' ? defaultSizes(bottom) : []).toEqual([50, 50])
  })

  it('returns a custom root leaf as is', () => {
    const root = { type: 'pane', pane: 0 } as const
    expect(layoutToTree({ kind: 'custom', root }, [{}])).toBe(root)
  })
})
