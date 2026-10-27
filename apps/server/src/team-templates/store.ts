import { TeamTemplateNameSchema, TeamTemplateSchema, type TeamTemplate } from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import type { BackupStore } from '../files/backups.js'
import { TEAM_TEMPLATES_DIR_NAME } from '../config/load-config.js'
import { createNamedYamlStore, type NamedYamlStore } from '../files/yaml-store.js'

export type TeamTemplateStore = NamedYamlStore<TeamTemplate>

export interface TeamTemplateStoreOptions {
  /** The `teams` directory next to `config.yaml`; created on the first write. */
  dir: string
  logger?: Pick<BaseLogger, 'warn'>
  backups?: BackupStore
}

/** Drops defaults the schema fills in, so saved files stay as short as hand-written ones. */
function toFileShape(template: TeamTemplate): Record<string, unknown> {
  const { env, lead, ...rest } = template
  const { args, ...leadRest } = lead
  return {
    ...rest,
    lead: args.length === 0 ? leadRest : lead,
    ...(Object.keys(env).length === 0 ? {} : { env }),
  }
}

/** CRUD over `<dir>/<name>.yaml` with the same rules as workspace presets. */
export function createTeamTemplateStore(options: TeamTemplateStoreOptions): TeamTemplateStore {
  return createNamedYamlStore({
    ...options,
    schema: TeamTemplateSchema,
    nameSchema: TeamTemplateNameSchema,
    label: 'Team template',
    dirLabel: TEAM_TEMPLATES_DIR_NAME,
    toFileShape,
  })
}
