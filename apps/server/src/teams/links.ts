import { isAbsolute, relative, resolve } from 'node:path'
import { isTeamLead, type Team, type TeamMember, type TeamMemberLink } from '@agent-hub/shared'
import type { TmuxPaneInfo } from '../tmux/tmux.js'

export interface LinkContext {
  /** Panes of the Agent Hub tmux server; `null` when tmux could not be queried. */
  panes: readonly TmuxPaneInfo[] | null
  /** Known Agent Hub sessions by id. */
  sessions: ReadonlyMap<string, { cwd: string }>
}

/** True when absolute `path` is `base` or below it (string comparison only, nothing is read from disk). */
function isWithin(path: string, base: string): boolean {
  if (!isAbsolute(path)) {
    return false
  }
  const rel = relative(resolve(base), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function linkByPane(member: TeamMember, paneId: string, context: LinkContext): TeamMemberLink {
  if (context.panes === null) {
    return { status: 'unlinked', reason: 'tmux-unavailable' }
  }
  const pane = context.panes.find(item => item.paneId === paneId)
  if (pane === undefined) {
    return { status: 'unlinked', reason: 'pane-not-found' }
  }
  const session = pane.sessionId === undefined ? undefined : context.sessions.get(pane.sessionId)
  if (pane.sessionId === undefined || session === undefined) {
    return { status: 'unlinked', reason: 'not-agent-hub' }
  }
  if (member.cwd !== undefined && !isWithin(member.cwd, session.cwd)) {
    return { status: 'unlinked', reason: 'cwd-mismatch' }
  }
  return { status: 'linked', sessionId: pane.sessionId, via: 'pane' }
}

/**
 * Links members to Agent Hub sessions: a member's `tmuxPaneId` must be a pane of an `ah-` session on
 * the Agent Hub tmux server whose cwd contains the member's (absolute) cwd. A lead without a pane id
 * inherits the session when all linked teammates share one (they split the lead's window) and its cwd fits.
 */
export function linkMembers(members: readonly TeamMember[], context: LinkContext): TeamMember[] {
  const linked = members.map((member): TeamMember => {
    if (!isTeamLead(member) && member.backendType === 'in-process') {
      return { ...member, link: { status: 'unlinked', reason: 'in-process' } }
    }
    if (member.tmuxPaneId === undefined) {
      return { ...member, link: { status: 'unlinked', reason: 'no-pane' } }
    }
    return { ...member, link: linkByPane(member, member.tmuxPaneId, context) }
  })
  const teammateSessions = new Set(linked.flatMap(member =>
    !isTeamLead(member) && member.link?.status === 'linked' ? [member.link.sessionId] : []))
  const [shared] = teammateSessions
  if (teammateSessions.size !== 1 || shared === undefined) {
    return linked
  }
  const sharedCwd = context.sessions.get(shared)?.cwd
  return linked.map((member): TeamMember => {
    if (!isTeamLead(member) || member.tmuxPaneId !== undefined) {
      return member
    }
    if (member.cwd !== undefined && (sharedCwd === undefined || !isWithin(member.cwd, sharedCwd))) {
      return { ...member, link: { status: 'unlinked', reason: 'cwd-mismatch' } }
    }
    return { ...member, link: { status: 'linked', sessionId: shared, via: 'lead-window' } }
  })
}

/** Applies `linkMembers` to every team. */
export function linkTeams(teams: readonly Team[], context: LinkContext): Team[] {
  return teams.map(team => ({ ...team, members: linkMembers(team.members, context) }))
}
