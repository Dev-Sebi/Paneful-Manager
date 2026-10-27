import { z } from 'zod'
import { IsoDateTimeSchema } from './session.js'

export const TeamTaskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
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

export const TeamMemberSchema = z.strictObject({
  name: z.string().min(1),
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  color: z.string().optional(),
  backendType: z.string().optional(),
  tmuxPaneId: z.string().optional(),
  cwd: z.string().optional(),
})
export type TeamMember = z.infer<typeof TeamMemberSchema>

export const TeamSchema = z.strictObject({
  name: z.string().min(1),
  dir: z.string().min(1),
  members: z.array(TeamMemberSchema),
  tasks: z.array(TeamTaskSchema),
  lastUpdated: IsoDateTimeSchema,
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
 * `id`, `subject` or `status` skips the task. `fileId` is the file name without `.json`.
 */
export function parseTeamTask(raw: unknown, fileId: string, updatedAt?: string): ParsedItem<Omit<TeamTask, 'blocked'>> {
  if (!isRecord(raw)) {
    return { warnings: [`${fileId}: task is not a JSON object, skipped`] }
  }
  const { id, subject, status } = raw
  if (typeof id !== 'string' || id === '') {
    return { warnings: [`${fileId}: missing or invalid id, skipped`] }
  }
  if (typeof subject !== 'string') {
    return { warnings: [`${fileId}: missing or invalid subject, skipped`] }
  }
  const parsedStatus = TeamTaskStatusSchema.safeParse(status)
  if (!parsedStatus.success) {
    return { warnings: [`${fileId}: missing or unknown status, skipped`] }
  }
  const warnings = id === fileId ? [] : [`${fileId}: file name differs from id ${id}, using id`]
  const description = optionalString(raw.description)
  const owner = optionalString(raw.owner)
  const activeForm = optionalString(raw.activeForm)
  return {
    value: {
      id,
      subject,
      status: parsedStatus.data,
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
