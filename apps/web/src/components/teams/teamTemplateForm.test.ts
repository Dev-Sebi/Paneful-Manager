import { TeamTemplateSchema } from '@paneful-manager/shared'
import { describe, expect, it } from 'vitest'
import { emptyTemplateForm, formToTemplate, templateToForm, validateTemplateForm } from './teamTemplateForm'

describe('team template form', () => {
  it('round-trips a template including unknown keys', () => {
    const template = TeamTemplateSchema.parse({
      name: 'alpha',
      experimental: true,
      note: 'keep',
      goal: 'Ship it',
      lead: { cwd: '/w', args: ['--add-dir', '/x'], model: 'opus', extra: 1 },
      teammates: [{ name: 'tester', prompt: 'Test', model: 'sonnet', cwd: '/w/t', color: 'blue' }],
      env: { DISABLE_TELEMETRY: '1' },
    })
    const form = templateToForm(template)
    expect(form.leadArgs).toBe('--add-dir\n/x')
    expect(form.env).toBe('DISABLE_TELEMETRY=1')
    expect(validateTemplateForm(form)).toEqual({ template })
  })

  it('reports schema issues for an empty form and refused env keys', () => {
    const form = emptyTemplateForm()
    const result = validateTemplateForm(form)
    expect('issues' in result && result.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['name', 'lead.cwd', 'teammates.0.name']))
    form.name = 'alpha'
    form.leadCwd = '/w'
    form.teammates = [{ name: 'tester', prompt: 'p', model: '', cwd: '', extra: {} }]
    form.env = 'PATH=/tmp'
    const env = validateTemplateForm(form)
    expect('issues' in env && env.issues.map(issue => issue.path)).toEqual(['env'])
  })

  it('omits empty optional fields and always marks the template experimental', () => {
    const form = emptyTemplateForm()
    form.name = 'alpha'
    expect(formToTemplate(form)).toMatchObject({ experimental: true, lead: { command: 'claude', args: [] }, env: {} })
    expect(formToTemplate(form)).not.toHaveProperty('description')
  })
})
