export interface GitWorktree {
  path: string
  head?: string
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

const BRANCH_PREFIX = 'refs/heads/'

function parseBlock(block: string): GitWorktree | undefined {
  let entry: GitWorktree | undefined
  for (const line of block.split('\n')) {
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      entry = { path: value, detached: false, bare: false, locked: false, prunable: false }
    } else if (entry) {
      if (key === 'HEAD') {entry.head = value}
      else if (key === 'branch') {entry.branch = value.startsWith(BRANCH_PREFIX) ? value.slice(BRANCH_PREFIX.length) : value}
      else if (key === 'detached') {entry.detached = true}
      else if (key === 'bare') {entry.bare = true}
      else if (key === 'locked') {entry.locked = true}
      else if (key === 'prunable') {entry.prunable = true}
    }
  }
  return entry?.path ? entry : undefined
}

/** Parses `git worktree list --porcelain` output (blocks separated by blank lines). */
export function parseWorktreeList(output: string): GitWorktree[] {
  return output
    .replace(/\r\n/g, '\n')
    .split(/\n\n+/)
    .map(parseBlock)
    .filter((entry): entry is GitWorktree => entry !== undefined)
}
