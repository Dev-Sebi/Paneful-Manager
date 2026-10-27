import { EventEmitter } from 'node:events'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  FileChangedMessageSchema,
  type FileChangeEvent,
  type FileChangedMessage,
  type Scope,
} from '@agent-hub/shared'
import { watch, type FSWatcher } from 'chokidar'
import type { BaseLogger } from 'pino'
import { createAllowlist, type Allowlist } from '../fs/allowlist.js'
import { MAX_SKILL_DEPTH, allowlistRoots, isWatchCandidate, matchManagedPath } from './layout.js'
import { readCurrent } from './read.js'

/** Events for one path within this window collapse into one message. */
export const WATCH_DEBOUNCE_MS = 100

export interface FileWatcherOptions {
  getScopes: () => Promise<Scope[]>
  logger: Pick<BaseLogger, 'debug' | 'warn'>
  /** Optional sink, e.g. the WS broadcast; `onChange` listeners get the same messages. */
  broadcast?: (message: FileChangedMessage) => void
  allowlist?: (roots: readonly string[]) => Allowlist
  debounceMs?: number
}

export interface FileWatcher {
  start: () => Promise<void>
  /** Re-reads the scopes and adjusts the watched roots. */
  refresh: () => Promise<void>
  onChange: (listener: (message: FileChangedMessage) => void) => () => void
  close: () => Promise<void>
}

/** Merges a new event into a pending one: add+change stays add, unlink+add becomes change. */
function mergeEvents(previous: FileChangeEvent | undefined, next: FileChangeEvent): FileChangeEvent {
  if (previous === 'add' && next === 'change') {
    return 'add'
  }
  if (previous === 'unlink' && next === 'add') {
    return 'change'
  }
  return next
}

export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  const { getScopes, logger, broadcast } = options
  const makeAllowlist = options.allowlist ?? createAllowlist
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS
  const emitter = new EventEmitter()
  const pending = new Map<string, { event: FileChangeEvent; timer: NodeJS.Timeout }>()
  let scopes: Scope[] = []
  let roots: string[] = []
  let fsWatcher: FSWatcher | undefined

  async function hashOf(path: string): Promise<string | undefined> {
    try {
      const real = makeAllowlist(allowlistRoots(scopes)).resolveInside(path)
      if (!(await lstat(real)).isFile()) {
        return undefined
      }
      return (await readCurrent(real))?.hash
    } catch {
      return undefined
    }
  }

  async function flush(path: string, event: FileChangeEvent): Promise<void> {
    const hash = event === 'unlink' ? undefined : await hashOf(path)
    const message = FileChangedMessageSchema.parse({ type: 'file.changed', path, event, ...(hash ? { hash } : {}) })
    broadcast?.(message)
    emitter.emit('change', message)
  }

  function onEvent(event: FileChangeEvent, raw: string): void {
    const match = matchManagedPath(scopes, resolve(raw))
    if (!match) {
      return
    }
    const previous = pending.get(match.path)
    if (previous) {
      clearTimeout(previous.timer)
    }
    const merged = mergeEvents(previous?.event, event)
    const timer = setTimeout(() => {
      pending.delete(match.path)
      flush(match.path, merged).catch((error: unknown) => logger.warn({ err: error, path: match.path }, 'File change emit failed'))
    }, debounceMs)
    pending.set(match.path, { event: merged, timer })
  }

  async function loadRoots(): Promise<string[]> {
    scopes = await getScopes()
    return allowlistRoots(scopes)
  }

  return {
    async start() {
      if (fsWatcher) {
        return
      }
      roots = await loadRoots()
      const created = watch(roots, {
        ignoreInitial: true,
        ignored: (path: string) => !isWatchCandidate(scopes, resolve(path)),
        depth: MAX_SKILL_DEPTH + 4,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
      })
      created.on('add', path => onEvent('add', path))
      created.on('change', path => onEvent('change', path))
      created.on('unlink', path => onEvent('unlink', path))
      created.on('error', error => logger.warn({ err: error }, 'File watcher error'))
      fsWatcher = created
      await new Promise<void>(done => created.once('ready', () => done()))
    },

    async refresh() {
      if (!fsWatcher) {
        return
      }
      const next = await loadRoots()
      const removed = roots.filter(root => !next.includes(root))
      const added = next.filter(root => !roots.includes(root))
      if (removed.length > 0) {
        fsWatcher.unwatch(removed)
      }
      if (added.length > 0) {
        fsWatcher.add(added)
      }
      roots = next
    },

    onChange(listener) {
      emitter.on('change', listener)
      return () => {
        emitter.off('change', listener)
      }
    },

    async close() {
      for (const { timer } of pending.values()) {
        clearTimeout(timer)
      }
      pending.clear()
      emitter.removeAllListeners()
      await fsWatcher?.close()
      fsWatcher = undefined
    },
  }
}
