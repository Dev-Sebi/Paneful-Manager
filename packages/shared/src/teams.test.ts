import { describe, expect, it } from 'vitest'
import { ListTeamsResponseSchema, TeamMemberSchema, TeamSchema, deriveBlocked, isTeamLead, parseTeamConfig, parseTeamTask } from './teams.js'

const adrExample = {
  id: '3',
  subject: 'Write integration tests for the parser',
  description: 'Cover missing fields and unknown status values',
  activeForm: 'Writing integration tests',
  owner: 'tester',
  status: 'in_progress',
  blocks: ['5'],
  blockedBy: ['1'],
  metadata: {},
}

describe('parseTeamTask', () => {
  it('parses the ADR example and ignores unknown fields', () => {
    const result = parseTeamTask({ ...adrExample, extra: { deep: true } }, '3', '2026-01-01T00:00:00.000Z')
    expect(result.warnings).toEqual([])
    expect(result.value).toEqual({
      id: '3',
      subject: 'Write integration tests for the parser',
      description: 'Cover missing fields and unknown status values',
      activeForm: 'Writing integration tests',
      owner: 'tester',
      status: 'in_progress',
      blocks: ['5'],
      blockedBy: ['1'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('defaults optional fields and drops non-string dependency entries', () => {
    const result = parseTeamTask({ id: '1', subject: 'S', status: 'pending', blocks: ['2', 7, null], blockedBy: 'x', owner: 5 }, '1')
    expect(result.value).toEqual({ id: '1', subject: 'S', status: 'pending', blocks: ['2'], blockedBy: [] })
  })

  it.each([
    ['not an object', [1]],
    ['missing id', { subject: 'S', status: 'pending' }],
    ['numeric id', { id: 1, subject: 'S', status: 'pending' }],
    ['missing subject', { id: '1', status: 'pending' }],
    ['missing status', { id: '1', subject: 'S' }],
    ['non-string status', { id: '1', subject: 'S', status: 4 }],
  ])('skips a task with a warning: %s', (_name, raw) => {
    const result = parseTeamTask(raw, '1')
    expect(result.value).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
  })

  it('keeps a task with an unrecognized status as unknown', () => {
    const result = parseTeamTask({ id: '1', subject: 'S', status: 'deleted' }, '1')
    expect(result.value?.status).toBe('unknown')
    expect(result.warnings).toEqual([])
  })

  it('trusts the id when the file name differs and warns', () => {
    const result = parseTeamTask({ id: '9', subject: 'S', status: 'completed' }, '2')
    expect(result.value?.id).toBe('9')
    expect(result.warnings).toEqual(['2.json: file name differs from id 9, using id'])
  })
})

describe('deriveBlocked', () => {
  it('blocks tasks with an open or unknown blocker, never completed ones', () => {
    const base = { subject: 'S', blocks: [] as string[] }
    const tasks = deriveBlocked([
      { ...base, id: '1', status: 'completed', blockedBy: [] },
      { ...base, id: '2', status: 'in_progress', blockedBy: [] },
      { ...base, id: '3', status: 'pending', blockedBy: ['1'] },
      { ...base, id: '4', status: 'pending', blockedBy: ['1', '2'] },
      { ...base, id: '5', status: 'pending', blockedBy: ['404'] },
      { ...base, id: '6', status: 'completed', blockedBy: ['2'] },
    ])
    expect(tasks.map(task => task.blocked)).toEqual([false, false, false, true, true, false])
  })
})

describe('parseTeamConfig', () => {
  it('keeps named members with known string fields only', () => {
    const { members, warnings } = parseTeamConfig({
      members: [
        { name: 'lead', agentType: 'team-lead', color: 'blue', tmuxPaneId: '%1', joinedAt: 1, cwd: 5 },
        { agentType: 'x' },
        'bad',
      ],
    }, 'team')
    expect(members).toEqual([{ name: 'lead', agentType: 'team-lead', color: 'blue', tmuxPaneId: '%1' }])
    expect(warnings).toHaveLength(2)
  })

  it('returns no members and a warning without a members list', () => {
    expect(parseTeamConfig({}, 'team')).toEqual({ members: [], warnings: ['team: config has no members list'] })
    expect(parseTeamConfig(null, 'team').members).toEqual([])
  })
})

describe('schemas', () => {
  it('validates a team and the list response', () => {
    const team = {
      name: 't',
      members: [{ name: 'lead' }],
      tasks: [{ id: '1', subject: 'S', status: 'pending', blocks: [], blockedBy: [], blocked: false }],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    }
    expect(TeamSchema.safeParse({ ...team, lastUpdated: null }).success).toBe(true)
    expect(TeamSchema.safeParse(team).success).toBe(true)
    expect(ListTeamsResponseSchema.safeParse({ enabled: true, teams: [team], warnings: [] }).success).toBe(true)
    expect(ListTeamsResponseSchema.safeParse({ enabled: false, teams: [] }).success).toBe(false)
  })
})

describe('member links', () => {
  it('accepts members without a link (older servers) and both link shapes', () => {
    expect(TeamMemberSchema.safeParse({ name: 'lead' }).success).toBe(true)
    expect(TeamMemberSchema.safeParse({ name: 'lead', link: { status: 'linked', sessionId: 's1', via: 'pane' } }).success).toBe(true)
    expect(TeamMemberSchema.safeParse({ name: 'dev', link: { status: 'unlinked', reason: 'in-process' } }).success).toBe(true)
    expect(TeamMemberSchema.safeParse({ name: 'dev', link: { status: 'unlinked', reason: 'other' } }).success).toBe(false)
    expect(TeamMemberSchema.safeParse({ name: 'dev', link: { status: 'linked', via: 'pane' } }).success).toBe(false)
  })

  it('detects the lead by agent type', () => {
    expect(isTeamLead({ agentType: 'team-lead' })).toBe(true)
    expect(isTeamLead({ agentType: 'tester' })).toBe(false)
    expect(isTeamLead({})).toBe(false)
  })
})
