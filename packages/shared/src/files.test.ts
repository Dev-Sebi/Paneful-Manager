import { describe, expect, it } from 'vitest'
import { API_ROUTES } from './api.js'
import {
  CreateFileRequestSchema,
  DeleteFileQuerySchema,
  FileConflictDetailsSchema,
  FileContentSchema,
  FileEntrySchema,
  ListFilesQuerySchema,
  ReadFileQuerySchema,
  SkillNameSchema,
  WriteFileRequestSchema,
} from './files.js'
import { issuePaths } from './test-utils.js'

const HASH = 'ab'.repeat(32)

const entry = {
  scope: { kind: 'project', path: '/home/user/git/project1' },
  kind: 'skill',
  path: '/home/user/git/project1/.claude/skills/review/SKILL.md',
  relPath: '.claude/skills/review/SKILL.md',
  name: 'review',
  size: 12,
  mtimeMs: 1_700_000_000_000.5,
  hash: HASH,
}

describe('file contracts', () => {
  it('has REST routes', () => {
    expect(API_ROUTES.files).toBe('/api/files')
    expect(API_ROUTES.fileContent).toBe('/api/files/content')
  })

  it('round-trips entries and content', () => {
    expect(FileEntrySchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry)
    const content = { ...entry, content: '# Review\n' }
    expect(FileContentSchema.parse(content)).toEqual(content)
  })

  it('rejects bad entries', () => {
    expect(issuePaths(FileEntrySchema, { ...entry, kind: 'settings' })).toEqual(['kind'])
    expect(issuePaths(FileEntrySchema, { ...entry, hash: HASH.toUpperCase() })).toEqual(['hash'])
    expect(issuePaths(FileEntrySchema, { ...entry, size: -1 })).toEqual(['size'])
    expect(issuePaths(FileEntrySchema, { ...entry, extra: 1 })).toEqual([''])
  })

  it('validates list and read queries', () => {
    expect(ListFilesQuerySchema.parse({})).toEqual({})
    expect(ListFilesQuerySchema.parse({ scopeKind: 'global' })).toEqual({ scopeKind: 'global' })
    expect(issuePaths(ListFilesQuerySchema, { scopeKind: 'team' })).toEqual(['scopeKind'])
    expect(issuePaths(ReadFileQuerySchema, { path: ' ' })).toEqual(['path'])
    expect(issuePaths(DeleteFileQuerySchema, {})).toEqual(['path'])
  })

  it('validates writes', () => {
    expect(WriteFileRequestSchema.parse({ path: '/p/CLAUDE.md', content: '' })).toEqual({ path: '/p/CLAUDE.md', content: '' })
    expect(issuePaths(WriteFileRequestSchema, { path: '/p/CLAUDE.md', content: 'x', expectedHash: 'abc' })).toEqual(['expectedHash'])
    expect(issuePaths(WriteFileRequestSchema, { path: '/p/CLAUDE.md' })).toEqual(['content'])
  })

  it('validates creates', () => {
    expect(CreateFileRequestSchema.parse({ scopePath: '/p', kind: 'skill', name: 'my-skill', template: 'skill' }).name).toBe('my-skill')
    expect(CreateFileRequestSchema.parse({ scopePath: '/p', kind: 'claude-md' }).kind).toBe('claude-md')
    expect(issuePaths(CreateFileRequestSchema, { scopePath: '/p', kind: 'skill' })).toEqual(['name'])
    expect(issuePaths(CreateFileRequestSchema, { scopePath: '/p', kind: 'claude-md', name: 'x' })).toEqual(['name'])
    expect(issuePaths(CreateFileRequestSchema, { scopePath: '/p', kind: 'claude-md', template: 'skill' })).toEqual(['template'])
  })

  it('rejects skill names that could escape the skills directory', () => {
    for (const name of ['..', '.hidden', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a..b', 'node_modules']) {
      expect(SkillNameSchema.safeParse(name).success).toBe(false)
    }
    expect(SkillNameSchema.parse('my_skill.v2')).toBe('my_skill.v2')
  })

  it('allows a null current hash in conflict details', () => {
    expect(FileConflictDetailsSchema.parse({ currentHash: null })).toEqual({ currentHash: null })
  })
})
