import { relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { TeamChangedMessage } from '@agent-hub/shared'
import { watch, type FSWatcher } from 'chokidar'
import type { BaseLogger } from 'pino'

/** Events of one team within this window collapse into one message. */
export const TEAMS_DEBOUNCE_MS = 200
const WATCH_DEPTH = 3

export interface TeamsWatcherOptions {
  claudeDir: string
  logger: Pick<BaseLogger, 'debug' | 'warn'>
  broadcast: (message: TeamChangedMessage) => void
  debounceMs?: number
}

export interface TeamsWatcher {
  start: () => Promise<void>
  close: () => Promise<void>
}

/** Team name of a path below `<root>/teams` or `<root>/tasks`, `undefined` for anything else. */
export function teamOfPath(root: string, path: string): string | undefined {
  const parts = relative(root, path).split(sep)
  const [area, team, file] = parts
  if ((area !== 'teams' && area !== 'tasks') || !team || team.startsWith('.')) {
    return undefined
  }
  if (file?.startsWith('.')) {
    return undefined
  }
  return team
}

/** Watches `<claudeDir>/teams` and `<claudeDir>/tasks` (not the rest of the directory) and emits `team.changed`. */
export function createTeamsWatcher(options: TeamsWatcherOptions): TeamsWatcher {
  const { claudeDir, logger, broadcast } = options
  const debounceMs = options.debounceMs ?? TEAMS_DEBOUNCE_MS
  const pending = new Map<string, NodeJS.Timeout>()
  let fsWatcher: FSWatcher | undefined

  function schedule(team: string): void {
    clearTimeout(pending.get(team))
    pending.set(team, setTimeout(() => {
      pending.delete(team)
      broadcast({ type: 'team.changed', team })
    }, debounceMs))
  }

  return {
    async start() {
      if (fsWatcher) {
        return
      }
      const root = await realpath(claudeDir).catch(() => claudeDir)
      const inside = (path: string): boolean => {
        const [area] = relative(root, path).split(sep)
        return area === '' || area === 'teams' || area === 'tasks'
      }
      const created = watch(root, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (path: string) => !inside(path),
        depth: WATCH_DEPTH,
      })
      const onEvent = (path: string): void => {
        const team = teamOfPath(root, path)
        if (team) {
          schedule(team)
        }
      }
      for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
        created.on(event, onEvent)
      }
      created.on('error', error => logger.warn({ err: error }, 'Teams watcher error'))
      fsWatcher = created
      await new Promise<void>(done => created.once('ready', () => done()))
    },

    async close() {
      for (const timer of pending.values()) {
        clearTimeout(timer)
      }
      pending.clear()
      await fsWatcher?.close()
      fsWatcher = undefined
    },
  }
}
