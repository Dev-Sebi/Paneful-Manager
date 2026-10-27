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

export const MAX_TEAM_DESCRIPTION_LENGTH = 500

/**
 * Budget for the generated lead command (cwd, command, args, settings JSON, first prompt) in bytes.
 * tmux refuses commands above about 16 KB; the rest is headroom for the session env and tmux flags.
 */
export const MAX_LEAD_COMMAND_BYTES = 12 * 1024

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

/** Free text for the lead's prompt: no control characters except tab and newline. */
// eslint-disable-next-line no-control-regex
const PromptTextSchema = z.string().trim().regex(/^[^\0-\x08\v-\x1F\x7F]*$/, 'must not contain control characters other than tab and newline')

/** Short options that resume a session or print instead of running interactively. */
const RESERVED_SHORT_LETTERS = /[pcr]/

function isReservedArg(arg: string): boolean {
  if (arg === '--') {
    return true
  }
  if (/^-[^-]/.test(arg)) {
    const cluster = /^-([A-Za-z]*)/.exec(arg)?.[1] ?? ''
    return RESERVED_SHORT_LETTERS.test(cluster)
  }
  return RESERVED_LEAD_ARGS.some(flag => arg === flag || arg.startsWith(`${flag}=`))
}

export const TeamLeadSchema = z.looseObject({
  cwd: PathSchema,
  command: z.string().regex(/^[^\0=]+$/, 'command must be non-empty and contain no NUL or =').default(DEFAULT_COMMAND),
  args: z
    .array(NoNulSchema)
    .default(() => [])
    .refine(args => !args.some(isReservedArg), `args must not contain --, ${RESERVED_LEAD_ARGS.join(', ')} or short option groups with p, c or r; the launch sets them`),
  model: TeamModelSchema.optional(),
})
export type TeamLead = z.infer<typeof TeamLeadSchema>

export const TeammateSchema = z.looseObject({
  name: TeammateNameSchema,
  /** Role and instructions; handed to the lead, who spawns the teammate with it. */
  prompt: PromptTextSchema.min(1, 'prompt must not be empty').max(MAX_TEAMMATE_PROMPT_LENGTH),
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
    description: NoNulSchema.max(MAX_TEAM_DESCRIPTION_LENGTH).optional(),
    /** Marks the file as depending on the experimental agent teams feature. */
    experimental: z.literal(true, 'experimental must be true: team templates depend on an experimental Claude Code feature'),
    /** What the team should work on; added to the lead's first prompt. */
    goal: PromptTextSchema.max(MAX_TEAM_GOAL_LENGTH).optional(),
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
    const bytes = leadCommandBytes(template)
    if (bytes > MAX_LEAD_COMMAND_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `the generated lead command is ${bytes} bytes, the limit is ${MAX_LEAD_COMMAND_BYTES} (tmux refuses longer commands); shorten the prompts, goal or args`,
      })
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

/** Extracts `x.y.z` from the first line of `claude --version` output that starts with one, e.g. `2.1.311 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+)\b/m.exec(output)?.[1]
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

/** Env the launch always sets for the team; template env cannot override these keys. */
export function teamSettingsEnv(team: string): Record<string, string> {
  return {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    CLAUDE_CODE_TASK_LIST_ID: team,
  }
}

type LeadArgsTemplate = Pick<TeamTemplate, 'goal' | 'teammates' | 'env'> & { lead: Pick<TeamLead, 'args' | 'model'> }

/**
 * Lead argv. Template args come first and the launch's flags follow, so a variadic template option
 * ends at `--teammate-mode`. A trailing template flag that expects a value would swallow
 * `--teammate-mode` instead; that is a documented limit (ADR 0012).
 */
export function buildLeadArgs(template: LeadArgsTemplate, claudeSessionId: string, resolveCwd: (path: string) => string = path => path): string[] {
  const settings = { env: { ...template.env, ...teamSettingsEnv(teamNameFor(claudeSessionId)) } }
  return [
    ...template.lead.args,
    '--teammate-mode',
    'tmux',
    '--session-id',
    claudeSessionId,
    '--settings',
    JSON.stringify(settings),
    ...(template.lead.model === undefined ? [] : ['--model', template.lead.model]),
    buildLeadPrompt(template, resolveCwd),
  ]
}

/** Same length as a real `randomUUID()`, so the budget check matches the launch. */
const PLACEHOLDER_SESSION_ID = '00000000-0000-4000-8000-000000000000'

/** UTF-8 size of the lead's cwd, command and argv, one separator per entry. */
export function leadCommandBytes(template: LeadArgsTemplate & { lead: Pick<TeamLead, 'cwd' | 'command'> }): number {
  const encoder = new TextEncoder()
  const parts = [template.lead.cwd, template.lead.command, ...buildLeadArgs(template, PLACEHOLDER_SESSION_ID)]
  return parts.reduce((sum, part) => sum + encoder.encode(part).length + 1, 0)
}
