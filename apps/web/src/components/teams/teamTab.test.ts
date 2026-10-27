import type { Team, TeamMember } from '@agent-hub/shared'
import { AppTabSchema } from '@agent-hub/shared'
import { describe, expect, it } from 'vitest'
import { buildTeamTab, memberRole, sessionMembers, teamLayout, unlinkedReason } from './teamTab'

function linked (name: string, sessionId: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { name, ...extra, link: { status: 'linked', sessionId, via: 'pane' } }
}
const team = (members: TeamMember[], name = 'session-1a2b3c4d'): Team => ({ name, members, tasks: [], lastUpdated: null })
const all = () => true

describe('teamLayout', () => {
  it('fits the pane count', () => {
    expect([1, 2, 3, 4].map(count => teamLayout(count).kind)).toEqual(['single', 'row', 'row', 'grid-2x2'])
    const five = teamLayout(5)
    expect(five).toMatchObject({ kind: 'custom', root: { direction: 'column', children: [{ children: { length: 3 } }, { children: { length: 2 } }] } })
  })
})

describe('buildTeamTab', () => {
  it('puts the lead first, attaches sessions and shows placeholders with reasons', () => {
    const result = buildTeamTab(team([
      linked('dev', 's2'),
      linked('lead', 's1', { agentType: 'team-lead' }),
      { name: 'helper', agentType: 'reviewer', link: { status: 'unlinked', reason: 'in-process' } },
    ]), all)
    expect(result?.tab.layout.kind).toBe('row')
    expect(result?.tab.panes).toEqual([
      { sessionId: 's1' },
      { sessionId: 's2' },
      { placeholder: { title: 'helper (reviewer)', reason: expect.stringContaining('inside the lead') } },
    ])
    expect(AppTabSchema.safeParse(result?.tab).success).toBe(true)
  })

  it('shows a shared tmux window once and placeholders for vanished sessions or older servers', () => {
    const result = buildTeamTab(team([
      linked('lead', 's1', { agentType: 'team-lead' }),
      linked('dev', 's1'),
      linked('gone', 's9'),
      { name: 'old' },
    ]), id => id === 's1')
    expect(result?.tab.panes.map(pane => pane.sessionId ?? pane.placeholder?.reason)).toEqual([
      's1',
      'Its Agent Hub session no longer exists.',
      'The server did not report a pane link for this member.',
    ])
  })

  it('caps the tab at 6 panes and reports the rest', () => {
    const members = Array.from({ length: 8 }, (_, index) => ({ name: `m${index}` }))
    const result = buildTeamTab(team(members), all)
    expect(result?.tab.panes).toHaveLength(6)
    expect(result?.dropped).toEqual(['m6', 'm7'])
    expect(AppTabSchema.safeParse(result?.tab).success).toBe(true)
  })

  it('returns nothing for a team without members and a safe tab id otherwise', () => {
    expect(buildTeamTab(team([]), all)).toBeUndefined()
    expect(buildTeamTab(team([{ name: 'a' }], 'my team/1'), all)?.tab.id).toBe('team-my_team_1')
  })
})

describe('sessionMembers', () => {
  it('maps sessions to the lead and lists the other members sharing the window', () => {
    const map = sessionMembers([team([linked('dev', 's1', { agentType: 'developer' }), linked('lead', 's1', { agentType: 'team-lead' }), linked('qa', 's2')])])
    expect(map.get('s1')).toEqual({ team: 'session-1a2b3c4d', name: 'lead', role: 'Lead', others: ['dev'] })
    expect(map.get('s2')).toMatchObject({ name: 'qa', role: 'Teammate', others: [] })
  })
})

describe('labels', () => {
  it('derives roles and reasons', () => {
    expect(memberRole({ agentType: 'team-lead' })).toBe('Lead')
    expect(memberRole({ agentType: 'tester' })).toBe('tester')
    expect(unlinkedReason(linked('a', 's1'), all)).toBe('')
    expect(unlinkedReason({ name: 'a', link: { status: 'unlinked', reason: 'tmux-unavailable' } }, all)).toContain('tmux server')
  })
})
