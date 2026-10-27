import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PathSchema } from '@agent-hub/shared'
import { AppError } from '../errors.js'

export interface Allowlist {
  /** Real path of `candidate` if it lies inside a root; throws `AppError(403, 'forbidden')` otherwise. */
  resolveInside: (candidate: string) => string
}

const forbidden = (): AppError => new AppError('Path is outside the allowed directories', 403, 'forbidden')

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}

function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

/** Resolves symlinks of the nearest existing ancestor; a dangling link on the way is rejected. */
function realpathAllowingMissing(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        throw forbidden()
      }
    }
    if (lstatExists(current)) {
      throw forbidden()
    }
    const parent = dirname(current)
    if (parent === current) {
      throw forbidden()
    }
    missing.push(basename(current))
    current = parent
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/** Roots are resolved per call, so roots created or re-linked later are honored; missing roots match nothing. */
export function createAllowlist(roots: readonly string[]): Allowlist {
  return {
    resolveInside(candidate) {
      const parsed = PathSchema.safeParse(candidate)
      if (!parsed.success || parsed.data.includes('\0')) {
        throw forbidden()
      }
      const expanded = expandHome(parsed.data)
      if (!isAbsolute(expanded)) {
        throw forbidden()
      }
      const real = realpathAllowingMissing(resolve(expanded))
      const realRoots = roots.map(root => tryRealpath(resolve(expandHome(root)))).filter(root => root !== undefined)
      if (!realRoots.some(root => isInside(real, root))) {
        throw forbidden()
      }
      return real
    },
  }
}
