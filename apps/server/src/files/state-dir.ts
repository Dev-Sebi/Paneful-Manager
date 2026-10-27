import { realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Scope } from '@agent-hub/shared'
import { scopeRoot } from './layout.js'

function forms(path: string): string[] {
  try {
    return [...new Set([path, realpathSync.native(path)])]
  } catch {
    return [path]
  }
}

function nearestExistingReal(path: string): string {
  let current = path
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) {
        return path
      }
      missing.push(relative(parent, current))
      current = parent
    }
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/** Backups must never land in a managed scope, where the watcher and listings would see them. */
export function assertBackupDirOutsideScopes(backupDir: string, scopes: readonly Scope[]): void {
  const candidates = [...new Set([resolve(backupDir), nearestExistingReal(resolve(backupDir))])]
  for (const scope of scopes) {
    for (const root of forms(scopeRoot(scope))) {
      if (candidates.some(candidate => isInside(candidate, root))) {
        throw new Error(`Backup directory ${backupDir} must be outside the scope ${scope.path}`)
      }
    }
  }
}
