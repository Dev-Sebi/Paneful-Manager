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

/** `approved`: Claude Code runs the entry; false for a `.mcp.json` server the user has not approved (it is never health-checked). */
export const McpServerEntryMaskedSchema = McpServerEntrySchema.extend({ config: McpServerConfigMaskedSchema, approved: z.boolean() })
export type McpServerEntryMasked = z.infer<typeof McpServerEntryMaskedSchema>

function maskMap(values: Record<string, string>): Record<string, string | McpMaskedValue> {
  const plain: readonly string[] = MCP_PLAIN_KEYS
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, plain.includes(key) ? value : { masked: true, set: value !== '' }]),
  )
}

/** Stands in for a secret part of an argument or URL in responses; sent back unchanged, it keeps the stored value. */
export const MCP_MASKED_PLACEHOLDER = '<masked>'

/** Flag, variable, header or query names whose value is treated as a secret. */
const SECRET_NAME = /token|secret|passw(?:or)?d|pwd|api[-_]?key|apikey|auth|credential|bearer|private[-_]?key|access[-_]?key|^-{0,2}key$/i
/** Well-known token formats (GitHub, GitLab, OpenAI-style, Stripe, Slack, AWS, Google, JWT), recognized without a name. */
const KNOWN_TOKEN = /^(?:gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[\w-]{20,}|[rs]k_(?:live|test)_\w{10,}|xox[abeprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|ya29\.[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*)$/
/** `$VAR` or `${VAR}`: expanded by Claude Code at run time, not a secret itself. */
const REFERENCE = /^(?:\$\{[^}]+\}|\$[A-Za-z_]\w*)$/
const URL_PREFIX = /^[a-z][a-z\d+.-]*:\/\//i
const AUTH_SCHEME = /^((?:Bearer|Basic|Token)\s+)(.+)$/i

const isSecretValue = (value: string): boolean => value !== '' && value !== MCP_MASKED_PLACEHOLDER && !REFERENCE.test(value)

/** Masks the password (or a lone user name, usually a token) in the userinfo, secret query values and token-like path segments. */
export function maskMcpUrl(url: string): string {
  const prefix = URL_PREFIX.exec(url)?.[0]
  if (prefix === undefined) {
    return url
  }
  let rest = url.slice(prefix.length)
  const at = /^([^@/?#]*)@/.exec(rest)
  if (at) {
    const userinfo = at[1] ?? ''
    const colon = userinfo.indexOf(':')
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon)
    const password = colon === -1 ? '' : userinfo.slice(colon + 1)
    const masked = colon === -1
      ? (isSecretValue(user) ? MCP_MASKED_PLACEHOLDER : user)
      : `${user}:${isSecretValue(password) ? MCP_MASKED_PLACEHOLDER : password}`
    rest = `${masked}@${rest.slice(at[0].length)}`
  }
  rest = rest.replaceAll(/\/([^/?#]+)/g, (segment, part: string) => KNOWN_TOKEN.test(part) ? `/${MCP_MASKED_PLACEHOLDER}` : segment)
  rest = rest.replaceAll(/([?&])([^=&#]+)=([^&#]*)/g, (pair, separator: string, key: string, value: string) =>
    isSecretValue(value) && (SECRET_NAME.test(key) || KNOWN_TOKEN.test(value)) ? `${separator}${key}=${MCP_MASKED_PLACEHOLDER}` : pair)
  return `${prefix}${rest}`
}

function maskNamed(value: string): string {
  if (!isSecretValue(value)) {
    return value
  }
  const scheme = AUTH_SCHEME.exec(value)
  if (scheme) {
    const secret = scheme[2] ?? ''
    return `${scheme[1] ?? ''}${isSecretValue(secret) ? MCP_MASKED_PLACEHOLDER : secret}`
  }
  return MCP_MASKED_PLACEHOLDER
}

/** A value without a secret name of its own: `Name: value` headers, URLs and well-known token formats. */
function maskUnnamed(value: string): string {
  const header = /^([A-Za-z][\w-]*):(?!\/\/)\s*(.+)$/s.exec(value)
  if (header && SECRET_NAME.test(header[1] ?? '')) {
    const secret = header[2] ?? ''
    return `${value.slice(0, value.length - secret.length)}${maskNamed(secret)}`
  }
  if (URL_PREFIX.test(value)) {
    return maskMcpUrl(value)
  }
  return isSecretValue(value) && KNOWN_TOKEN.test(value) ? MCP_MASKED_PLACEHOLDER : value
}

/**
 * Masks secret-looking parts of command arguments: values of `--token=x`, `--api-key x`, `GITHUB_TOKEN=x` and
 * `Authorization: Bearer x`, URL credentials and well-known token formats. `$VAR` references stay visible.
 */
export function maskMcpArgs(args: readonly string[]): string[] {
  const masked = [...args]
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const assignment = /^(-{0,2}[\w.-]+)=(.*)$/s.exec(arg)
    if (assignment) {
      const [, name = '', value = ''] = assignment
      masked[index] = `${name}=${SECRET_NAME.test(name) ? maskNamed(value) : maskUnnamed(value)}`
      continue
    }
    const next = args[index + 1]
    if (/^-{1,2}[\w.-]+$/.test(arg) && SECRET_NAME.test(arg) && next !== undefined && !next.startsWith('-')) {
      masked[index + 1] = maskNamed(next)
      index++
      continue
    }
    masked[index] = maskUnnamed(arg)
  }
  return masked
}

/** Replaces env and header values by `{ masked: true, set }` (except `MCP_PLAIN_KEYS`) and secret parts of args and the URL by `MCP_MASKED_PLACEHOLDER`. */
export function maskMcpEntry(entry: McpServerEntry, approved: boolean): McpServerEntryMasked {
  const { config } = entry
  const masked: McpServerConfigMasked = config.transport === 'stdio'
    ? { ...config, args: maskMcpArgs(config.args), env: maskMap(config.env) }
    : { ...config, url: maskMcpUrl(config.url), headers: maskMap(config.headers) }
  return { ...entry, config: masked, approved }
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

// Health check

export const McpHealthStatusSchema = z.enum(['ok', 'error', 'timeout', 'unsupported'])
export type McpHealthStatus = z.infer<typeof McpHealthStatusSchema>

export const MCP_HEALTH_ERROR_MAX = 200

/** POST /api/mcp/health: spawns the server (stdio) or contacts it (http, sse) and performs the `initialize` handshake. */
export const McpHealthRequestSchema = z.strictObject({ name: McpServerNameSchema, scope: McpScopeSchema })
export type McpHealthRequest = z.infer<typeof McpHealthRequestSchema>

/** `error` is scrubbed of env and header values. */
export const McpHealthResultSchema = z.strictObject({
  name: McpServerNameSchema,
  scope: McpScopeSchema,
  status: McpHealthStatusSchema,
  latencyMs: z.number().int().nonnegative().optional(),
  serverInfo: z.strictObject({ name: z.string(), version: z.string() }).optional(),
  protocolVersion: z.string().optional(),
  error: z.string().max(MCP_HEALTH_ERROR_MAX).optional(),
})
export type McpHealthResult = z.infer<typeof McpHealthResultSchema>

/** POST /api/mcp/health/all; without `projectPath` every configured project and worktree is checked. */
export const McpHealthAllRequestSchema = z.strictObject({ projectPath: PathSchema.optional() })
export type McpHealthAllRequest = z.infer<typeof McpHealthAllRequestSchema>

export const McpHealthListResponseSchema = z.strictObject({ results: z.array(McpHealthResultSchema) })
export type McpHealthListResponse = z.infer<typeof McpHealthListResponseSchema>
