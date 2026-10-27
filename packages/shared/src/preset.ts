import { z } from 'zod'
import { DEFAULT_COMMAND } from './defaults.js'
import { LayoutSchema, PaneSizeSchema, paneListSchema, validateLayoutPanes } from './layout.js'
import { PathSchema } from './scope.js'

/** Preset names double as file names (`<name>.yaml`). */
export const PresetNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'name may only contain letters, digits, _ and - and must not start with _ or -')

export const PresetPaneSchema = z.looseObject({
  cwd: PathSchema,
  command: z.string().min(1).default(DEFAULT_COMMAND),
  args: z.array(z.string()).default(() => []),
  title: z.string().optional(),
  size: PaneSizeSchema.optional(),
})
export type PresetPane = z.infer<typeof PresetPaneSchema>

export const PresetTabSchema = z
  .looseObject({
    title: z.string().optional(),
    layout: LayoutSchema.default(() => ({ kind: 'row' as const })),
    panes: paneListSchema(PresetPaneSchema),
  })
  .superRefine((tab, ctx) => {
    for (const issue of validateLayoutPanes(tab.layout, tab.panes.length)) {
      ctx.addIssue({ code: 'custom', ...issue })
    }
  })
export type PresetTab = z.infer<typeof PresetTabSchema>

/** Workspace preset file `~/.config/agent-hub/workspaces/<name>.yaml`. */
export const WorkspacePresetSchema = z.looseObject({
  name: PresetNameSchema,
  description: z.string().optional(),
  autostart: z.boolean().default(false),
  tabs: z.array(PresetTabSchema).min(1, 'a preset needs at least 1 tab'),
})
export type WorkspacePreset = z.infer<typeof WorkspacePresetSchema>
export type WorkspacePresetInput = z.input<typeof WorkspacePresetSchema>
