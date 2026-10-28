import type { AppTab, FileContent, FileEntry, McpServerEntryMasked, Scope, Session } from '@paneful-manager/shared'

export function makeSession (id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    hostId: 'local',
    title: `session ${id}`,
    cwd: '/work/project',
    command: 'claude',
    args: [],
    tmuxSession: `pm-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'idle',
    lifecycle: 'running',
    lastEventAt: '2026-01-01T00:00:00.000Z',
    cols: 80,
    rows: 24,
    ...overrides,
  }
}

export function makeTab (id: string): AppTab {
  return { id, title: `tab ${id}`, layout: { kind: 'single' }, panes: [{ sessionId: `s-${id}` }] }
}

export function jsonResponse (body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'content-type': 'application/json' } })
}

export const GLOBAL_SCOPE: Scope = { kind: 'global', path: '~/.claude' }
export const WORKTREE_SCOPE: Scope = { kind: 'worktree', path: '~/git/project1/.claude/worktrees/feat-x', branch: 'feat/x', projectPath: '~/git/project1' }

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)
export const HASH_C = 'c'.repeat(64)

/** A skill file entry; `file` is the path inside the skill folder. */
export function makeSkillEntry (name: string, scope: Scope = GLOBAL_SCOPE, file = 'SKILL.md', hash = HASH_A): FileEntry {
  return {
    scope,
    kind: 'skill',
    path: `${scope.path}/skills/${name}/${file}`,
    relPath: `.claude/skills/${name}/${file}`,
    name,
    size: 10,
    mtimeMs: 1,
    hash,
  }
}

export function makeClaudeMdEntry (scope: Scope = GLOBAL_SCOPE, kind: 'claude-md' | 'claude-local-md' = 'claude-md'): FileEntry {
  const fileName = kind === 'claude-md' ? 'CLAUDE.md' : 'CLAUDE.local.md'
  return { scope, kind, path: `${scope.path}/${fileName}`, relPath: fileName, name: fileName, size: 10, mtimeMs: 1, hash: HASH_A }
}

export function withContent (entry: FileEntry, content: string): FileContent {
  return { ...entry, content }
}

export function makeMcpEntry (name: string, overrides: Partial<McpServerEntryMasked> = {}): McpServerEntryMasked {
  return {
    name,
    scope: { kind: 'user' },
    source: 'cli',
    approved: true,
    config: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { API_KEY: { masked: true, set: true }, PATH: '/usr/bin' } },
    ...overrides,
  }
}
