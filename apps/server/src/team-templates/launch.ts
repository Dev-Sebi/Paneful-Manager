import { randomUUID } from 'node:crypto'
import {
  buildLeadPrompt,
  compareVersions,
  CreateSessionRequestSchema,
  LAST_TESTED_AGENT_TEAMS_VERSION,
  MIN_AGENT_TEAMS_VERSION,
  parseClaudeVersion,
  TeamLaunchSchema,
  teamNameFor,
  type LaunchTeamTemplateResponse,
  type TeamLaunch,
  type TeamTemplate,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { AppError } from '../errors.js'
import { expandHome } from '../paths.js'
import { run } from '../process/exec.js'
import type { SessionEngine } from '../sessions/engine.js'
import type { TeamLaunchLedger } from './ledger.js'
import type { TeamTemplateStore } from './store.js'

export const VERSION_TIMEOUT_MS = 10_000
export const VERSION_MAX_BUFFER_BYTES = 64 * 1024

/** Env the launch always sets for the team; template env cannot override these keys. */
export function teamSettingsEnv(team: string): Record<string, string> {
  return {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    CLAUDE_CODE_TASK_LIST_ID: team,
  }
}

/** Default version probe: `<command> --version` without a shell. */
export async function probeVersion(command: string): Promise<string> {
  const { stdout } = await run(command, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER_BYTES })
  return stdout
}

export interface TeamTemplateLauncherOptions {
  store: Pick<TeamTemplateStore, 'get'>
  engine: Pick<SessionEngine, 'create' | 'kill' | 'get'>
  ledger: TeamLaunchLedger
  logger: Pick<BaseLogger, 'info' | 'warn'>
  /** Returns the raw `--version` output of the lead command. */
  version?: (command: string) => Promise<string>
  /** Claude session id for the lead; must be a UUID (`--session-id`). */
  newClaudeSessionId?: () => string
  now?: () => Date
}

export interface TeamTemplateLauncher {
  /** Starts the lead session; nothing is recorded and no session is left behind when it fails. */
  launch: (name: string) => Promise<LaunchTeamTemplateResponse>
  /** Recorded launches whose lead session is still live. */
  launches: () => TeamLaunch[]
  /** Drops the launch records of a deleted template; failures are logged, never thrown. */
  forget: (name: string) => Promise<void>
}

/** Lead argv: template args first, so the launch's own flags end any option list before the prompt. */
export function leadArgs(template: TeamTemplate, claudeSessionId: string, team: string): string[] {
  const settings = { env: { ...template.env, ...teamSettingsEnv(team) } }
  const prompt = buildLeadPrompt(template, path => expandHome(path))
  return [
    ...template.lead.args,
    '--teammate-mode',
    'tmux',
    '--session-id',
    claudeSessionId,
    '--settings',
    JSON.stringify(settings),
    ...(template.lead.model === undefined ? [] : ['--model', template.lead.model]),
    prompt,
  ]
}

export function createTeamTemplateLauncher(options: TeamTemplateLauncherOptions): TeamTemplateLauncher {
  const { store, engine, ledger, logger } = options
  const version = options.version ?? probeVersion
  const newClaudeSessionId = options.newClaudeSessionId ?? randomUUID
  const now = options.now ?? (() => new Date())

  function isLive(id: string): boolean {
    const session = engine.get(id)
    return session !== undefined && session.lifecycle !== 'exited'
  }

  async function checkVersion(command: string): Promise<{ claudeVersion: string, untestedVersion: boolean }> {
    const output = await version(command).catch((error: unknown) => {
      throw new AppError(`Could not run ${command} --version: ${(error as Error).message}`, 409, 'conflict')
    })
    const found = parseClaudeVersion(output)
    if (found === undefined || compareVersions(found, MIN_AGENT_TEAMS_VERSION) < 0) {
      throw new AppError(
        `Agent teams need Claude Code ${MIN_AGENT_TEAMS_VERSION} or later (found ${found ?? (output.trim() || 'nothing')}). Update Claude Code or turn off experimental.agentTeams.`,
        409,
        'conflict',
      )
    }
    return { claudeVersion: found, untestedVersion: compareVersions(found, LAST_TESTED_AGENT_TEAMS_VERSION) > 0 }
  }

  return {
    async launch(name) {
      const template = await store.get(name)
      const claudeSessionId = newClaudeSessionId()
      const team = teamNameFor(claudeSessionId)
      const request = CreateSessionRequestSchema.parse({
        cwd: template.lead.cwd,
        command: template.lead.command,
        args: leadArgs(template, claudeSessionId, team),
        title: template.name,
      })
      const versionInfo = await checkVersion(template.lead.command)
      const session = await engine.create(request)
      let launch: TeamLaunch
      try {
        launch = TeamLaunchSchema.parse({ template: template.name, sessionId: session.id, team, launchedAt: now().toISOString() })
      } catch (error) {
        await engine.kill(session.id).catch((killError: unknown) => {
          logger.warn({ err: killError, template: name }, 'Could not roll back the team lead session')
        })
        throw error
      }
      await ledger.record(launch, isLive).catch((error: unknown) => {
        logger.warn({ err: error, template: name }, 'Could not record the team launch')
      })
      logger.info(`Launched team template ${name} (lead ${session.id}, team ${team})`)
      return { launch, ...versionInfo }
    },
    launches: () => ledger.live(isLive),
    async forget(name) {
      await ledger.forget(name).catch((error: unknown) => {
        logger.warn({ err: error, template: name }, 'Could not drop the team launch record')
      })
    },
  }
}
