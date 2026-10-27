import type { AppPane, AppTab, Layout, LayoutNode, Team, TeamMember, TeamMemberUnlinkedReason } from '@agent-hub/shared'
import { isTeamLead, MAX_PANES_PER_TAB } from '@agent-hub/shared'
import { TEAM_TAB_PREFIX } from '@/stores/tabs'
import { safeId } from './teamColor'

/** Team member shown in a pane header. */
export interface SessionMember {
  team: string
  name: string
  role: string
  /** Other members whose panes sit in the same tmux window. */
  others: string[]
}

const REASONS: Record<TeamMemberUnlinkedReason, string> = {
  'in-process': 'Runs inside the lead\'s process and has no pane of its own.',
  'no-pane': 'The team config lists no tmux pane for this member.',
  'pane-not-found': 'Its tmux pane is not on the Agent Hub tmux server (closed, or started outside Agent Hub).',
  'not-agent-hub': 'Its tmux pane belongs to a session Agent Hub does not manage.',
  'cwd-mismatch': 'Its pane id matches a session in another directory, so it was not linked.',
  'tmux-unavailable': 'The tmux server could not be reached.',
}

export function memberRole (member: Pick<TeamMember, 'agentType'>): string {
  if (isTeamLead(member)) {
    return 'Lead'
  }
  return member.agentType ?? 'Teammate'
}

/** Text for a member without a usable session. */
export function unlinkedReason (member: TeamMember, hasSession: (id: string) => boolean): string {
  const link = member.link
  if (link === undefined) {
    return 'The server did not report a pane link for this member.'
  }
  if (link.status === 'unlinked') {
    return REASONS[link.reason]
  }
  return hasSession(link.sessionId) ? '' : 'Its Agent Hub session no longer exists.'
}

/** Lead first, the rest in config order. */
function ordered (members: readonly TeamMember[]): TeamMember[] {
  return [...members.filter(member => isTeamLead(member)), ...members.filter(member => !isTeamLead(member))]
}

/** Maps Agent Hub session ids to the member shown in their pane header (the lead wins when several share one). */
export function sessionMembers (teams: readonly Team[]): Map<string, SessionMember> {
  const result = new Map<string, SessionMember>()
  for (const team of teams) {
    for (const member of ordered(team.members)) {
      if (member.link?.status !== 'linked') {
        continue
      }
      const current = result.get(member.link.sessionId)
      if (current) {
        current.others.push(member.name)
      } else {
        result.set(member.link.sessionId, { team: team.name, name: member.name, role: memberRole(member), others: [] })
      }
    }
  }
  return result
}

/** Layout for `count` panes: single, row, grid-2x2, or two stacked rows for 5 and more. */
export function teamLayout (count: number): Layout {
  if (count <= 1) {
    return { kind: 'single' }
  }
  if (count <= 3) {
    return { kind: 'row' }
  }
  if (count === 4) {
    return { kind: 'grid-2x2' }
  }
  const top = Math.ceil(count / 2)
  const row = (from: number, to: number): LayoutNode => ({
    type: 'split',
    direction: 'row',
    children: Array.from({ length: to - from }, (_, index) => ({ type: 'pane', pane: from + index })),
  })
  return { kind: 'custom', root: { type: 'split', direction: 'column', children: [row(0, top), row(top, count)] } }
}

export interface TeamTabResult {
  tab: AppTab
  /** Members left out because the tab is full. */
  dropped: string[]
}

export function teamTabId (team: string): string {
  return `${TEAM_TAB_PREFIX}${safeId(team)}`
}

/**
 * One pane per member: its session when linked, a placeholder with the reason otherwise. Members whose
 * session is already shown (teammates splitting the lead's window) get no extra pane; the header lists them.
 */
export function buildTeamTab (team: Team, hasSession: (id: string) => boolean): TeamTabResult | undefined {
  const panes: AppPane[] = []
  const dropped: string[] = []
  const shown = new Set<string>()
  for (const member of ordered(team.members)) {
    const link = member.link
    if (link?.status === 'linked' && shown.has(link.sessionId)) {
      continue
    }
    if (panes.length >= MAX_PANES_PER_TAB) {
      dropped.push(member.name)
      continue
    }
    if (link?.status === 'linked' && hasSession(link.sessionId)) {
      shown.add(link.sessionId)
      panes.push({ sessionId: link.sessionId })
    } else {
      panes.push({ placeholder: { title: `${member.name} (${memberRole(member)})`, reason: unlinkedReason(member, hasSession) } })
    }
  }
  if (panes.length === 0) {
    return undefined
  }
  return { tab: { id: teamTabId(team.name), title: team.name, layout: teamLayout(panes.length), panes }, dropped }
}
