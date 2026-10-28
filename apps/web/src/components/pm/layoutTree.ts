import type { Layout, LayoutNode, SplitDirection, SplitNode } from '@paneful-manager/shared'

export interface LayoutPaneInfo {
  size?: number
}

function leaf (pane: number, panes: readonly LayoutPaneInfo[]): LayoutNode {
  const size = panes[pane]?.size
  return size === undefined ? { type: 'pane', pane } : { type: 'pane', pane, size }
}

function strip (direction: SplitDirection, panes: readonly LayoutPaneInfo[], indexes: number[]): LayoutNode {
  const children = indexes.map(index => leaf(index, panes))
  return children.length === 1 && children[0] ? children[0] : { type: 'split', direction, children }
}

/** Expands a layout kind into the node tree the renderer walks. */
export function layoutToTree (layout: Layout, panes: readonly LayoutPaneInfo[]): LayoutNode {
  const all = panes.map((_, index) => index)
  switch (layout.kind) {
    case 'single': {
      return leaf(0, panes)
    }
    case 'row':
    case 'column': {
      return strip(layout.kind, panes, all)
    }
    case 'grid-2x2': {
      return {
        type: 'split',
        direction: 'column',
        children: [strip('row', panes, [0, 1]), strip('row', panes, [2, 3])],
      }
    }
    case 'custom': {
      return layout.root
    }
  }
}

/** Default pane sizes in percent; omitted weights take the average of the given ones. */
export function defaultSizes (node: SplitNode): number[] {
  const given = node.children.flatMap(child => (child.size === undefined ? [] : [child.size]))
  const fallback = given.length > 0 ? given.reduce((sum, value) => sum + value, 0) / given.length : 1
  const weights = node.children.map(child => child.size ?? fallback)
  const total = weights.reduce((sum, value) => sum + value, 0)
  return weights.map(weight => (weight / total) * 100)
}
