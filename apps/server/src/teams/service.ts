import type { AppConfig, ListTeamsResponse, Team, TeamChangedMessage } from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import type { TmuxPaneInfo } from '../tmux/tmux.js'
import { linkTeams } from './links.js'
import { readTeams, type ReadTeamsResult } from './reader.js'
import { createTeamsWatcher, type TeamsWatcher } from './watcher.js'

/** Fallback for file systems where change events are missed. */
export const TEAMS_POLL_INTERVAL_MS = 10_000

/** Live sources for linking members to Paneful Manager sessions (T53). */
export interface TeamLinkSources {
  listPanes: () => Promise<TmuxPaneInfo[]>
  sessions: () => Iterable<{ id: string, cwd: string }>
}

export interface TeamsServiceOptions {
  claudeDir: string
  getConfig: () => Pick<AppConfig, 'experimental'>
  /** Subscribes to live config changes; returns an unsubscribe function. */
  onConfigChange?: (listener: () => void) => () => void
  logger: Pick<BaseLogger, 'debug' | 'warn'>
  broadcast: (message: TeamChangedMessage) => void
  /** Without it members carry no `link`. */
  links?: TeamLinkSources
  debounceMs?: number
  pollIntervalMs?: number
}

export interface TeamsService {
  enabled: () => boolean
  /** Starts or stops the watcher and the poll to match the flag. */
  sync: () => Promise<void>
  list: () => Promise<ListTeamsResponse>
  /** Re-checks teams now (e.g. after a session was created or removed); no-op while the flag is off. */
  refresh: () => Promise<void>
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
  let pollRunning: Promise<void> | undefined
  let pollQueued: Promise<void> | undefined
  let closed = false

  /** Reads the teams and, when link sources are given and any team has members, links them to sessions. */
  async function load(): Promise<ReadTeamsResult> {
    const result = await readTeams({ claudeDir })
    const { links } = options
    if (links === undefined || !result.teams.some(team => team.members.length > 0)) {
      return result
    }
    const panes = await links.listPanes().catch((error: unknown) => {
      logger.debug({ err: error }, 'Listing tmux panes for team links failed')
      return null
    })
    const sessions = new Map([...links.sessions()].map(session => [session.id, { cwd: session.cwd }]))
    return { ...result, teams: linkTeams(result.teams, { panes, sessions }) }
  }

  async function snapshot(): Promise<Map<string, string>> {
    const { teams } = await load()
    return new Map(teams.map(team => [team.name, signatureOf(team)]))
  }

  const active = (): boolean => pollTimer !== undefined && !closed

  /** Serialized and coalesced: one run at a time, at most one more queued behind it. */
  function poll(): Promise<void> {
    if (pollQueued) {
      return pollQueued
    }
    if (pollRunning) {
      pollQueued = pollRunning.then(() => {
        pollQueued = undefined
        return poll()
      })
      return pollQueued
    }
    pollRunning = pollOnce().finally(() => {
      pollRunning = undefined
    })
    return pollRunning
  }

  async function pollOnce(): Promise<void> {
    if (!active()) {
      return
    }
    try {
      const next = await snapshot()
      if (!active()) {
        return
      }
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
      const { teams, warnings } = await load()
      for (const warning of warnings) {
        logger.debug({ warning }, 'Teams file skipped')
      }
      return { enabled: true, teams, warnings }
    },
    async refresh() {
      if (pollTimer !== undefined) {
        await poll()
      }
    },
    async close() {
      closed = true
      offConfig?.()
      await sync()
    },
  }
}
