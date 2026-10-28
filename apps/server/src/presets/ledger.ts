import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PresetNameSchema, SessionIdSchema, z } from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import { writeFileAtomic } from '../sessions/store.js'

export const LAUNCHES_FILE_NAME = 'preset-launches.json'

const LaunchesSchema = z.record(PresetNameSchema, z.array(SessionIdSchema))

/** `$STATE/preset-launches.json`: which sessions each preset launched, so autostart can tell a running preset from a stopped one. */
export class LaunchLedger {
  private readonly file: string
  private launches: Record<string, string[]> = {}
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    stateDir: string,
    private readonly logger?: Pick<BaseLogger, 'warn'>,
  ) {
    this.file = join(stateDir, LAUNCHES_FILE_NAME)
  }

  /** Reads the file; a missing or invalid file starts an empty ledger. */
  async load(): Promise<void> {
    try {
      this.launches = LaunchesSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ err: error }, 'Ignoring invalid preset launch ledger')
      }
      this.launches = {}
    }
  }

  sessionIds(name: string): readonly string[] {
    return this.launches[name] ?? []
  }

  /** Adds `ids` to the preset's sessions and drops every id for which `isAlive` is false. */
  record(name: string, ids: readonly string[], isAlive: (id: string) => boolean): Promise<void> {
    const kept = [...this.sessionIds(name), ...ids].filter(isAlive)
    this.launches = { ...this.launches, [name]: kept }
    return this.save()
  }

  /** Drops a preset's record, e.g. after the preset was deleted. */
  forget(name: string): Promise<void> {
    const { [name]: _removed, ...rest } = this.launches
    this.launches = rest
    return this.save()
  }

  private save(): Promise<void> {
    const data = `${JSON.stringify(this.launches, null, 2)}\n`
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await writeFileAtomic(this.file, data)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
