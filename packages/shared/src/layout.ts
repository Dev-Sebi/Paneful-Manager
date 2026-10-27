import { z } from 'zod'
import { MAX_PANES_PER_TAB } from './defaults.js'

export const LayoutKindSchema = z.enum(['single', 'row', 'column', 'grid-2x2', 'custom'])
export type LayoutKind = z.infer<typeof LayoutKindSchema>

export const SplitDirectionSchema = z.enum(['row', 'column'])
export type SplitDirection = z.infer<typeof SplitDirectionSchema>

/** Relative weight of a pane or split along its parent axis; omitted means equal share. */
export const PaneSizeSchema = z.number().positive()

/** Leaf of a custom layout tree, pointing at `panes[pane]` of the tab. */
export interface PaneLeafNode {
  type: 'pane'
  pane: number
  size?: number
}

export interface SplitNode {
  type: 'split'
  direction: SplitDirection
  size?: number
  children: LayoutNode[]
}

export type LayoutNode = PaneLeafNode | SplitNode

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [PaneLeafNodeSchema, SplitNodeSchema]),
)

export const PaneLeafNodeSchema = z.looseObject({
  type: z.literal('pane'),
  pane: z.int().min(0),
  size: PaneSizeSchema.optional(),
})

export const SplitNodeSchema = z.looseObject({
  type: z.literal('split'),
  direction: SplitDirectionSchema,
  size: PaneSizeSchema.optional(),
  children: z.array(LayoutNodeSchema).min(2, 'a split needs at least 2 children'),
})

/** Arrangement of a tab's panes; only `custom` carries a tree. */
export const LayoutSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('single') }),
  z.looseObject({ kind: z.literal('row') }),
  z.looseObject({ kind: z.literal('column') }),
  z.looseObject({ kind: z.literal('grid-2x2') }),
  z.looseObject({ kind: z.literal('custom'), root: LayoutNodeSchema }),
])
export type Layout = z.infer<typeof LayoutSchema>

export interface LayoutIssue {
  path: (string | number)[]
  message: string
}

function collectLeaves(node: LayoutNode, out: number[]): void {
  if (node.type === 'pane') {
    out.push(node.pane)
    return
  }
  for (const child of node.children) {
    collectLeaves(child, out)
  }
}

/** Checks that a layout fits the number of panes in its tab. */
export function validateLayoutPanes(layout: Layout, paneCount: number): LayoutIssue[] {
  switch (layout.kind) {
    case 'single':
      return paneCount === 1 ? [] : [{ path: ['panes'], message: 'single layout needs exactly 1 pane' }]
    case 'grid-2x2':
      return paneCount === 4 ? [] : [{ path: ['panes'], message: 'grid-2x2 layout needs exactly 4 panes' }]
    case 'row':
    case 'column':
      return []
    case 'custom': {
      const leaves: number[] = []
      collectLeaves(layout.root, leaves)
      const sorted = [...leaves].sort((a, b) => a - b)
      const complete = sorted.length === paneCount && sorted.every((pane, i) => pane === i)
      return complete
        ? []
        : [{ path: ['layout', 'root'], message: `custom layout must reference panes 0..${paneCount - 1} exactly once` }]
    }
  }
}

/** Builds the pane array schema shared by preset tabs and runtime tabs. */
export function paneListSchema<T extends z.ZodType>(pane: T) {
  return z
    .array(pane)
    .min(1, 'a tab needs at least 1 pane')
    .max(MAX_PANES_PER_TAB, `a tab holds at most ${MAX_PANES_PER_TAB} panes`)
}

/** Empty pane with a message, e.g. a team member without a session of its own. */
export const PanePlaceholderSchema = z.strictObject({
  title: z.string().min(1),
  reason: z.string().min(1),
})
export type PanePlaceholder = z.infer<typeof PanePlaceholderSchema>

/** Runtime pane: a reference to a live session, or a placeholder, plus its size. */
export const AppPaneSchema = z
  .strictObject({
    sessionId: z.string().min(1).optional(),
    placeholder: PanePlaceholderSchema.optional(),
    size: PaneSizeSchema.optional(),
  })
  .refine(pane => (pane.sessionId === undefined) !== (pane.placeholder === undefined), {
    message: 'a pane needs either a sessionId or a placeholder',
  })
export type AppPane = z.infer<typeof AppPaneSchema>

/** A tab in the running app, holding 1-6 session panes. */
export const AppTabSchema = z
  .strictObject({
    id: z.string().min(1),
    title: z.string(),
    layout: LayoutSchema,
    panes: paneListSchema(AppPaneSchema),
  })
  .superRefine((tab, ctx) => {
    for (const issue of validateLayoutPanes(tab.layout, tab.panes.length)) {
      ctx.addIssue({ code: 'custom', ...issue })
    }
  })
export type AppTab = z.infer<typeof AppTabSchema>
