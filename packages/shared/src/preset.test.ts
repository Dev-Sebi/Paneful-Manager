import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { WorkspacePresetSchema } from './preset.js'
import { issuePaths } from './test-utils.js'

const project1Yaml = `
name: project1
description: Four Claude Code sessions side by side
tabs:
  - title: project1
    layout:
      kind: row
    panes:
      - cwd: ~/git/project1
      - cwd: ~/git/project1
      - cwd: ~/git/project1
      - cwd: ~/git/project1
        command: claude
        args: [--continue]
        title: reviewer
`

describe('WorkspacePresetSchema', () => {
  it('parses the 4-pane project1 example from YAML', () => {
    const preset = WorkspacePresetSchema.parse(parse(project1Yaml))
    expect(preset.name).toBe('project1')
    expect(preset.autostart).toBe(false)
    const tab = preset.tabs[0]
    expect(tab?.layout).toEqual({ kind: 'row' })
    expect(tab?.panes).toHaveLength(4)
    expect(tab?.panes.every(pane => pane.cwd === '~/git/project1')).toBe(true)
    expect(tab?.panes[0]).toEqual({ cwd: '~/git/project1', command: 'claude', args: [] })
    expect(tab?.panes[3]?.args).toEqual(['--continue'])
  })

  it('defaults the layout to row', () => {
    const preset = WorkspacePresetSchema.parse({ name: 'p', tabs: [{ panes: [{ cwd: '~' }] }] })
    expect(preset.tabs[0]?.layout).toEqual({ kind: 'row' })
  })

  it('keeps unknown keys from user files', () => {
    const preset = WorkspacePresetSchema.parse({ name: 'p', color: 'blue', tabs: [{ panes: [{ cwd: '~', env: 'x' }] }] })
    expect(preset).toMatchObject({ color: 'blue', tabs: [{ panes: [{ env: 'x' }] }] })
  })

  it('rejects invalid presets with clear paths', () => {
    expect(issuePaths(WorkspacePresetSchema, { name: '../evil', tabs: [{ panes: [{ cwd: '~' }] }] })).toEqual(['name'])
    expect(issuePaths(WorkspacePresetSchema, { name: 'p', tabs: [] })).toEqual(['tabs'])
    expect(issuePaths(WorkspacePresetSchema, { name: 'p', autostart: 'yes', tabs: [{ panes: [{ cwd: '~' }] }] })).toEqual([
      'autostart',
    ])
    expect(issuePaths(WorkspacePresetSchema, { name: 'p', tabs: [{ panes: [{ cwd: '' }] }] })).toEqual([
      'tabs.0.panes.0.cwd',
    ])
    const sevenPanes = Array.from({ length: 7 }, () => ({ cwd: '~' }))
    expect(issuePaths(WorkspacePresetSchema, { name: 'p', tabs: [{ panes: sevenPanes }] })).toEqual(['tabs.0.panes'])
    expect(
      issuePaths(WorkspacePresetSchema, { name: 'p', tabs: [{ layout: { kind: 'single' }, panes: [{ cwd: '~' }, { cwd: '~' }] }] }),
    ).toEqual(['tabs.0.panes'])
  })

  it('accepts a custom layout tree', () => {
    const preset = WorkspacePresetSchema.parse({
      name: 'custom',
      tabs: [
        {
          layout: {
            kind: 'custom',
            root: { type: 'split', direction: 'column', children: [{ type: 'pane', pane: 1 }, { type: 'pane', pane: 0 }] },
          },
          panes: [{ cwd: '~/a' }, { cwd: '~/b' }],
        },
      ],
    })
    expect(preset.tabs[0]?.layout.kind).toBe('custom')
  })

  it('round-trips through YAML', () => {
    const preset = WorkspacePresetSchema.parse(parse(project1Yaml))
    expect(WorkspacePresetSchema.parse(parse(stringify(preset)))).toEqual(preset)
  })
})
