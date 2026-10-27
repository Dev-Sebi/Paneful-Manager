import type { z } from 'zod'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { AppConfigSchema } from './config.js'
import { WorkspacePresetSchema } from './preset.js'
import { TeamTemplateSchema } from './team-templates.js'

const examplesDir = join(import.meta.dirname, '../../../examples')
const files = readdirSync(examplesDir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => relative(examplesDir, join(entry.parentPath, entry.name)))
  .sort()

function schemaFor(file: string): z.ZodType | undefined {
  if (file === 'config.yaml') {
    return AppConfigSchema
  }
  if (file.startsWith('workspaces/') && file.endsWith('.yaml')) {
    return WorkspacePresetSchema
  }
  if (file.startsWith('teams/') && file.endsWith('.yaml')) {
    return TeamTemplateSchema
  }
  return undefined
}

describe('examples', () => {
  it('contains files', () => {
    expect(files).toContain('config.yaml')
    expect(files.some(file => file.startsWith('workspaces/'))).toBe(true)
    expect(files.some(file => file.startsWith('teams/'))).toBe(true)
  })

  it.each(files)('%s is valid', file => {
    const schema = schemaFor(file)
    expect(schema, `no schema mapped for examples/${file}`).toBeDefined()
    const result = schema?.safeParse(parse(readFileSync(join(examplesDir, file), 'utf8')))
    expect(result?.error).toBeUndefined()
    if (file.startsWith('workspaces/') || file.startsWith('teams/')) {
      expect(result?.data).toMatchObject({ name: basename(file, '.yaml') })
    }
  })
})
