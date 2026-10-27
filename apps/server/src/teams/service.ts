import type { AppConfig, ListTeamsResponse, Team, TeamChangedMessage } from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { readTeams } from './reader.js'
import { createTeamsWatcher, type TeamsWatcher } from './watcher.js'

/** Fallback for file systems where change events are missed. */
export const TEAMS_POLL_INTERVAL_MS = 10_000

export interface TeamsServiceOptions {
  claudeDir: string
  getConfig: () => Pick<AppConfig, 'experimental'>
  /** Subscribes to live config changes; returns an unsubscribe function. */
  onConfigChange?: (listener: () => void) => () => void
  logger: Pick<BaseLogger, 'debug' | 'warn'>
  broadcast: (message: TeamChangedMessage) => void
  debounceMs?: number
  pollIntervalMs?: number
}

export interface TeamsService {
  enabled: () => boolean
  /** Starts or stops the watcher and the poll to match the flag. */
  sync: () => Promise<void>
  list: () => Promise<ListTeamsResponse>
  close: () => Promise<void>
}

const signatureOf = (team: Team): string => JSON.stringify([team.members, team.tasks, team.lastUpdated])

export function createTeamsService(options: TeamsServiceOptions): TeamsService {
  const { claudeDir, getConfig, logger, broadcast } = options
  const enabled = (): boolean => getConfig().experimental.agentTeams
  let watcher: TeamsWatcher | undefined
  let pollTimer: NodeJS.Timeout | undefined
  let signatures = new Map<string, string>()
  let chain: Promise<void> = Promise.resolve()
  let closed = false

  async function snapshot(): Promise<Map<string, string>> {
    const { teams } = await readTeams({ claudeDir })
    return new Map(teams.map(team => [team.name, signatureOf(team)]))
  }

  async function poll(): Promise<void> {
    try {
      const next = await snapshot()
      for (const name of new Set([...signatures.keys(), ...next.keys()])) {
        if (signatures.get(name) !== next.get(name)) {
          broadcast({ type: 'team.changed', team: name })
        }
      }
      signatures = next
    } catch (error) {
      logger.warn({ err: error }, 'Teams poll failed')
    }
  }

  async function start(): Promise<void> {
    const created = createTeamsWatcher({ claudeDir, logger, broadcast, ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }) })
    watcher = created
    await created.start().catch((error: unknown) => {
      logger.warn({ err: error }, 'Teams watcher failed to start, relying on the poll')
      watcher = undefined
    })
    signatures = await snapshot().catch(() => new Map<string, string>())
    pollTimer = setInterval(() => {
      void poll()
    }, options.pollIntervalMs ?? TEAMS_POLL_INTERVAL_MS)
    pollTimer.unref()
  }

  async function stop(): Promise<void> {
    clearInterval(pollTimer)
    pollTimer = undefined
    signatures = new Map()
    const current = watcher
    watcher = undefined
    await current?.close()
  }

  async function apply(): Promise<void> {
    const running = pollTimer !== undefined
    if (enabled() && !closed && !running) {
      await start()
    } else if ((!enabled() || closed) && running) {
      await stop()
    }
  }

  function sync(): Promise<void> {
    chain = chain.then(apply, apply)
    return chain
  }

  const offConfig = options.onConfigChange?.(() => {
    void sync()
  })

  return {
    enabled,
    sync,
    async list() {
      if (!enabled()) {
        return { enabled: false, teams: [], warnings: [] }
      }
      const { teams, warnings } = await readTeams({ claudeDir })
      for (const warning of warnings) {
        logger.debug({ warning }, 'Teams file skipped')
      }
      return { enabled: true, teams, warnings }
    },
    async close() {
      closed = true
      offConfig?.()
      await sync()
    },
  }
}
