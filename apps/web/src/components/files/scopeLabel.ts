import type { FileEntry, Scope } from '@paneful-manager/shared'

export type FilesMode = 'skills' | 'claude-md'

/** Short scope name: "Global" or the last path segment. */
export function scopeLabel (scope: Scope): string {
  if (scope.kind === 'global') {
    return 'Global'
  }
  return scope.path.replace(/\/+$/, '').split('/').at(-1) || scope.path
}

/** Path of a skill file relative to its skill directory, e.g. `SKILL.md` or `scripts/run.sh`. */
export function skillFileLabel (entry: FileEntry): string {
  const marker = `skills/${entry.name}/`
  const index = entry.relPath.indexOf(marker)
  return index === -1 ? entry.relPath : entry.relPath.slice(index + marker.length)
}

export const CLAUDE_MD_KINDS = [
  { kind: 'claude-md', fileName: 'CLAUDE.md' },
  { kind: 'claude-local-md', fileName: 'CLAUDE.local.md' },
] as const
