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
} from '@agent-hub/shared'
import { expandHome } from '../paths.js'
import { readCurrent } from '../files/read.js'

/** Larger task or config files are skipped. */
export const MAX_TEAM_FILE_BYTES = 256 * 1024
/** Upper bound of task files read per team. */
export const MAX_TASK_FILES = 500

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

/** Real directories below `dir` (symlinks and dot entries are skipped); empty when `dir` is no real directory. */
async function listDirs(dir: string): Promise<string[]> {
  try {
    if (!(await lstat(dir)).isDirectory()) {
      return []
    }
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name)
  } catch {
    return []
  }
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
  let names: string[] = []
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
  const parsed: Array<Omit<TeamTask, 'blocked'>> = []
  let newest = 0
  for (const file of names) {
    const label = `${name}/${file}`
    const result = await readJson(join(dir, file), label)
    if (result === undefined) {
      continue
    }
    if (typeof result === 'string') {
      warnings.push(result)
      continue
    }
    newest = Math.max(newest, result.mtime.getTime())
    const item = parseTeamTask(result.value, file.slice(0, -'.json'.length), result.mtime.toISOString())
    warnings.push(...item.warnings.map(text => `${name}/${text}`))
    if (item.value) {
      parsed.push(item.value)
    }
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
  return { members: config.members, newest: result.mtime.getTime() }
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
  const names = [...new Set([...(await listDirs(teamDirs)), ...(await listDirs(taskDirs))])].sort()
  const warnings: string[] = []
  const teams: Team[] = []
  for (const name of names) {
    const { members, newest: configTime } = await readMembers(join(teamDirs, name), name, warnings)
    const { tasks, newest: taskTime } = await readTasks(join(taskDirs, name), name, warnings)
    teams.push({
      name,
      dir: join(taskDirs, name),
      members,
      tasks,
      lastUpdated: new Date(Math.max(configTime, taskTime)).toISOString(),
    })
  }
  return { teams, warnings }
}
