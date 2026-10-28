import { WorkspacePresetSchema } from '@paneful-manager/shared'
import { describe, expect, it } from 'vitest'
import { makeSession } from '@/test/fixtures'
import { emptyForm, formToPreset, presetToForm, tabsToForm, validateForm } from './presetForm'

describe('preset form', () => {
  it('round-trips a preset including unknown keys, sizes and custom layouts', () => {
    const preset = WorkspacePresetSchema.parse({
      name: 'alpha',
      note: 'keep',
      tabs: [{
        title: 't',
        extra: 1,
        layout: { kind: 'custom', root: { type: 'split', direction: 'row', children: [{ type: 'pane', pane: 0 }, { type: 'pane', pane: 1 }] } },
        panes: [{ cwd: '/a', size: 2, args: ['-x', '--y'], mine: true }, { cwd: '/b', title: 'p' }],
      }],
    })
    const result = validateForm(presetToForm(preset))
    expect(result).toEqual({ preset })
  })

  it('reports schema issues with their path', () => {
    const form = emptyForm()
    form.name = 'bad name'
    const result = validateForm(form)
    expect('issues' in result && result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['name', 'tabs.0.panes.0.cwd']))
  })

  it('rejects a layout that does not fit the pane count', () => {
    const form = emptyForm()
    form.name = 'x'
    form.tabs[0]!.layout = 'grid-2x2'
    form.tabs[0]!.panes[0]!.cwd = '/a'
    const result = validateForm(form)
    expect('issues' in result && result.issues[0]?.message).toContain('grid-2x2')
  })

  it('splits arguments by line and drops blank titles', () => {
    const form = emptyForm()
    form.name = 'x'
    form.tabs[0]!.panes[0] = { cwd: ' /a ', command: 'claude', args: '--one\n\n--two', title: ' ', extra: {} }
    const preset = formToPreset(form)
    expect(preset.tabs[0]?.panes[0]).toEqual({ cwd: '/a', command: 'claude', args: ['--one', '--two'] })
  })

  it('builds a form from open tabs and skips tabs with unknown sessions or placeholders', () => {
    const sessions = new Map([['s1', makeSession('s1', { cwd: '/w', command: 'sh', args: ['-l'], title: 'Shell' })]])
    const form = tabsToForm([
      { id: 't1', title: 'one', layout: { kind: 'single' }, panes: [{ sessionId: 's1', size: 3 }] },
      { id: 't2', title: 'two', layout: { kind: 'single' }, panes: [{ sessionId: 'gone' }] },
      { id: 'team-x', title: 'x', layout: { kind: 'row' }, panes: [{ sessionId: 's1' }, { placeholder: { title: 'dev', reason: 'No pane' } }] },
    ], sessions)
    expect(form.tabs).toHaveLength(1)
    expect(form.tabs[0]?.panes[0]).toEqual({ cwd: '/w', command: 'sh', args: '-l', title: 'Shell', extra: { size: 3 } })
  })
})
