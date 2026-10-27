import { z } from 'zod'
import { DEFAULT_COMMAND } from './defaults.js'
import { PresetNameSchema } from './preset.js'
import { PathSchema } from './scope.js'
import { IsoDateTimeSchema, SessionIdSchema } from './session.js'

/** Upper bound per template; upstream recommends 3-5 teammates and has no hard limit. */
export const MAX_TEAMMATES = 8

/** Longest teammate instruction; all instructions travel in one argv entry of the lead. */
export const MAX_TEAMMATE_PROMPT_LENGTH = 4000

export const MAX_TEAM_GOAL_LENGTH = 4000

export const MAX_TEAMMATE_NAME_LENGTH = 32

export const MAX_TEAM_ENV_VALUE_LENGTH = 256

/** Lowest Claude Code version agent teams were tested with (ADR 0010). */
export const MIN_AGENT_TEAMS_VERSION = '2.1.309'

/** Newest version the launch flow was verified against; newer ones launch with an "untested" note. */
export const LAST_TESTED_AGENT_TEAMS_VERSION = '2.1.311'

/** Env keys a template may set for the team; everything else is refused. */
export const TEAM_TEMPLATE_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
] as const

/** Lead arguments the launch sets itself, or that would stop teammates from spawning. */
export const RESERVED_LEAD_ARGS = [
  '--teammate-mode',
  '--session-id',
  '--settings',
  '--model',
  '-p',
  '--print',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--fork-session',
] as const

const RESERVED_TEAMMATE_NAMES = new Set(['team-lead', 'lead'])

export const TeamTemplateNameSchema = PresetNameSchema

export const TeammateNameSchema = z
  .string()
  .max(MAX_TEAMMATE_NAME_LENGTH, `name must be at most ${MAX_TEAMMATE_NAME_LENGTH} characters`)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'name may only contain lowercase letters, digits and - and must not start with -')
  .refine(name => !RESERVED_TEAMMATE_NAMES.has(name), 'name is reserved for the team lead')

/** Model alias or id; no whitespace so it cannot smuggle extra instructions. */
export const TeamModelSchema = z.string().regex(/^[A-Za-z0-9._:[\]-]+$/, 'model may only contain letters, digits and . _ : - [ ]')

const NoNulSchema = z.string().regex(/^[^\0]*$/, 'must not contain NUL')

function isReservedArg(arg: string): boolean {
  return RESERVED_LEAD_ARGS.some(flag => arg === flag || arg.startsWith(`${flag}=`))
}

export const TeamLeadSchema = z.looseObject({
  cwd: PathSchema,
  command: z.string().regex(/^[^\0=]+$/, 'command must be non-empty and contain no NUL or =').default(DEFAULT_COMMAND),
  args: z
    .array(NoNulSchema)
    .default(() => [])
    .refine(args => !args.some(isReservedArg), `args must not contain ${RESERVED_LEAD_ARGS.join(', ')}; the launch sets them`),
  model: TeamModelSchema.optional(),
})
export type TeamLead = z.infer<typeof TeamLeadSchema>

export const TeammateSchema = z.looseObject({
  name: TeammateNameSchema,
  /** Role and instructions; handed to the lead, who spawns the teammate with it. */
  prompt: NoNulSchema.trim().min(1, 'prompt must not be empty').max(MAX_TEAMMATE_PROMPT_LENGTH),
  /** Only passed on as an instruction: Claude Code spawns teammates in the lead's directory. */
  cwd: PathSchema.optional(),
  model: TeamModelSchema.optional(),
})
export type Teammate = z.infer<typeof TeammateSchema>

export const TeamEnvValueSchema = z.string().max(MAX_TEAM_ENV_VALUE_LENGTH).regex(/^[^\0\n\r]*$/, 'value must be a single line without NUL')

export const TeamEnvSchema = z.partialRecord(z.enum(TEAM_TEMPLATE_ENV_KEYS), TeamEnvValueSchema)
export type TeamEnv = z.infer<typeof TeamEnvSchema>

/** Team template file `~/.config/agent-hub/teams/<name>.yaml` (experimental). */
export const TeamTemplateSchema = z
  .looseObject({
    name: TeamTemplateNameSchema,
    description: z.string().optional(),
    /** Marks the file as depending on the experimental agent teams feature. */
    experimental: z.literal(true, 'experimental must be true: team templates depend on an experimental Claude Code feature'),
    /** What the team should work on; added to the lead's first prompt. */
    goal: NoNulSchema.trim().max(MAX_TEAM_GOAL_LENGTH).optional(),
    lead: TeamLeadSchema,
    teammates: z
      .array(TeammateSchema)
      .min(1, 'a team needs at least 1 teammate')
      .max(MAX_TEAMMATES, `a team has at most ${MAX_TEAMMATES} teammates`),
    env: TeamEnvSchema.default(() => ({})),
  })
  .superRefine((template, ctx) => {
    const seen = new Set<string>()
    for (const [index, teammate] of template.teammates.entries()) {
      if (seen.has(teammate.name)) {
        ctx.addIssue({ code: 'custom', path: ['teammates', index, 'name'], message: `duplicate teammate name ${teammate.name}` })
      }
      seen.add(teammate.name)
    }
  })
export type TeamTemplate = z.infer<typeof TeamTemplateSchema>
export type TeamTemplateInput = z.input<typeof TeamTemplateSchema>

/** One recorded launch of a template whose lead session is still live. */
export const TeamLaunchSchema = z.strictObject({
  template: TeamTemplateNameSchema,
  sessionId: SessionIdSchema,
  /** Expected team name: `session-` + the first 8 characters of the lead's Claude session id. */
  team: z.string().regex(/^session-[0-9a-f]{8}$/),
  launchedAt: IsoDateTimeSchema,
})
export type TeamLaunch = z.infer<typeof TeamLaunchSchema>

/** Team name Claude Code derives from the lead's session id (ADR 0010). */
export function teamNameFor(claudeSessionId: string): string {
  return `session-${claudeSessionId.slice(0, 8)}`
}

/** Compares dotted versions numerically; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) {
      return Math.sign(diff)
    }
  }
  return 0
}

/** Extracts `x.y.z` from `claude --version` output, e.g. `2.1.311 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1]
}

/**
 * First prompt for the lead: names every teammate with its instructions and model, so the lead
 * spawns them through the `Agent` tool. Claude Code offers no other way to pre-define a team.
 */
export function buildLeadPrompt(template: Pick<TeamTemplate, 'goal' | 'teammates'>, resolveCwd: (path: string) => string = path => path): string {
  const lines = [
    `Create an agent team with ${template.teammates.length} teammate${template.teammates.length === 1 ? '' : 's'}. Spawn each one with exactly the name below and give it its instructions.`,
    '',
  ]
  for (const teammate of template.teammates) {
    const extras = [
      teammate.model === undefined ? undefined : `model: ${teammate.model}`,
      teammate.cwd === undefined ? undefined : `working directory: ${resolveCwd(teammate.cwd)}`,
    ].filter((entry): entry is string => entry !== undefined)
    lines.push(`- ${teammate.name}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}: ${teammate.prompt}`)
  }
  if (template.goal !== undefined && template.goal !== '') {
    lines.push('', `Team goal: ${template.goal}`)
  }
  lines.push('', 'Track the work as tasks in the shared task list.')
  return lines.join('\n')
}
