import { PresetNameSchema, WorkspacePresetSchema, type WorkspacePreset } from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import type { BackupStore } from '../files/backups.js'
import { createNamedYamlStore, YAML_EXTENSION, type NamedYamlStore } from '../files/yaml-store.js'

export const PRESET_EXTENSION = YAML_EXTENSION

const COMPACT_LAYOUTS = new Set(['single', 'row', 'column', 'grid-2x2'])

export type PresetStore = NamedYamlStore<WorkspacePreset>

export interface PresetStoreOptions {
  /** The `workspaces` directory; created on the first write. */
  dir: string
  logger?: Pick<BaseLogger, 'warn'>
  /** When given, the previous file content is saved before an overwrite or a delete. */
  backups?: BackupStore
}

/** Drops values the schema fills in anyway, so saved files stay as short as hand-written ones. */
function toFileShape(preset: WorkspacePreset): Record<string, unknown> {
  return {
    ...preset,
    tabs: preset.tabs.map(tab => {
      const { kind, ...rest } = tab.layout
      const compact = COMPACT_LAYOUTS.has(kind) && Object.keys(rest).length === 0
      return {
        ...tab,
        layout: compact ? kind : tab.layout,
        panes: tab.panes.map(({ args, ...pane }) => (args.length === 0 ? pane : { ...pane, args })),
      }
    }),
  }
}

/** CRUD over `<dir>/<name>.yaml`: file name = preset name, atomic writes, writes serialized. */
export function createPresetStore(options: PresetStoreOptions): PresetStore {
  return createNamedYamlStore({
    ...options,
    schema: WorkspacePresetSchema,
    nameSchema: PresetNameSchema,
    label: 'Preset',
    dirLabel: 'workspaces',
    toFileShape,
  })
}
