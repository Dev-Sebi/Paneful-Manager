import { z } from 'zod'
import { PathSchema, type Scope } from './scope.js'

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof McpTransportSchema>

/** Names of Claude Code's built-in servers; Claude Code skips them in config files and `claude mcp add` rejects them. */
export const RESERVED_MCP_NAMES = ['workspace', 'claude-in-chrome', 'computer-use', 'Claude Preview', 'Claude Browser'] as const

const reserved = new Set<string>(RESERVED_MCP_NAMES.map(name => name.toLowerCase()))

/** Server name as accepted by `claude mcp add-json`; never starts with `-`, so it cannot be read as a flag. */
export const McpServerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/, 'invalid MCP server name')
  .refine(name => !reserved.has(name.toLowerCase()), 'reserved MCP server name')
export type McpServerName = z.infer<typeof McpServerNameSchema>

/** Env and header keys whose values are shown in full; every other value is masked. */
export const MCP_PLAIN_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'LOG_LEVEL'] as const

/** `http(s)` URL, or one starting with a `${VAR}` reference that Claude Code expands. */
export const McpUrlSchema = z.string().regex(/^(https?:\/\/[^\s/]+|\$\{)\S*$/i, 'url must be an http(s) URL')

const StringMapSchema = z.record(z.string().min(1), z.string())
const remote = { url: McpUrlSchema, headers: StringMapSchema.default(() => ({})) }

/** MCP server config; Claude Code stores the transport as `type`, Agent Hub as `transport`. */
export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default(() => []),
    env: StringMapSchema.default(() => ({})),
  }),
  z.strictObject({ transport: z.literal('http'), ...remote }),
  z.strictObject({ transport: z.literal('sse'), ...remote }),
])
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** Claude Code scopes: `user` and `local` live in `~/.claude.json`, `project` in `<project>/.mcp.json`. */
export const McpScopeKindSchema = z.enum(['user', 'project', 'local'])
export type McpScopeKind = z.infer<typeof McpScopeKindSchema>

export const McpScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('project'), projectPath: PathSchema }),
  z.strictObject({ kind: z.literal('local'), projectPath: PathSchema }),
])
export type McpScope = z.infer<typeof McpScopeSchema>

/**
 * Maps an Agent Hub scope to a Claude Code MCP scope: global -> user; a project or worktree -> `project`
 * (`.mcp.json`, committed) when `shared`, otherwise `local` (private, per-project section of `~/.claude.json`).
 */
export function toMcpScope(scope: Scope, shared: boolean): McpScope {
  if (scope.kind === 'global') {
    return { kind: 'user' }
  }
  return { kind: shared ? 'project' : 'local', projectPath: scope.path }
}

export const McpServerSourceSchema = z.enum(['cli', 'file'])
export type McpServerSource = z.infer<typeof McpServerSourceSchema>

/** `source` tells whether the entry was last written or read through the `claude` CLI or the files directly. */
export const McpServerEntrySchema = z.strictObject({
  name: McpServerNameSchema,
  scope: McpScopeSchema,
  config: McpServerConfigSchema,
  source: McpServerSourceSchema,
})
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>

/** Stand-in for a secret value in responses; `set` is false for an empty value. */
export const McpMaskedValueSchema = z.strictObject({ masked: z.literal(true), set: z.boolean() })
export type McpMaskedValue = z.infer<typeof McpMaskedValueSchema>

const MaskedMapSchema = z.record(z.string().min(1), z.union([z.string(), McpMaskedValueSchema]))

export const McpServerConfigMaskedSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: MaskedMapSchema,
  }),
  z.strictObject({ transport: z.literal('http'), url: McpUrlSchema, headers: MaskedMapSchema }),
  z.strictObject({ transport: z.literal('sse'), url: McpUrlSchema, headers: MaskedMapSchema }),
])
export type McpServerConfigMasked = z.infer<typeof McpServerConfigMaskedSchema>

export const McpServerEntryMaskedSchema = McpServerEntrySchema.extend({ config: McpServerConfigMaskedSchema })
export type McpServerEntryMasked = z.infer<typeof McpServerEntryMaskedSchema>

function maskMap(values: Record<string, string>): Record<string, string | McpMaskedValue> {
  const plain: readonly string[] = MCP_PLAIN_KEYS
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, plain.includes(key) ? value : { masked: true, set: value !== '' }]),
  )
}

/** Replaces env and header values by `{ masked: true, set }`, except for `MCP_PLAIN_KEYS`. */
export function maskMcpEntry(entry: McpServerEntry): McpServerEntryMasked {
  const { config } = entry
  const masked: McpServerConfigMasked = config.transport === 'stdio'
    ? { ...config, env: maskMap(config.env) }
    : { ...config, headers: maskMap(config.headers) }
  return { ...entry, config: masked }
}

// Requests and responses

/** Sent instead of a value on update: keep the stored value of this env or header key. */
export const McpKeepValueSchema = z.strictObject({ keep: z.literal(true) })
export type McpKeepValue = z.infer<typeof McpKeepValueSchema>

const InputMapSchema = z.record(z.string().min(1), z.union([z.string(), McpKeepValueSchema]))

/** Like `McpServerConfigSchema`, but env and header values may be `{ keep: true }`. */
export const McpServerConfigInputSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default(() => []),
    env: InputMapSchema.default(() => ({})),
  }),
  z.strictObject({ transport: z.literal('http'), url: McpUrlSchema, headers: InputMapSchema.default(() => ({})) }),
  z.strictObject({ transport: z.literal('sse'), url: McpUrlSchema, headers: InputMapSchema.default(() => ({})) }),
])
export type McpServerConfigInput = z.infer<typeof McpServerConfigInputSchema>

/** GET /api/mcp query; without `projectPath` every configured project and worktree is listed. */
export const ListMcpServersQuerySchema = z.strictObject({ projectPath: PathSchema.optional() })
export type ListMcpServersQuery = z.infer<typeof ListMcpServersQuerySchema>

export const McpModeSchema = z.enum(['cli', 'file'])
export type McpMode = z.infer<typeof McpModeSchema>

/** `mode` is how writes are applied right now; `cliVersion` is set in CLI mode. */
export const ListMcpServersResponseSchema = z.strictObject({
  servers: z.array(McpServerEntryMaskedSchema),
  mode: McpModeSchema,
  cliVersion: z.string().min(1).optional(),
})
export type ListMcpServersResponse = z.infer<typeof ListMcpServersResponseSchema>

/** PUT /api/mcp creates or replaces a server in one scope. */
export const UpsertMcpServerRequestSchema = z.strictObject({
  name: McpServerNameSchema,
  scope: McpScopeSchema,
  config: McpServerConfigInputSchema,
})
export type UpsertMcpServerRequest = z.infer<typeof UpsertMcpServerRequestSchema>
export type UpsertMcpServerRequestInput = z.input<typeof UpsertMcpServerRequestSchema>

export const UpsertMcpServerResponseSchema = z.strictObject({
  server: McpServerEntryMaskedSchema,
  created: z.boolean(),
})
export type UpsertMcpServerResponse = z.infer<typeof UpsertMcpServerResponseSchema>

/** DELETE /api/mcp body. */
export const RemoveMcpServerRequestSchema = z.strictObject({ name: McpServerNameSchema, scope: McpScopeSchema })
export type RemoveMcpServerRequest = z.infer<typeof RemoveMcpServerRequestSchema>

export const RemoveMcpServerResponseSchema = z.strictObject({
  name: McpServerNameSchema,
  scope: McpScopeSchema,
  removed: z.literal(true),
})
export type RemoveMcpServerResponse = z.infer<typeof RemoveMcpServerResponseSchema>
