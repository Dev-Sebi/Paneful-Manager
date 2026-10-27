import { describe, expect, it } from 'vitest'
import { AppTabSchema, LayoutSchema, validateLayoutPanes } from './layout.js'
import { issuePaths } from './test-utils.js'

const panes = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}` }))

const customRoot = {
  type: 'split',
  direction: 'row',
  children: [
    { type: 'pane', pane: 0, size: 2 },
    {
      type: 'split',
      direction: 'column',
      size: 1,
      children: [
        { type: 'pane', pane: 1 },
        { type: 'pane', pane: 2 },
      ],
    },
  ],
}

describe('LayoutSchema', () => {
  it('accepts every layout kind', () => {
    for (const kind of ['single', 'row', 'column', 'grid-2x2']) {
      expect(LayoutSchema.parse({ kind })).toEqual({ kind })
    }
    expect(LayoutSchema.parse({ kind: 'custom', root: customRoot })).toEqual({ kind: 'custom', root: customRoot })
  })

  it('rejects an unknown kind', () => {
    expect(issuePaths(LayoutSchema, { kind: 'grid-3x3' })).toEqual(['kind'])
  })

  it('reports nested errors in custom trees with their path', () => {
    const root = { type: 'split', direction: 'row', children: [{ type: 'pane', pane: 0 }, { type: 'pane', pane: -1 }] }
    expect(issuePaths(LayoutSchema, { kind: 'custom', root })).toEqual(['root.children.1.pane'])
  })

  it('rejects splits with fewer than 2 children and non-positive sizes', () => {
    const lonely = { type: 'split', direction: 'row', children: [{ type: 'pane', pane: 0 }] }
    expect(issuePaths(LayoutSchema, { kind: 'custom', root: lonely })).toEqual(['root.children'])
    const zero = { type: 'pane', pane: 0, size: 0 }
    expect(issuePaths(LayoutSchema, { kind: 'custom', root: zero })).toEqual(['root.size'])
  })
})

describe('validateLayoutPanes', () => {
  it('checks pane counts per kind', () => {
    expect(validateLayoutPanes({ kind: 'single' }, 1)).toEqual([])
    expect(validateLayoutPanes({ kind: 'single' }, 2)).toHaveLength(1)
    expect(validateLayoutPanes({ kind: 'grid-2x2' }, 4)).toEqual([])
    expect(validateLayoutPanes({ kind: 'grid-2x2' }, 3)).toHaveLength(1)
    expect(validateLayoutPanes({ kind: 'row' }, 6)).toEqual([])
  })

  it('requires custom trees to reference every pane exactly once', () => {
    const layout = LayoutSchema.parse({ kind: 'custom', root: customRoot })
    expect(validateLayoutPanes(layout, 3)).toEqual([])
    expect(validateLayoutPanes(layout, 4)).toHaveLength(1)
    const duplicate = LayoutSchema.parse({
      kind: 'custom',
      root: { type: 'split', direction: 'row', children: [{ type: 'pane', pane: 0 }, { type: 'pane', pane: 0 }] },
    })
    expect(validateLayoutPanes(duplicate, 2)[0]?.path).toEqual(['layout', 'root'])
  })
})

describe('AppTabSchema', () => {
  it('accepts 1 to 6 panes', () => {
    expect(AppTabSchema.parse({ id: 't1', title: 'Tab', layout: { kind: 'row' }, panes: panes(6) }).panes).toHaveLength(6)
  })

  it('rejects 0 and 7 panes', () => {
    expect(issuePaths(AppTabSchema, { id: 't1', title: 'Tab', layout: { kind: 'row' }, panes: [] })).toEqual(['panes'])
    expect(issuePaths(AppTabSchema, { id: 't1', title: 'Tab', layout: { kind: 'row' }, panes: panes(7) })).toEqual([
      'panes',
    ])
  })

  it('rejects a layout that does not fit the panes', () => {
    expect(issuePaths(AppTabSchema, { id: 't1', title: 'Tab', layout: { kind: 'grid-2x2' }, panes: panes(2) })).toEqual([
      'panes',
    ])
  })

  it('rejects unknown keys', () => {
    expect(issuePaths(AppTabSchema, { id: 't1', title: 'Tab', layout: { kind: 'single' }, panes: panes(1), x: 1 })).toEqual(
      [''],
    )
  })

  it('round-trips through JSON', () => {
    const tab = AppTabSchema.parse({ id: 't1', title: 'Tab', layout: { kind: 'custom', root: customRoot }, panes: panes(3) })
    expect(AppTabSchema.parse(JSON.parse(JSON.stringify(tab)))).toEqual(tab)
  })
})
