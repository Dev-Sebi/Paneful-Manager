import { homedir } from 'node:os'
import { join } from 'node:path'

/** Expands a leading `~` to the user's home directory. */
export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
}
