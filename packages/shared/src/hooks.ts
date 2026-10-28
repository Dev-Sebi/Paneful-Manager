import { z } from 'zod'
import { API_ROUTES } from './api.js'
import { BIND_HOST } from './defaults.js'
import { PathSchema } from './scope.js'
import type { SessionState } from './session.js'

/** Header carrying the persisted hook token on `POST /api/hooks`. */
export const HOOK_TOKEN_HEADER = 'x-agent-hub-hook-token'
/** Header carrying the Agent Hub session id on `POST /api/hooks`. */
export const HOOK_SESSION_HEADER = 'x-agent-hub-session-id'

/** Environment variables every new session gets: the token through a sourced owner-only tmux file, the others through `new-session -e`. */
export const HOOK_ENV = {
  sessionId: 'AGENT_HUB_SESSION_ID',
  token: 'AGENT_HUB_HOOK_TOKEN',
  url: 'AGENT_HUB_URL',
} as const

/** Seconds Claude Code waits for the hook endpoint; failures and timeouts never block Claude Code. */
export const HOOK_TIMEOUT_SEC = 5

/** State per `Notification` type; other types change nothing. */
export const NOTIFICATION_STATES = {
  permission_prompt: 'waiting',
  elicitation_dialog: 'waiting',
  elicitation_url_dialog: 'waiting',
  idle_prompt: 'idle',
} as const satisfies Record<string, SessionState>

/** Exact-match matcher for the Notification hook entry (letters, `_` and `|` only). */
export const HOOK_NOTIFICATION_MATCHER = Object.keys(NOTIFICATION_STATES).join('|')

/**
 * State per hook event; `Notification` depends on `notification_type` and is handled in `mapHookEvent`.
 * `SessionStart` is absent because it does not support `http` hooks.
 */
export const HOOK_EVENT_STATES = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  PermissionRequest: 'waiting',
  Stop: 'idle',
  StopFailure: 'error',
  SessionEnd: 'idle',
} as const satisfies Record<string, SessionState>

/** Events the installer registers an `http` handler for. */
export const HOOK_EVENTS = [...Object.keys(HOOK_EVENT_STATES), 'Notification'] as const

/** Events after which the engine should list tmux sessions early (the command may have exited). */
export const HOOK_POLL_EVENTS: readonly string[] = ['SessionEnd']

/**
 * Claude Code hook input; only the fields Agent Hub reads are validated, everything else passes through.
 * See the hook input reference: common fields plus per-event fields such as `notification_type`.
 */
export const HookPayloadSchema = z.looseObject({
  hook_event_name: z.string().min(1),
  session_id: z.string().optional(),
  notification_type: z.string().optional(),
})
export type HookPayload = z.infer<typeof HookPayloadSchema>

function isMappedEvent(eventName: string): eventName is keyof typeof HOOK_EVENT_STATES {
  return Object.hasOwn(HOOK_EVENT_STATES, eventName)
}

/** New session state for a hook event, or `null` when the event does not change it. */
export function mapHookEvent(eventName: string, payload: { notification_type?: unknown } = {}): SessionState | null {
  if (eventName === 'Notification') {
    const type = payload.notification_type
    return typeof type === 'string' && Object.hasOwn(NOTIFICATION_STATES, type) ? NOTIFICATION_STATES[type as keyof typeof NOTIFICATION_STATES] : null
  }
  return isMappedEvent(eventName) ? HOOK_EVENT_STATES[eventName] : null
}

export function hookTriggersPoll(eventName: string): boolean {
  return HOOK_POLL_EVENTS.includes(eventName)
}

/** URL baked into the installed hook entries; its exact form identifies Agent Hub's entries. */
export function hookUrl(port: number): string {
  return `http://${BIND_HOST}:${port}${API_ROUTES.hooks}`
}

/** Matches Agent Hub's hook URL for any port, so entries from an old port are found and updated. */
export const HOOK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}\/api\/hooks$/

// REST: hook installation

/** Why session status cannot arrive from Claude Code. */
export const HookBlockCodeSchema = z.enum([
  'not_installed',
  'port_mismatch',
  'settings_invalid',
  'disable_all_hooks',
  'managed_hooks_only',
  'url_not_allowed',
  'env_vars_not_allowed',
])
export type HookBlockCode = z.infer<typeof HookBlockCodeSchema>

export const HookBlockReasonSchema = z.strictObject({
  code: HookBlockCodeSchema,
  /** Settings file the reason was found in. */
  source: PathSchema,
  message: z.string(),
})
export type HookBlockReason = z.infer<typeof HookBlockReasonSchema>

/** GET /api/hooks/status */
export const HookStatusSchema = z.strictObject({
  settingsPath: PathSchema,
  /** Every event in `HOOK_EVENTS` has an Agent Hub entry pointing at the current port. */
  installed: z.boolean(),
  /** All Agent Hub entries found point at the current port (true when none exist). */
  portMatches: z.boolean(),
  installedEvents: z.array(z.string()),
  /** Installed and no setting found that blocks the hook requests. */
  statusAvailable: z.boolean(),
  reasons: z.array(HookBlockReasonSchema),
})
export type HookStatus = z.infer<typeof HookStatusSchema>

/** POST /api/hooks/install and /api/hooks/uninstall take no options. */
export const HookChangeRequestSchema = z.strictObject({})

/** Response of install and uninstall; `changed` is false when the file already matched. */
export const HookChangeResponseSchema = z.strictObject({
  changed: z.boolean(),
  status: HookStatusSchema,
})
export type HookChangeResponse = z.infer<typeof HookChangeResponseSchema>
