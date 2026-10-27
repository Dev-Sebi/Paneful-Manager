import type { Team, TeamTask } from '@agent-hub/shared'

export function makeTask (id: string, overrides: Partial<TeamTask> = {}): TeamTask {
  return { id, subject: `Task ${id}`, status: 'pending', blocks: [], blockedBy: [], blocked: false, ...overrides }
}

export function makeTeam (name = 'session-1a2b3c4d'): Team {
  return {
    name,
    dir: `/home/user/.claude/tasks/${name}`,
    members: [
      { name: 'lead', agentType: 'team-lead', color: 'url(javascript:alert(1))' },
      { name: 'tester' },
    ],
    tasks: [
      makeTask('1', { status: 'completed' }),
      makeTask('2', { status: 'in_progress', owner: 'tester', activeForm: 'Writing tests', description: 'Cover the parser' }),
      makeTask('3', { blockedBy: ['2'], blocked: true }),
    ],
    lastUpdated: new Date().toISOString(),
  }
}
