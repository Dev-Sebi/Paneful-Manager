import type { TeamTemplate, TeamTemplateInput } from '@paneful-manager/shared'
import { DEFAULT_COMMAND, TeamTemplateSchema } from '@paneful-manager/shared'

/** Form model of a teammate; `extra` keeps keys the form has no field for. */
export interface TeammateForm {
  name: string
  prompt: string
  model: string
  cwd: string
  extra: Record<string, unknown>
}

export interface TeamTemplateForm {
  name: string
  description: string
  goal: string
  leadCwd: string
  leadCommand: string
  leadModel: string
  /** One argument per line. */
  leadArgs: string
  /** One `KEY=value` per line. */
  env: string
  teammates: TeammateForm[]
  leadExtra: Record<string, unknown>
  extra: Record<string, unknown>
}

export interface FormIssue {
  path: string
  message: string
}

/** Deep copy that also works on reactive proxies, which `structuredClone` rejects. */
export function cloneTemplateForm (form: TeamTemplateForm): TeamTemplateForm {
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(form)) as TeamTemplateForm
}

export function emptyTeammate (): TeammateForm {
  return { name: '', prompt: '', model: '', cwd: '', extra: {} }
}

export function emptyTemplateForm (): TeamTemplateForm {
  return {
    name: '',
    description: '',
    goal: '',
    leadCwd: '',
    leadCommand: DEFAULT_COMMAND,
    leadModel: '',
    leadArgs: '',
    env: '',
    teammates: [emptyTeammate()],
    leadExtra: {},
    extra: {},
  }
}

export function templateToForm (template: TeamTemplate): TeamTemplateForm {
  const { name, description, goal, lead, teammates, env, experimental: _experimental, ...extra } = template
  const { cwd, command, args, model, ...leadExtra } = lead
  return {
    name,
    description: description ?? '',
    goal: goal ?? '',
    leadCwd: cwd,
    leadCommand: command,
    leadModel: model ?? '',
    leadArgs: args.join('\n'),
    env: Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'),
    teammates: teammates.map(teammate => {
      const { name: teammateName, prompt, model: teammateModel, cwd: teammateCwd, ...teammateExtra } = teammate
      return { name: teammateName, prompt, model: teammateModel ?? '', cwd: teammateCwd ?? '', extra: teammateExtra }
    }),
    leadExtra,
    extra,
  }
}

function lines (text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '')
}

function optional<K extends string> (key: K, value: string): Partial<Record<K, string>> {
  const trimmed = value.trim()
  return trimmed === '' ? {} : ({ [key]: trimmed } as Record<K, string>)
}

/** `KEY=value` lines to an object; a line without `=` keeps its text as key so the schema reports it. */
function parseEnv (text: string): Record<string, string> {
  return Object.fromEntries(lines(text).map(line => {
    const index = line.indexOf('=')
    return index === -1 ? [line.trim(), ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
  }))
}

/** Builds the template the server expects; validation happens separately in `validateTemplateForm`. */
export function formToTemplate (form: TeamTemplateForm): TeamTemplateInput {
  return {
    ...form.extra,
    name: form.name.trim(),
    experimental: true,
    ...optional('description', form.description),
    ...optional('goal', form.goal),
    lead: {
      ...form.leadExtra,
      cwd: form.leadCwd.trim(),
      command: form.leadCommand.trim(),
      args: lines(form.leadArgs),
      ...optional('model', form.leadModel),
    },
    teammates: form.teammates.map(teammate => ({
      ...teammate.extra,
      name: teammate.name.trim(),
      prompt: teammate.prompt,
      ...optional('model', teammate.model),
      ...optional('cwd', teammate.cwd),
    })),
    env: parseEnv(form.env),
  } as TeamTemplateInput
}

/** Validates with the shared schema, the same one the server applies. */
export function validateTemplateForm (form: TeamTemplateForm): { template: TeamTemplate } | { issues: FormIssue[] } {
  const result = TeamTemplateSchema.safeParse(formToTemplate(form))
  if (result.success) {
    return { template: result.data }
  }
  return { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }
}
