import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamMember } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TmuxPaneInfo } from '../tmux/tmux.js'
import { makeClaudeDir, writeJson } from './fixtures.js'
import { linkMembers, linkTeams, type LinkContext } from './links.js'
import { readTeams } from './reader.js'

const pane = (paneId: string, sessionId: string | undefined): TmuxPaneInfo =>
  ({ paneId, sessionName: sessionId === undefined ? 'scratch' : `ah-${sessionId}`, sessionId })

const context = (panes: TmuxPaneInfo[] | null, sessions: Record<string, string> = { s1: '/work/app' }): LinkContext =>
  ({ panes, sessions: new Map(Object.entries(sessions).map(([id, cwd]) => [id, { cwd }])) })

const lead: TeamMember = { name: 'lead', agentType: 'team-lead', cwd: '/work/app' }
const linksOf = (members: TeamMember[]) => members.map(member => [member.name, member.link])

describe('linkMembers', () => {
  it('links members by pane id and lets a lead without a pane inherit the shared session', () => {
    const members = linkMembers([
      lead,
      { name: 'dev', agentType: 'developer', tmuxPaneId: '%2', backendType: 'tmux', cwd: '/work/app' },
      { name: 'tester', tmuxPaneId: '%3', cwd: '/work/app/.claude/worktrees/t1' },
    ], context([pane('%1', 's1'), pane('%2', 's1'), pane('%3', 's1')]))
    expect(linksOf(members)).toEqual([
      ['lead', { status: 'linked', sessionId: 's1', via: 'lead-window' }],
      ['dev', { status: 'linked', sessionId: 's1', via: 'pane' }],
      ['tester', { status: 'linked', sessionId: 's1', via: 'pane' }],
    ])
  })

  it('links a lead by its own pane id', () => {
    const members = linkMembers([{ ...lead, tmuxPaneId: '%1' }], context([pane('%1', 's1')]))
    expect(members[0]?.link).toEqual({ status: 'linked', sessionId: 's1', via: 'pane' })
  })

  it('reports why a member has no session', () => {
    const members = linkMembers([
      lead,
      { name: 'inproc', backendType: 'in-process' },
      { name: 'nopane' },
      { name: 'gone', tmuxPaneId: '%9' },
      { name: 'foreign', tmuxPaneId: '%4' },
      { name: 'stale', tmuxPaneId: '%5' },
      { name: 'elsewhere', tmuxPaneId: '%1', cwd: '/other/project' },
    ], context([pane('%1', 's1'), pane('%4', undefined), pane('%5', 'old')]))
    expect(linksOf(members)).toEqual([
      ['lead', { status: 'unlinked', reason: 'no-pane' }],
      ['inproc', { status: 'unlinked', reason: 'in-process' }],
      ['nopane', { status: 'unlinked', reason: 'no-pane' }],
      ['gone', { status: 'unlinked', reason: 'pane-not-found' }],
      ['foreign', { status: 'unlinked', reason: 'not-agent-hub' }],
      ['stale', { status: 'unlinked', reason: 'not-agent-hub' }],
      ['elsewhere', { status: 'unlinked', reason: 'cwd-mismatch' }],
    ])
  })

  it('does not guess the lead session when teammates sit in different sessions', () => {
    const members = linkMembers([
      lead,
      { name: 'a', tmuxPaneId: '%1' },
      { name: 'b', tmuxPaneId: '%2' },
    ], context([pane('%1', 's1'), pane('%2', 's2')], { s1: '/work/app', s2: '/work/app' }))
    expect(members[0]?.link).toEqual({ status: 'unlinked', reason: 'no-pane' })
  })

  it('marks pane members unlinked when tmux is unavailable', () => {
    const members = linkMembers([lead, { name: 'dev', tmuxPaneId: '%2' }], context(null))
    expect(linksOf(members)).toEqual([
      ['lead', { status: 'unlinked', reason: 'no-pane' }],
      ['dev', { status: 'unlinked', reason: 'tmux-unavailable' }],
    ])
  })
})

describe('linkTeams with config files on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = makeClaudeDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('links a well-formed config and tolerates malformed and missing ones', async () => {
    writeJson(join(dir, 'teams', 'alpha', 'config.json'), {
      name: 'alpha',
      leadSessionId: 'abc',
      members: [
        { agentId: 'lead@alpha', name: 'lead', agentType: 'team-lead', cwd: '/work/app', tmuxPaneId: '' },
        { agentId: 'dev@alpha', name: 'dev', agentType: 'developer', tmuxPaneId: '%2', backendType: 'tmux', cwd: '/work/app', joinedAt: 1 },
        { name: 'odd', tmuxPaneId: 42 },
        { tmuxPaneId: '%3' },
      ],
    })
    writeJson(join(dir, 'teams', 'broken', 'config.json'), '{ "members": [')
    writeJson(join(dir, 'teams', 'empty', 'config.json'), { members: 'none' })
    writeJson(join(dir, 'tasks', 'orphan', '1.json'), { id: '1', subject: 'S', status: 'pending' })
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    const linked = linkTeams(teams, context([pane('%2', 's1')]))
    expect(linked.map(team => [team.name, linksOf(team.members)])).toEqual([
      ['alpha', [
        ['lead', { status: 'linked', sessionId: 's1', via: 'lead-window' }],
        ['dev', { status: 'linked', sessionId: 's1', via: 'pane' }],
        ['odd', { status: 'unlinked', reason: 'no-pane' }],
      ]],
      ['broken', []],
      ['empty', []],
      ['orphan', []],
    ])
    expect(warnings).toEqual(expect.arrayContaining([
      'alpha/config.json: member without a name dropped',
      'broken/config.json: invalid JSON, skipped',
      'empty/config.json: config has no members list',
    ]))
  })
})
