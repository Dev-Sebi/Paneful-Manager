import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TeamLaunchSchema, z, type TeamLaunch } from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import { writeFileAtomic } from '../sessions/store.js'

export const TEAM_LAUNCHES_FILE_NAME = 'team-launches.json'

const TeamLaunchesSchema = z.array(TeamLaunchSchema)

/** `$STATE/team-launches.json`: lead sessions started from templates and the team name each one expects. */
export class TeamLaunchLedger {
  private readonly file: string
  private launches: TeamLaunch[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    stateDir: string,
    private readonly logger?: Pick<BaseLogger, 'warn'>,
  ) {
    this.file = join(stateDir, TEAM_LAUNCHES_FILE_NAME)
  }

  /** Reads the file; a missing or invalid file starts an empty ledger. */
  async load(): Promise<void> {
    try {
      this.launches = TeamLaunchesSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn({ err: error }, 'Ignoring invalid team launch ledger')
      }
      this.launches = []
    }
  }

  /** Launches whose lead session is still live, newest first. */
  live(isAlive: (sessionId: string) => boolean): TeamLaunch[] {
    return this.launches.filter(launch => isAlive(launch.sessionId)).toReversed()
  }

  /** Appends a launch and drops every entry whose session is no longer live. */
  record(launch: TeamLaunch, isAlive: (sessionId: string) => boolean): Promise<void> {
    this.launches = [...this.launches, launch].filter(entry => isAlive(entry.sessionId))
    return this.save()
  }

  /** Drops the launches of a deleted template. */
  forget(template: string): Promise<void> {
    this.launches = this.launches.filter(launch => launch.template !== template)
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
