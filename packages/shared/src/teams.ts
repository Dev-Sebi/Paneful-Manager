import { z } from 'zod'
import { IsoDateTimeSchema } from './session.js'

export const TeamTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'unknown'])
/** `unknown` is any status string outside the three Claude Code states. */
export type TeamTaskStatus = z.infer<typeof TeamTaskStatusSchema>

export const TeamTaskSchema = z.strictObject({
  id: z.string().min(1),
  subject: z.string(),
  description: z.string().optional(),
  status: TeamTaskStatusSchema,
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  owner: z.string().optional(),
  activeForm: z.string().optional(),
  /** File mtime. */
  updatedAt: IsoDateTimeSchema.optional(),
  /** Derived: not completed and some `blockedBy` task is not completed. */
  blocked: z.boolean(),
})
export type TeamTask = z.infer<typeof TeamTaskSchema>

/** Why a member has no Paneful Manager session. */
export const TeamMemberUnlinkedReasonSchema = z.enum([
  /** `backendType: in-process`: runs inside the lead's process, no pane of its own. */
  'in-process',
  /** No `tmuxPaneId` in the config and no linked teammate to infer it from. */
  'no-pane',
  /** The pane id is not on the Paneful Manager tmux server (other server, or the pane is gone). */
  'pane-not-found',
  /** The pane lives in a tmux session Paneful Manager does not manage. */
  'not-paneful-manager',
  /** The pane's session works in another directory; the pane id likely belongs to another tmux server. */
  'cwd-mismatch',
  /** The tmux server could not be queried. */
  'tmux-unavailable',
])
export type TeamMemberUnlinkedReason = z.infer<typeof TeamMemberUnlinkedReasonSchema>

/**
 * Link of a team member to a Paneful Manager session. `pane`: the member's `tmuxPaneId` is a pane of
 * that session. `lead-window`: the lead has no pane id; its teammates' panes all sit in that session.
 */
export const TeamMemberLinkSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('linked'),
    sessionId: z.string().min(1),
    via: z.enum(['pane', 'lead-window']),
  }),
  z.strictObject({
    status: z.literal('unlinked'),
    reason: TeamMemberUnlinkedReasonSchema,
  }),
])
export type TeamMemberLink = z.infer<typeof TeamMemberLinkSchema>

export const TeamMemberSchema = z.strictObject({
  name: z.string().min(1),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  color: z.string().optional(),
  backendType: z.string().optional(),
  tmuxPaneId: z.string().optional(),
  cwd: z.string().optional(),
  /** Set by servers with pane mapping (T53); absent from older servers. */
  link: TeamMemberLinkSchema.optional(),
})
export type TeamMember = z.infer<typeof TeamMemberSchema>

/** `agentType` Claude Code gives the lead member. */
export const TEAM_LEAD_AGENT_TYPE = 'team-lead'

export function isTeamLead(member: Pick<TeamMember, 'agentType'>): boolean {
  return member.agentType === TEAM_LEAD_AGENT_TYPE
}

export const TeamSchema = z.strictObject({
  name: z.string().min(1),
  members: z.array(TeamMemberSchema),
  tasks: z.array(TeamTaskSchema),
  /** Newest mtime of the files read; `null` when nothing was read. */
  lastUpdated: IsoDateTimeSchema.nullable(),
})
export type Team = z.infer<typeof TeamSchema>

/** GET /api/teams; `enabled` mirrors `experimental.agentTeams`. */
export const ListTeamsResponseSchema = z.strictObject({
  enabled: z.boolean(),
  teams: z.array(TeamSchema),
  warnings: z.array(z.string()),
})
export type ListTeamsResponse = z.infer<typeof ListTeamsResponseSchema>

export interface ParsedItem<T> {
  value?: T
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Tolerant task parser: unknown fields are ignored, optional fields default, an invalid
 * `id`, `subject` or a non-string `status` skips the task; an unrecognized status becomes `unknown`.
 */
export function parseTeamTask(
  raw: unknown,
  fileId: string,
  updatedAt?: string,
  label = `${fileId}.json`,
): ParsedItem<Omit<TeamTask, 'blocked'>> {
  if (!isRecord(raw)) {
    return { warnings: [`${label}: task is not a JSON object, skipped`] }
  }
  const { id, subject, status } = raw
  if (typeof id !== 'string' || id === '') {
    return { warnings: [`${label}: missing or invalid id, skipped`] }
  }
  if (typeof subject !== 'string') {
    return { warnings: [`${label}: missing or invalid subject, skipped`] }
  }
  if (typeof status !== 'string') {
    return { warnings: [`${label}: missing or invalid status, skipped`] }
  }
  const known = TeamTaskStatusSchema.safeParse(status)
  const parsedStatus: TeamTaskStatus = known.success ? known.data : 'unknown'
  const warnings = id === fileId ? [] : [`${label}: file name differs from id ${id}, using id`]
  const description = optionalString(raw.description)
  const owner = optionalString(raw.owner)
  const activeForm = optionalString(raw.activeForm)
  return {
    value: {
      id,
      subject,
      status: parsedStatus,
      blocks: stringList(raw.blocks),
      blockedBy: stringList(raw.blockedBy),
      ...(description === undefined ? {} : { description }),
      ...(owner === undefined ? {} : { owner }),
      ...(activeForm === undefined ? {} : { activeForm }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    },
    warnings,
  }
}

/** Sets `blocked` on every task; an unknown blocker id counts as not completed. */
export function deriveBlocked(tasks: Array<Omit<TeamTask, 'blocked'>>): TeamTask[] {
  const done = new Set(tasks.filter(task => task.status === 'completed').map(task => task.id))
  return tasks.map(task => ({
    ...task,
    blocked: task.status !== 'completed' && task.blockedBy.some(id => !done.has(id)),
  }))
}

/** Tolerant `config.json` parser: returns the members that have a name; others are dropped with a warning. */
export function parseTeamConfig(raw: unknown, label: string): { members: TeamMember[], warnings: string[] } {
  if (!isRecord(raw) || !Array.isArray(raw.members)) {
    return { members: [], warnings: [`${label}: config has no members list`] }
  }
  const members: TeamMember[] = []
  const warnings: string[] = []
  for (const entry of raw.members) {
    const name = isRecord(entry) ? optionalString(entry.name) : undefined
    if (!isRecord(entry) || name === undefined) {
      warnings.push(`${label}: member without a name dropped`)
      continue
    }
    const member: TeamMember = { name }
    for (const key of ['agentId', 'agentType', 'color', 'backendType', 'tmuxPaneId', 'cwd'] as const) {
      const value = optionalString(entry[key])
      if (value !== undefined) {
        member[key] = value
      }
    }
    members.push(member)
  }
  return { members, warnings }
}
