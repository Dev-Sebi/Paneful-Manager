import { z } from 'zod'

/** Non-empty filesystem path; may start with `~`, expanded by the server. */
export const PathSchema = z.string().trim().min(1, 'path must not be empty')

export const ScopeKindSchema = z.enum(['global', 'project', 'worktree'])
export type ScopeKind = z.infer<typeof ScopeKindSchema>

/** Where a setting or MCP server applies; `branch`/`projectPath` only exist for worktrees. */
export const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global'), path: PathSchema }),
  z.strictObject({ kind: z.literal('project'), path: PathSchema }),
  z.strictObject({
    kind: z.literal('worktree'),
    path: PathSchema,
    branch: z.string().min(1).optional(),
    projectPath: PathSchema.optional(),
  }),
])
export type Scope = z.infer<typeof ScopeSchema>
