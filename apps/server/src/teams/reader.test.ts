import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeClaudeDir, task, writeJson } from './fixtures.js'
import { MAX_TEAM_FILE_BYTES, readTeams, resolveClaudeDir } from './reader.js'

let dir: string

beforeEach(() => {
  dir = makeClaudeDir()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const team = (name: string) => ({ config: join(dir, 'teams', name, 'config.json'), tasks: join(dir, 'tasks', name) })

describe('readTeams', () => {
  it('reads a valid team with members and derived blocked state', async () => {
    const paths = team('alpha')
    writeJson(paths.config, { name: 'alpha', members: [{ name: 'lead', agentType: 'team-lead', color: 'blue' }, { name: 'dev', unknown: 1 }] })
    writeJson(join(paths.tasks, '1.json'), task('1', { status: 'completed' }))
    writeJson(join(paths.tasks, '2.json'), task('2', { status: 'in_progress', owner: 'dev', activeForm: 'Working', blockedBy: ['1'] }))
    writeJson(join(paths.tasks, '3.json'), task('3', { blockedBy: ['2'] }))
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    expect(warnings).toEqual([])
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ name: 'alpha' })
    expect(teams[0]?.members.map(member => member.name)).toEqual(['lead', 'dev'])
    expect(teams[0]?.tasks.map(item => [item.id, item.blocked])).toEqual([['1', false], ['2', false], ['3', true]])
    expect(teams[0]?.tasks[1]).toMatchObject({ owner: 'dev', activeForm: 'Working' })
    expect(teams[0]?.tasks[0]?.updatedAt).toMatch(/^\d{4}-/)
  })

  it('sorts task ids numerically and ignores unknown fields', async () => {
    const paths = team('alpha')
    writeJson(join(paths.tasks, '10.json'), task('10', { metadata: { a: 1 }, future: true }))
    writeJson(join(paths.tasks, '2.json'), task('2'))
    const { teams } = await readTeams({ claudeDir: dir })
    expect(teams[0]?.tasks.map(item => item.id)).toEqual(['2', '10'])
    expect(teams[0]?.tasks[0]).not.toHaveProperty('metadata')
  })

  it('skips invalid JSON, missing status and mismatching names with warnings', async () => {
    const paths = team('alpha')
    writeJson(join(paths.tasks, '1.json'), '{ not json')
    writeJson(join(paths.tasks, '2.json'), { id: '2', subject: 'S' })
    writeJson(join(paths.tasks, '3.json'), task('7'))
    writeJson(join(paths.tasks, '4.json'), task('4'))
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    expect(teams[0]?.tasks.map(item => item.id)).toEqual(['7', '4'])
    expect(warnings).toEqual([
      'alpha/1.json: invalid JSON, skipped',
      'alpha/2.json: missing or invalid status, skipped',
      'alpha/3.json: file name differs from id 7, using id',
    ])
  })

  it('skips oversize files', async () => {
    const paths = team('alpha')
    writeJson(join(paths.tasks, '1.json'), JSON.stringify(task('1', { description: 'x'.repeat(MAX_TEAM_FILE_BYTES) })))
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    expect(teams[0]?.tasks).toEqual([])
    expect(warnings).toEqual(['alpha/1.json: larger than 256 KiB, skipped'])
  })

  it('skips symlinked files, symlinked directories, .highwatermark and non-json files', async () => {
    const outside = makeClaudeDir()
    try {
      writeJson(join(outside, 'secret.json'), task('99'))
      mkdirSync(join(outside, 'linked-team'))
      writeJson(join(outside, 'linked-team', '5.json'), task('5'))
      const paths = team('alpha')
      writeJson(join(paths.tasks, '1.json'), task('1'))
      writeFileSync(join(paths.tasks, '.highwatermark'), '1')
      writeFileSync(join(paths.tasks, '1.json.lock'), '')
      writeFileSync(join(paths.tasks, 'notes.txt'), 'x')
      symlinkSync(join(outside, 'secret.json'), join(paths.tasks, '99.json'))
      symlinkSync(join(outside, 'linked-team'), join(dir, 'tasks', 'linked'))
      const { teams, warnings } = await readTeams({ claudeDir: dir })
      expect(teams.map(item => item.name)).toEqual(['alpha'])
      expect(teams[0]?.tasks.map(item => item.id)).toEqual(['1'])
      expect(warnings).toEqual(['tasks/linked: not a real directory, skipped', 'alpha/99.json: not a regular file, skipped'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never follows a symlinked tasks dir even when teams/<name> is real', async () => {
    const outside = makeClaudeDir()
    try {
      writeJson(join(outside, 'stolen', '1.json'), task('1'))
      writeJson(team('x').config, { members: [{ name: 'lead' }] })
      mkdirSync(join(dir, 'tasks'), { recursive: true })
      symlinkSync(join(outside, 'stolen'), join(dir, 'tasks', 'x'))
      const { teams, warnings } = await readTeams({ claudeDir: dir })
      expect(teams).toMatchObject([{ name: 'x', tasks: [] }])
      expect(teams[0]?.members).toHaveLength(1)
      expect(warnings).toContain('tasks/x: not a real directory, skipped')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never follows a symlinked teams dir even when tasks/<name> is real', async () => {
    const outside = makeClaudeDir()
    try {
      writeJson(join(outside, 'stolen', 'config.json'), { members: [{ name: 'intruder' }] })
      writeJson(join(team('x').tasks, '1.json'), task('1'))
      mkdirSync(join(dir, 'teams'), { recursive: true })
      symlinkSync(join(outside, 'stolen'), join(dir, 'teams', 'x'))
      const { teams, warnings } = await readTeams({ claudeDir: dir })
      expect(teams).toMatchObject([{ name: 'x', members: [], tasks: [{ id: '1' }] }])
      expect(warnings).toContain('teams/x: not a real directory, skipped')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keeps unknown statuses, drops duplicate ids and duplicate members with warnings', async () => {
    const paths = team('alpha')
    writeJson(paths.config, { members: [{ name: 'lead' }, { name: 'lead' }] })
    writeJson(join(paths.tasks, '1.json'), task('1', { status: 'archived' }))
    writeJson(join(paths.tasks, '2.json'), task('1'))
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    expect(teams[0]?.members).toHaveLength(1)
    expect(teams[0]?.tasks.map(item => [item.id, item.status])).toEqual([['1', 'unknown']])
    expect(warnings).toEqual(expect.arrayContaining([
      'alpha/config.json: duplicate member lead, skipped',

      'alpha/2.json: duplicate task id 1, skipped',
    ]))
  })

  it('reads many task files in order', async () => {
    const paths = team('alpha')
    for (let index = 1; index <= 20; index += 1) {
      writeJson(join(paths.tasks, `${index}.json`), task(String(index)))
    }
    const { teams } = await readTeams({ claudeDir: dir })
    expect(teams[0]?.tasks.map(item => item.id)).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)))
  })

  it('reports lastUpdated null when nothing was read', async () => {
    mkdirSync(team('empty').tasks, { recursive: true })
    const { teams } = await readTeams({ claudeDir: dir })
    expect(teams).toMatchObject([{ name: 'empty', lastUpdated: null }])
  })

  it('lists a team without tasks dir and a tasks dir without team config', async () => {
    writeJson(team('solo').config, { members: [{ name: 'lead' }] })
    writeJson(join(team('orphan').tasks, '1.json'), task('1'))
    const { teams, warnings } = await readTeams({ claudeDir: dir })
    expect(warnings).toEqual([])
    expect(teams.map(item => [item.name, item.members.length, item.tasks.length])).toEqual([['orphan', 0, 1], ['solo', 1, 0]])
  })

  it('returns nothing for a missing claude dir', async () => {
    expect(await readTeams({ claudeDir: join(dir, 'nope') })).toEqual({ teams: [], warnings: [] })
  })
})

describe('resolveClaudeDir', () => {
  it('uses CLAUDE_CONFIG_DIR when set', () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: '/cfg/claude' })).toBe('/cfg/claude')
    expect(resolveClaudeDir({})).toMatch(/\.claude$/)
  })
})
