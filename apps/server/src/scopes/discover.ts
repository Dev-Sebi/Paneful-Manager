import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AppConfig, Scope } from '@paneful-manager/shared'
import type { BaseLogger } from 'pino'
import { parseWorktreeList } from './porcelain.js'
import { runFile, type RunFn } from './run-git.js'

export interface DiscoverScopesOptions {
  config: Pick<AppConfig, 'projects'>
  env: Record<string, string | undefined>
  run?: RunFn
  logger?: Pick<BaseLogger, 'warn' | 'info'>
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function globalPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return dir ? resolve(expandHome(dir)) : join(homedir(), '.claude')
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function discoverWorktrees(
  projectPath: string,
  run: RunFn,
  logger: DiscoverScopesOptions['logger'],
): Promise<Scope[]> {
  let stdout: string
  try {
    ;({ stdout } = await run('git', ['-C', projectPath, 'worktree', 'list', '--porcelain', '-z']))
  } catch (error) {
    // Not a git repo (or git missing): only the project scope remains.
    logger?.warn({ projectPath, err: error }, 'Could not list git worktrees')
    return []
  }
  const scopes: Scope[] = []
  for (const [index, entry] of parseWorktreeList(stdout).entries()) {
    if (index === 0 || entry.bare || (await canonical(entry.path)) === projectPath) {
      continue
    }
    if (entry.prunable) {
      logger?.info({ projectPath, worktree: entry.path }, 'Skipping prunable worktree')
      continue
    }
    scopes.push({
      kind: 'worktree',
      path: entry.path,
      ...(entry.branch && !entry.detached ? { branch: entry.branch } : {}),
      projectPath,
    })
  }
  return scopes
}

/** Global scope plus one scope per configured project and each of its extra git worktrees. */
export async function discoverScopes({ config, env, run = runFile, logger }: DiscoverScopesOptions): Promise<Scope[]> {
  const scopes: Scope[] = [{ kind: 'global', path: globalPath(env) }]
  const seen = new Set<string>()
  for (const configured of config.projects) {
    const expanded = expandHome(configured.trim())
    if (!isAbsolute(expanded)) {
      logger?.warn({ project: configured }, 'Skipping non-absolute project path')
      continue
    }
    if (!(await isDirectory(expanded))) {
      logger?.warn({ projectPath: expanded }, 'Skipping missing project directory')
      continue
    }
    const projectPath = await canonical(expanded)
    if (seen.has(projectPath)) {
      continue
    }
    seen.add(projectPath)
    scopes.push({ kind: 'project', path: projectPath })
    scopes.push(...(await discoverWorktrees(projectPath, run, logger)))
  }
  return scopes
}
