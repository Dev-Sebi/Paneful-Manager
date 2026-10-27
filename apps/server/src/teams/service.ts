import type { AppConfig, ListTeamsResponse, TeamChangedMessage } from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { readTeams } from './reader.js'
import { createTeamsWatcher, type TeamsWatcher } from './watcher.js'

/** Re-checks the feature flag this often, so a flag change starts or stops the watcher. */
export const TEAMS_SYNC_INTERVAL_MS = 5000

export interface TeamsServiceOptions {
  claudeDir: string
  getConfig: () => Pick<AppConfig, 'experimental'>
  logger: Pick<BaseLogger, 'debug' | 'warn'>
  broadcast: (message: TeamChangedMessage) => void
  debounceMs?: number
  syncIntervalMs?: number
}

export interface TeamsService {
  enabled: () => boolean
  /** Starts or stops the watcher to match the flag. */
  sync: () => Promise<void>
  list: () => Promise<ListTeamsResponse>
  close: () => Promise<void>
}

export function createTeamsService(options: TeamsServiceOptions): TeamsService {
  const { claudeDir, getConfig, logger, broadcast } = options
  const enabled = (): boolean => getConfig().experimental.agentTeams
  let watcher: TeamsWatcher | undefined
  let chain: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  let closed = false

  async function apply(): Promise<void> {
    if (enabled() && !watcher && !closed) {
      const created = createTeamsWatcher({ claudeDir, logger, broadcast, ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }) })
      watcher = created
      await created.start().catch((error: unknown) => {
        logger.warn({ err: error }, 'Teams watcher failed to start')
        watcher = undefined
      })
    } else if (!enabled() && watcher) {
      const current = watcher
      watcher = undefined
      await current.close()
    }
  }

  function sync(): Promise<void> {
    chain = chain.then(apply, apply)
    return chain
  }

  timer = setInterval(() => {
    void sync()
  }, options.syncIntervalMs ?? TEAMS_SYNC_INTERVAL_MS)
  timer.unref()

  return {
    enabled,
    sync,
    async list() {
      if (!enabled()) {
        return { enabled: false, teams: [], warnings: [] }
      }
      const { teams, warnings } = await readTeams({ claudeDir })
      return { enabled: true, teams, warnings }
    },
    async close() {
      closed = true
      clearInterval(timer)
      timer = undefined
      await sync()
      await watcher?.close()
      watcher = undefined
    },
  }
}
