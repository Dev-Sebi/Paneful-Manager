import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildLeadArgs,
  compareVersions,
  CreateSessionRequestSchema,
  LAST_TESTED_AGENT_TEAMS_VERSION,
  MIN_AGENT_TEAMS_VERSION,
  parseClaudeVersion,
  TeamLaunchSchema,
  teamNameFor,
  type LaunchTeamTemplateResponse,
  type TeamLaunch,
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

/** Default version probe: `<command> --version` without a shell, in the lead's cwd so relative commands resolve like in the session. */
export async function probeVersion(command: string, cwd: string): Promise<string> {
  const { stdout } = await run(command, ['--version'], { cwd, timeoutMs: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER_BYTES })
  return stdout
}

export interface TeamTemplateLauncherOptions {
  store: Pick<TeamTemplateStore, 'get'>
  engine: Pick<SessionEngine, 'create' | 'kill' | 'get'>
  ledger: TeamLaunchLedger
  logger: Pick<BaseLogger, 'info' | 'warn'>
  /** Returns the raw `--version` output of the lead command. */
  version?: (command: string, cwd: string) => Promise<string>
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


export function createTeamTemplateLauncher(options: TeamTemplateLauncherOptions): TeamTemplateLauncher {
  const { store, engine, ledger, logger } = options
  const version = options.version ?? probeVersion
  const newClaudeSessionId = options.newClaudeSessionId ?? randomUUID
  const now = options.now ?? (() => new Date())

  function isLive(id: string): boolean {
    const session = engine.get(id)
    return session !== undefined && session.lifecycle !== 'exited'
  }

  async function checkVersion(command: string, cwd: string): Promise<{ claudeVersion: string, untestedVersion: boolean }> {
    const isDir = await stat(cwd).then(info => info.isDirectory(), () => false)
    if (!isDir) {
      throw new AppError(`cwd ${cwd} is not a directory`, 400, 'bad_request')
    }
    const output = await version(command, cwd).catch((error: unknown) => {
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
        args: buildLeadArgs(template, claudeSessionId, path => expandHome(path)),
        title: template.name,
      })
      const versionInfo = await checkVersion(template.lead.command, resolve(expandHome(template.lead.cwd)))
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
