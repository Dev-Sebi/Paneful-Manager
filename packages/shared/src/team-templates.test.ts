import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { LaunchTeamTemplateResponseSchema } from './api.js'
import {
  buildLeadPrompt,
  compareVersions,
  MAX_TEAMMATES,
  parseClaudeVersion,
  TeamLaunchSchema,
  teamNameFor,
  TeamTemplateSchema,
} from './team-templates.js'
import { issuePaths } from './test-utils.js'

const yaml = `
name: review-team
experimental: true
lead:
  cwd: ~/git/project1
teammates:
  - name: implementer
    prompt: Implement the changes.
  - name: reviewer
    model: sonnet
    cwd: ~/git/project1/docs
    prompt: Review the changes.
`

const base = parse(yaml) as Record<string, unknown>

describe('TeamTemplateSchema', () => {
  it('parses a minimal template and fills defaults', () => {
    const template = TeamTemplateSchema.parse(base)
    expect(template.lead).toEqual({ cwd: '~/git/project1', command: 'claude', args: [] })
    expect(template.env).toEqual({})
    expect(template.teammates.map(teammate => teammate.name)).toEqual(['implementer', 'reviewer'])
  })

  it('keeps unknown keys so a GET then PUT round trip loses nothing', () => {
    expect(TeamTemplateSchema.parse({ ...base, note: 'keep' })).toMatchObject({ note: 'keep' })
  })

  it('requires the experimental marker', () => {
    expect(issuePaths(TeamTemplateSchema, { ...base, experimental: undefined })).toEqual(['experimental'])
    expect(issuePaths(TeamTemplateSchema, { ...base, experimental: false })).toEqual(['experimental'])
  })

  it('refuses env keys outside the allowlist', () => {
    expect(TeamTemplateSchema.parse({ ...base, env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }).env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })
    for (const key of ['PATH', 'LD_PRELOAD', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_TASK_LIST_ID', 'AGENT_HUB_TOKEN']) {
      expect(TeamTemplateSchema.safeParse({ ...base, env: { [key]: '1' } }).success, key).toBe(false)
    }
    expect(TeamTemplateSchema.safeParse({ ...base, env: { ANTHROPIC_MODEL: 'a\nb' } }).success).toBe(false)
  })

  it('refuses lead args the launch sets itself', () => {
    for (const arg of ['--settings', '--session-id=x', '--teammate-mode', '-p', '--print', '--resume', '--model']) {
      expect(TeamTemplateSchema.safeParse({ ...base, lead: { cwd: '/w', args: [arg] } }).success, arg).toBe(false)
    }
    expect(TeamTemplateSchema.parse({ ...base, lead: { cwd: '/w', args: ['--add-dir', '/x'] } }).lead.args).toEqual(['--add-dir', '/x'])
  })

  it('validates teammates: names, duplicates, count and prompt', () => {
    const teammate = { name: 'a', prompt: 'p' }
    expect(issuePaths(TeamTemplateSchema, { ...base, teammates: [] })).toEqual(['teammates'])
    expect(issuePaths(TeamTemplateSchema, { ...base, teammates: [teammate, teammate] })).toEqual(['teammates.1.name'])
    const many = Array.from({ length: MAX_TEAMMATES + 1 }, (_, index) => ({ name: `t${index}`, prompt: 'p' }))
    expect(issuePaths(TeamTemplateSchema, { ...base, teammates: many })).toEqual(['teammates'])
    for (const name of ['Upper', '-x', 'team-lead', 'a b', '../x']) {
      expect(TeamTemplateSchema.safeParse({ ...base, teammates: [{ name, prompt: 'p' }] }).success, name).toBe(false)
    }
    expect(issuePaths(TeamTemplateSchema, { ...base, teammates: [{ name: 'a', prompt: '  ' }] })).toEqual(['teammates.0.prompt'])
    expect(issuePaths(TeamTemplateSchema, { ...base, teammates: [{ name: 'a', prompt: 'p', model: 'opus now' }] })).toEqual(['teammates.0.model'])
  })

  it('uses the preset name rules for the template name', () => {
    for (const name of ['../evil', '.hidden', 'a.b', '', 'a'.repeat(65)]) {
      expect(TeamTemplateSchema.safeParse({ ...base, name }).success, name).toBe(false)
    }
  })
})

describe('team helpers', () => {
  it('derives the team name from the lead session id', () => {
    expect(teamNameFor('1a2b3c4d-0000-4000-8000-000000000000')).toBe('session-1a2b3c4d')
  })

  it('compares and parses versions', () => {
    expect(compareVersions('2.1.309', '2.1.309')).toBe(0)
    expect(compareVersions('2.1.310', '2.1.309')).toBe(1)
    expect(compareVersions('2.1.9', '2.1.309')).toBe(-1)
    expect(compareVersions('3.0.0', '2.9.999')).toBe(1)
    expect(parseClaudeVersion('2.1.311 (Claude Code)\n')).toBe('2.1.311')
    expect(parseClaudeVersion('unknown')).toBeUndefined()
  })

  it('builds a lead prompt that names every teammate with model, directory and goal', () => {
    const template = TeamTemplateSchema.parse({ ...base, goal: 'Ship it' })
    const prompt = buildLeadPrompt(template, path => path.replace('~', '/home/user'))
    expect(prompt).toContain('2 teammates')
    expect(prompt).toContain('- implementer: Implement the changes.')
    expect(prompt).toContain('- reviewer (model: sonnet, working directory: /home/user/git/project1/docs): Review the changes.')
    expect(prompt).toContain('Team goal: Ship it')
  })

  it('validates launch responses', () => {
    const launch = { template: 'review-team', sessionId: 'abc', team: 'session-1a2b3c4d', launchedAt: '2026-01-01T00:00:00.000Z' }
    expect(TeamLaunchSchema.parse(launch)).toEqual(launch)
    expect(TeamLaunchSchema.safeParse({ ...launch, team: 'other' }).success).toBe(false)
    expect(LaunchTeamTemplateResponseSchema.parse({ launch, claudeVersion: '2.1.311', untestedVersion: false }).launch).toEqual(launch)
  })
})
