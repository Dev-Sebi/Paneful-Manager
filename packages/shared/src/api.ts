import { z } from 'zod'
import { AppConfigSchema, ConfigPatchSchema } from './config.js'
import { DEFAULT_COLS, DEFAULT_COMMAND, DEFAULT_ROWS } from './defaults.js'
import { AppPaneSchema, LayoutSchema, paneListSchema } from './layout.js'
import { PresetNameSchema, WorkspacePresetSchema } from './preset.js'
import { PathSchema, ScopeSchema } from './scope.js'
import { SessionIdSchema, SessionSchema, TerminalSizeSchema } from './session.js'
import { TeamLaunchSchema, TeamTemplateNameSchema, TeamTemplateSchema } from './team-templates.js'

export const API_PREFIX = '/api'

/** REST routes; `:id` and `:name` are path params. */
export const API_ROUTES = {
  health: `${API_PREFIX}/health`,
  sessions: `${API_PREFIX}/sessions`,
  session: `${API_PREFIX}/sessions/:id`,
  presets: `${API_PREFIX}/presets`,
  preset: `${API_PREFIX}/presets/:name`,
  presetLaunch: `${API_PREFIX}/presets/:name/launch`,
  config: `${API_PREFIX}/config`,
  sessionToken: `${API_PREFIX}/session-token`,
  authChallenge: `${API_PREFIX}/auth/challenge`,
  authRegister: `${API_PREFIX}/auth/register`,
  authSession: `${API_PREFIX}/auth/session`,
  hooks: `${API_PREFIX}/hooks`,
  hooksInstall: `${API_PREFIX}/hooks/install`,
  hooksUninstall: `${API_PREFIX}/hooks/uninstall`,
  hooksStatus: `${API_PREFIX}/hooks/status`,
  scopes: `${API_PREFIX}/scopes`,
  files: `${API_PREFIX}/files`,
  fileContent: `${API_PREFIX}/files/content`,
  worktreeCopyPlan: `${API_PREFIX}/worktrees/copy-plan`,
  worktreeCopyApply: `${API_PREFIX}/worktrees/copy`,
  worktreeDiff: `${API_PREFIX}/worktrees/diff`,
  mcp: `${API_PREFIX}/mcp`,
  mcpHealth: `${API_PREFIX}/mcp/health`,
  mcpHealthAll: `${API_PREFIX}/mcp/health/all`,
  teams: `${API_PREFIX}/teams`,
  teamTemplates: `${API_PREFIX}/team-templates`,
  teamTemplate: `${API_PREFIX}/team-templates/:name`,
  teamTemplateLaunch: `${API_PREFIX}/team-templates/:name/launch`,
} as const

// Security

/** Header carrying the per-boot token on every mutating request. */
export const SESSION_TOKEN_HEADER = 'x-agent-hub-token'

/**
 * Header carrying the persisted access key (scripts) or a browser session key on every API request,
 * except health, the hook route and the device login routes.
 */
export const ACCESS_KEY_HEADER = 'x-agent-hub-key'

/** Login URL fragment parameter: `http://127.0.0.1:<port>/#login=<one-time code>`; the fragment never reaches the server. */
export const LOGIN_FRAGMENT_PARAM = 'login'

/** Prefix of the message a device signs, so its signature is valid for nothing but an Agent Hub session. */
export const DEVICE_SIGNATURE_CONTEXT = 'agent-hub.session.v1'

/** Exact bytes a device signs to answer a challenge. */
export function deviceSignatureMessage(nonce: string): string {
  return `${DEVICE_SIGNATURE_CONTEXT}\n${nonce}`
}

/** WS subprotocol echoed by the server; the client also offers `token.<token>`. */
export const WS_SUBPROTOCOL = 'agent-hub.v1'
export const WS_TOKEN_PROTOCOL_PREFIX = 'token.'

// Errors

export const ValidationIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
})
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>

export const ApiErrorCodeSchema = z.enum([
  'validation_failed',
  'bad_request',
  'unauthorized',
  'login_required',
  'forbidden',
  'not_found',
  'conflict',
  'session_spawn_failed',
  'tmux_unavailable',
  'internal',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

/** Body of every non-2xx response; `validation_failed` always lists its issues. */
export const ApiErrorSchema = z.discriminatedUnion('code', [
  z.strictObject({
    code: z.literal('validation_failed'),
    message: z.string(),
    details: z.array(ValidationIssueSchema),
  }),
  z.strictObject({
    code: ApiErrorCodeSchema.exclude(['validation_failed']),
    message: z.string(),
    details: z.unknown().optional(),
  }),
])
export type ApiError = z.infer<typeof ApiErrorSchema>

// Health

/** GET /api/health */
export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  name: z.string(),
  version: z.string(),
  protocolVersion: z.int().positive(),
  uptimeSec: z.number().nonnegative(),
  /** Whether the session engine can reach its tmux server. */
  tmux: z.enum(['available', 'unavailable']),
})
export type HealthResponse = z.infer<typeof HealthResponseSchema>

// Session token

/** GET /api/session-token; needs the access key and is only served to same-origin requests on an allowed Host. */
export const SessionTokenResponseSchema = z.strictObject({ token: z.string().min(1) })
export type SessionTokenResponse = z.infer<typeof SessionTokenResponseSchema>

// Device login (ADR 0013)

const Base64UrlSchema = z.string().regex(/^[\w-]+$/)
/** Random secrets and ids: base64url or hex, long enough to be unguessable. */
const SecretSchema = z.string().regex(/^[\w-]{32,128}$/)

/** Public half of a browser's ECDSA P-256 device key, as a minimal JWK. */
export const DevicePublicKeySchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: Base64UrlSchema.length(43),
  y: Base64UrlSchema.length(43),
})
export type DevicePublicKey = z.infer<typeof DevicePublicKeySchema>

/** GET /api/auth/challenge: a one-time nonce from this server process. */
export const AuthChallengeResponseSchema = z.strictObject({ nonce: SecretSchema })
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponseSchema>

/** POST /api/auth/register: consumes the login code from the login URL and registers the device key. */
export const RegisterDeviceRequestSchema = z.strictObject({ code: SecretSchema, publicKey: DevicePublicKeySchema })
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>
export const RegisterDeviceResponseSchema = z.strictObject({ deviceId: SecretSchema })
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>

/** POST /api/auth/session: the device signs `deviceSignatureMessage(nonce)` (ECDSA P-256, SHA-256, raw r|s, base64url). */
export const CreateAuthSessionRequestSchema = z.strictObject({
  deviceId: SecretSchema,
  nonce: SecretSchema,
  signature: Base64UrlSchema.max(128),
})
export type CreateAuthSessionRequest = z.infer<typeof CreateAuthSessionRequestSchema>
/** Short-lived session key, kept only in the page's memory and sent as `X-Agent-Hub-Key`. */
export const AuthSessionResponseSchema = z.strictObject({ key: SecretSchema, expiresInSec: z.int().positive() })
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>

// Sessions

export const SessionParamsSchema = z.strictObject({ id: SessionIdSchema })
export type SessionParams = z.infer<typeof SessionParamsSchema>

/** GET /api/sessions */
export const ListSessionsResponseSchema = z.strictObject({ sessions: z.array(SessionSchema) })
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>

/** POST /api/sessions */
/** No NUL (cannot pass through exec) and no `=` (would be read as an `env` assignment instead of the command). */
export const SessionCommandSchema = z.string().regex(/^[^\0=]+$/, 'command must be non-empty and contain no NUL or =')
export const SessionArgSchema = z.string().regex(/^[^\0]*$/, 'arguments must not contain NUL')

export const CreateSessionRequestSchema = z.strictObject({
  cwd: PathSchema,
  command: SessionCommandSchema.default(DEFAULT_COMMAND),
  args: z.array(SessionArgSchema).default(() => []),
  title: z.string().optional(),
  cols: TerminalSizeSchema.default(DEFAULT_COLS),
  rows: TerminalSizeSchema.default(DEFAULT_ROWS),
})
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type CreateSessionRequestInput = z.input<typeof CreateSessionRequestSchema>

export const CreateSessionResponseSchema = z.strictObject({ session: SessionSchema })
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

/** DELETE /api/sessions/:id kills the tmux session. */
export const KillSessionResponseSchema = z.strictObject({ id: SessionIdSchema, killed: z.literal(true) })
export type KillSessionResponse = z.infer<typeof KillSessionResponseSchema>

// Presets (contents stay loose so GET -> PUT keeps user-added keys)

export const PresetParamsSchema = z.strictObject({ name: PresetNameSchema })
export type PresetParams = z.infer<typeof PresetParamsSchema>

/** GET /api/presets */
export const ListPresetsResponseSchema = z.strictObject({ presets: z.array(WorkspacePresetSchema) })
export type ListPresetsResponse = z.infer<typeof ListPresetsResponseSchema>

/** POST /api/presets and PUT /api/presets/:name (full replace). */
export const UpsertPresetRequestSchema = z.strictObject({ preset: WorkspacePresetSchema })
export type UpsertPresetRequest = z.infer<typeof UpsertPresetRequestSchema>

/** Response of GET, POST and PUT on a single preset. */
export const PresetResponseSchema = z.strictObject({ preset: WorkspacePresetSchema })
export type PresetResponse = z.infer<typeof PresetResponseSchema>

/** DELETE /api/presets/:name */
export const DeletePresetResponseSchema = z.strictObject({ name: PresetNameSchema, deleted: z.literal(true) })
export type DeletePresetResponse = z.infer<typeof DeletePresetResponseSchema>

/** A launched preset tab: the runtime tab without its id (the web assigns one). */
export const LaunchedTabSchema = z.strictObject({
  title: z.string(),
  layout: LayoutSchema,
  panes: paneListSchema(AppPaneSchema),
})
export type LaunchedTab = z.infer<typeof LaunchedTabSchema>

/** POST /api/presets/:name/launch; one entry per preset tab, in preset order. */
export const LaunchPresetResponseSchema = z.strictObject({
  name: PresetNameSchema,
  tabs: z.array(LaunchedTabSchema).min(1),
})
export type LaunchPresetResponse = z.infer<typeof LaunchPresetResponseSchema>

// Team templates (experimental; every route answers 404 while `experimental.agentTeams` is off)

export const TeamTemplateParamsSchema = z.strictObject({ name: TeamTemplateNameSchema })
export type TeamTemplateParams = z.infer<typeof TeamTemplateParamsSchema>

/** GET /api/team-templates; `launches` lists recorded launches whose lead session is still live. */
export const ListTeamTemplatesResponseSchema = z.strictObject({
  templates: z.array(TeamTemplateSchema),
  launches: z.array(TeamLaunchSchema),
})
export type ListTeamTemplatesResponse = z.infer<typeof ListTeamTemplatesResponseSchema>

/** POST /api/team-templates and PUT /api/team-templates/:name (full replace). */
export const UpsertTeamTemplateRequestSchema = z.strictObject({ template: TeamTemplateSchema })
export type UpsertTeamTemplateRequest = z.infer<typeof UpsertTeamTemplateRequestSchema>

export const TeamTemplateResponseSchema = z.strictObject({ template: TeamTemplateSchema })
export type TeamTemplateResponse = z.infer<typeof TeamTemplateResponseSchema>

/** DELETE /api/team-templates/:name */
export const DeleteTeamTemplateResponseSchema = z.strictObject({ name: TeamTemplateNameSchema, deleted: z.literal(true) })
export type DeleteTeamTemplateResponse = z.infer<typeof DeleteTeamTemplateResponseSchema>

/** POST /api/team-templates/:name/launch; `untestedVersion` is set above the last tested Claude Code version. */
export const LaunchTeamTemplateResponseSchema = z.strictObject({
  launch: TeamLaunchSchema,
  claudeVersion: z.string(),
  untestedVersion: z.boolean(),
})
export type LaunchTeamTemplateResponse = z.infer<typeof LaunchTeamTemplateResponseSchema>

// Scopes

/** GET /api/scopes */
export const ScopesResponseSchema = z.strictObject({ scopes: z.array(ScopeSchema) })
export type ScopesResponse = z.infer<typeof ScopesResponseSchema>

// Config

/** GET /api/config */
export const GetConfigResponseSchema = z.strictObject({ config: AppConfigSchema })
export type GetConfigResponse = z.infer<typeof GetConfigResponseSchema>

/** PATCH /api/config */
export const PatchConfigRequestSchema = ConfigPatchSchema
export type PatchConfigRequest = z.infer<typeof PatchConfigRequestSchema>

/** `restartRequired` is true when a changed value (e.g. port) only applies after restart. */
export const PatchConfigResponseSchema = z.strictObject({
  config: AppConfigSchema,
  restartRequired: z.boolean(),
})
export type PatchConfigResponse = z.infer<typeof PatchConfigResponseSchema>

/** Maps zod issues to the `validation_failed` error body. */
export function toValidationError(error: z.ZodError, message = 'Request validation failed'): ApiError {
  return {
    code: 'validation_failed',
    message,
    details: error.issues.map(issue => ({
      path: issue.path.map(segment => (typeof segment === 'symbol' ? String(segment) : segment)),
      message: issue.message,
    })),
  }
}

/** Type guard for zod errors, so callers need no direct zod dependency. */
export function isZodError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError
}
