import { z } from 'zod'
import { PathSchema, ScopeKindSchema, ScopeSchema } from './scope.js'

/** Largest managed file the server reads or writes. */
export const MAX_MANAGED_FILE_BYTES = 1024 * 1024

/** Extensions allowed inside a skill directory besides `SKILL.md`. */
export const SKILL_FILE_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.py', '.ts', '.js'] as const

export const ManagedFileKindSchema = z.enum(['claude-md', 'claude-local-md', 'skill'])
export type ManagedFileKind = z.infer<typeof ManagedFileKindSchema>

/** Lowercase sha256 hex digest of the raw file bytes. */
export const FileHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'hash must be a sha256 hex digest')

/** Skill directory name: starts alphanumeric, no path separators, no leading dot. */
export const SkillNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'invalid skill name')

/**
 * A managed file. `path` is absolute and starts with `scope.path`; `relPath` is relative to it.
 * `name` is the skill name for skill files, otherwise the file name.
 */
export const FileEntrySchema = z.strictObject({
  scope: ScopeSchema,
  kind: ManagedFileKindSchema,
  path: PathSchema,
  relPath: z.string().min(1),
  name: z.string().min(1),
  size: z.int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  hash: FileHashSchema,
})
export type FileEntry = z.infer<typeof FileEntrySchema>

export const FileContentSchema = FileEntrySchema.extend({ content: z.string() })
export type FileContent = z.infer<typeof FileContentSchema>

export const FileTemplateSchema = z.enum(['empty', 'skill'])
export type FileTemplate = z.infer<typeof FileTemplateSchema>

/** GET /api/files query; both filters are optional. */
export const ListFilesQuerySchema = z.strictObject({
  scopeKind: ScopeKindSchema.optional(),
  scopePath: PathSchema.optional(),
})
export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>

export const ListFilesResponseSchema = z.strictObject({ files: z.array(FileEntrySchema) })
export type ListFilesResponse = z.infer<typeof ListFilesResponseSchema>

/** GET /api/files/content query. */
export const ReadFileQuerySchema = z.strictObject({ path: PathSchema })
export type ReadFileQuery = z.infer<typeof ReadFileQuerySchema>

export const ReadFileResponseSchema = z.strictObject({ file: FileContentSchema })
export type ReadFileResponse = z.infer<typeof ReadFileResponseSchema>

/**
 * PUT /api/files/content. `expectedHash` is the hash the edit is based on; omit it only for a new file.
 * A mismatch, or an existing file without `expectedHash`, is `409 conflict` with `FileConflictDetails`.
 */
export const WriteFileRequestSchema = z.strictObject({
  path: PathSchema,
  content: z.string(),
  expectedHash: FileHashSchema.optional(),
})
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>

export const WriteFileResponseSchema = z.strictObject({ file: FileEntrySchema })
export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>

/** `details` of a `409 conflict` on write or create; `currentHash` is null when the file is missing. */
export const FileConflictDetailsSchema = z.strictObject({ currentHash: FileHashSchema.nullable() })
export type FileConflictDetails = z.infer<typeof FileConflictDetailsSchema>

/** `details` of a `409 conflict` on deleting a skill directory that holds unmanaged entries. */
export const SkillDeleteBlockedDetailsSchema = z.strictObject({ blocked: z.array(z.string()) })
export type SkillDeleteBlockedDetails = z.infer<typeof SkillDeleteBlockedDetailsSchema>

/**
 * POST /api/files. `scopePath` must equal a discovered scope path; skills need `name`.
 * `template` defaults to `skill` for skills and `empty` otherwise.
 */
export const CreateFileRequestSchema = z
  .strictObject({
    scopePath: PathSchema,
    kind: ManagedFileKindSchema,
    name: SkillNameSchema.optional(),
    template: FileTemplateSchema.optional(),
  })
  .refine(request => request.kind !== 'skill' || request.name !== undefined, {
    message: 'name is required for skills',
    path: ['name'],
  })
  .refine(request => request.kind === 'skill' || request.name === undefined, {
    message: 'name is only allowed for skills',
    path: ['name'],
  })
  .refine(request => request.kind === 'skill' || request.template !== 'skill', {
    message: 'the skill template is only allowed for skills',
    path: ['template'],
  })
export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>

export const CreateFileResponseSchema = z.strictObject({ file: FileContentSchema })
export type CreateFileResponse = z.infer<typeof CreateFileResponseSchema>

/** DELETE /api/files/content query; `path` is a managed file or a skill directory. */
export const DeleteFileQuerySchema = z.strictObject({ path: PathSchema })
export type DeleteFileQuery = z.infer<typeof DeleteFileQuerySchema>

export const DeleteFileResponseSchema = z.strictObject({ path: PathSchema, deleted: z.literal(true) })
export type DeleteFileResponse = z.infer<typeof DeleteFileResponseSchema>

export const FileChangeEventSchema = z.enum(['change', 'add', 'unlink'])
export type FileChangeEvent = z.infer<typeof FileChangeEventSchema>
