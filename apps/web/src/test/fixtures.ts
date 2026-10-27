import type { AppTab, McpServerEntryMasked, Session } from '@agent-hub/shared'

export function makeSession (id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    hostId: 'local',
    title: `session ${id}`,
    cwd: '/work/project',
    command: 'claude',
    args: [],
    tmuxSession: `ah-${id}`,
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

export function makeMcpEntry (name: string, overrides: Partial<McpServerEntryMasked> = {}): McpServerEntryMasked {
  return {
    name,
    scope: { kind: 'user' },
    source: 'cli',
    config: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], env: { API_KEY: { masked: true, set: true }, PATH: '/usr/bin' } },
    ...overrides,
  }
}
