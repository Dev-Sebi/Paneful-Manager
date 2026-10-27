import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SessionIdSchema, SessionSchema, type Session } from '@agent-hub/shared'
import type { BaseLogger } from 'pino'

export const SESSIONS_DIR_NAME = 'sessions'

/** Writes `data` to `file` atomically: temp file in the same directory, fsync, rename. */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const temp = join(dirname(file), `.${basename(file)}.agent-hub-${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', mode)
  try {
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** `$STATE/sessions/<id>.json`, one `Session` per file; writes per id are serialized. */
export class SessionStore {
  readonly dir: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    stateDir: string,
    private readonly logger?: Pick<BaseLogger, 'warn'>,
  ) {
    this.dir = join(stateDir, SESSIONS_DIR_NAME)
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.dir), { recursive: true, mode: 0o700 })
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
  }

  save(session: Session): Promise<void> {
    const data = `${JSON.stringify(SessionSchema.parse(session), null, 2)}\n`
    return this.enqueue(session.id, () => writeFileAtomic(this.fileFor(session.id), data))
  }

  remove(id: string): Promise<void> {
    return this.enqueue(id, () => rm(this.fileFor(id), { force: true }))
  }

  /** Valid records only; unreadable or invalid files are logged and skipped. */
  async loadAll(): Promise<Session[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    const sessions: Session[] = []
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith('.json')) {
        continue
      }
      try {
        const parsed = SessionSchema.safeParse(JSON.parse(await readFile(join(this.dir, name), 'utf8')))
        if (parsed.success && `${parsed.data.id}.json` === name) {
          sessions.push(parsed.data)
        } else {
          this.logger?.warn({ file: name }, 'Ignoring invalid session record')
        }
      } catch (error) {
        this.logger?.warn({ file: name, err: error }, 'Ignoring unreadable session record')
      }
    }
    return sessions
  }

  /** Deletes every record whose id is not in `keep`; returns the deleted ids. */
  async prune(keep: ReadonlySet<string>): Promise<string[]> {
    const removed = (await this.loadAll()).map(session => session.id).filter(id => !keep.has(id))
    await Promise.all(removed.map(id => this.remove(id)))
    return removed
  }

  /** Resolves once all queued writes have finished. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.queues.values()])
  }

  private fileFor(id: string): string {
    return join(this.dir, `${SessionIdSchema.parse(id)}.json`)
  }

  private enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    this.queues.set(id, next)
    const cleanup = (): void => {
      if (this.queues.get(id) === next) {
        this.queues.delete(id)
      }
    }
    next.then(cleanup, cleanup)
    return next
  }
}
