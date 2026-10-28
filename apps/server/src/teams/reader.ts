import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  deriveBlocked,
  parseTeamConfig,
  parseTeamTask,
  type Team,
  type TeamMember,
  type TeamTask,
} from '@paneful-manager/shared'
import { expandHome } from '../paths.js'
import { readCurrent } from '../files/read.js'

/** Larger task or config files are skipped. */
export const MAX_TEAM_FILE_BYTES = 256 * 1024
/** Upper bound of task files read per team. */
export const MAX_TASK_FILES = 500
/** Task files read in parallel per team. */
export const TASK_READ_CONCURRENCY = 8

export interface ReadTeamsOptions {
  claudeDir: string
}

export interface ReadTeamsResult {
  teams: Team[]
  warnings: string[]
}

/** `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. */
export function resolveClaudeDir(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return dir ? resolve(expandHome(dir)) : join(homedir(), '.claude')
}

interface JsonFile {
  value: unknown
  mtime: Date
}

interface DirListing {
  dirs: Set<string>
  /** Entries that are symlinks or other non-directories (not dot entries). */
  skipped: string[]
}

/** Real directories directly below `dir`, judged by `lstat` so symlinks never count; empty when `dir` is no real directory. */
async function listDirs(dir: string): Promise<DirListing> {
  const result: DirListing = { dirs: new Set(), skipped: [] }
  try {
    if (!(await lstat(dir)).isDirectory()) {
      return result
    }
    for (const entry of await readdir(dir)) {
      if (entry.startsWith('.')) {
        continue
      }
      const real = (await lstat(join(dir, entry)).catch(() => undefined))?.isDirectory() === true
      if (real) {
        result.dirs.add(entry)
      } else {
        result.skipped.push(entry)
      }
    }
  } catch {
    return result
  }
  return result
}

/** Runs `work` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Reads one JSON file through the safe reader; returns a warning text instead of throwing. */
async function readJson(path: string, label: string): Promise<JsonFile | string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) {
      return `${label}: not a regular file, skipped`
    }
    if (info.size > MAX_TEAM_FILE_BYTES) {
      return `${label}: larger than 256 KiB, skipped`
    }
    const file = await readCurrent(path)
    if (file === null) {
      return undefined
    }
    if (file.content.length > MAX_TEAM_FILE_BYTES) {
      return `${label}: larger than 256 KiB, skipped`
    }
    try {
      return { value: JSON.parse(file.content.toString('utf8')) as unknown, mtime: file.stats.mtime }
    } catch {
      return `${label}: invalid JSON, skipped`
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    return `${label}: could not be read, skipped`
  }
}

async function readTasks(dir: string, name: string, warnings: string[]): Promise<{ tasks: TeamTask[], newest: number }> {
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.') && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return { tasks: [], newest: 0 }
  }
  if (names.length > MAX_TASK_FILES) {
    warnings.push(`${name}: more than ${MAX_TASK_FILES} task files, the rest is ignored`)
    names = names.slice(0, MAX_TASK_FILES)
  }
  const results = await mapLimit(names, TASK_READ_CONCURRENCY, async file => ({ file, result: await readJson(join(dir, file), `${name}/${file}`) }))
  const parsed: Array<Omit<TeamTask, 'blocked'>> = []
  const seen = new Set<string>()
  let newest = 0
  for (const { file, result } of results) {
    if (result === undefined) {
      continue
    }
    if (typeof result === 'string') {
      warnings.push(result)
      continue
    }
    newest = Math.max(newest, result.mtime.getTime())
    const item = parseTeamTask(result.value, file.slice(0, -'.json'.length), result.mtime.toISOString(), `${name}/${file}`)
    warnings.push(...item.warnings)
    if (!item.value) {
      continue
    }
    if (seen.has(item.value.id)) {
      warnings.push(`${name}/${file}: duplicate task id ${item.value.id}, skipped`)
      continue
    }
    seen.add(item.value.id)
    parsed.push(item.value)
  }
  return { tasks: deriveBlocked(parsed), newest }
}

async function readMembers(dir: string, name: string, warnings: string[]): Promise<{ members: TeamMember[], newest: number }> {
  const result = await readJson(join(dir, 'config.json'), `${name}/config.json`)
  if (result === undefined) {
    return { members: [], newest: 0 }
  }
  if (typeof result === 'string') {
    warnings.push(result)
    return { members: [], newest: 0 }
  }
  const config = parseTeamConfig(result.value, `${name}/config.json`)
  warnings.push(...config.warnings)
  const seen = new Set<string>()
  const members = config.members.filter(member => {
    if (seen.has(member.name)) {
      warnings.push(`${name}/config.json: duplicate member ${member.name}, skipped`)
      return false
    }
    seen.add(member.name)
    return true
  })
  return { members, newest: result.mtime.getTime() }
}

/** Reads `<claudeDir>/teams/<team>/config.json` and `<claudeDir>/tasks/<team>/*.json`; never throws on bad content. */
export async function readTeams({ claudeDir }: ReadTeamsOptions): Promise<ReadTeamsResult> {
  let root: string
  try {
    root = await realpath(claudeDir)
  } catch {
    return { teams: [], warnings: [] }
  }
  const teamDirs = join(root, 'teams')
  const taskDirs = join(root, 'tasks')
  const [teamList, taskList] = await Promise.all([listDirs(teamDirs), listDirs(taskDirs)])
  const warnings: string[] = [
    ...teamList.skipped.map(entry => `teams/${entry}: not a real directory, skipped`),
    ...taskList.skipped.map(entry => `tasks/${entry}: not a real directory, skipped`),
  ]
  const names = [...new Set([...teamList.dirs, ...taskList.dirs])].sort()
  const teams: Team[] = []
  for (const name of names) {
    const { members, newest: configTime } = teamList.dirs.has(name)
      ? await readMembers(join(teamDirs, name), name, warnings)
      : { members: [], newest: 0 }
    const { tasks, newest: taskTime } = taskList.dirs.has(name)
      ? await readTasks(join(taskDirs, name), name, warnings)
      : { tasks: [], newest: 0 }
    const newest = Math.max(configTime, taskTime)
    teams.push({ name, members, tasks, lastUpdated: newest > 0 ? new Date(newest).toISOString() : null })
  }
  return { teams, warnings }
}
