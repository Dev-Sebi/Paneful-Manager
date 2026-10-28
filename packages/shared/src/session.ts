import { z } from 'zod'
import { DEFAULT_COMMAND, DEFAULT_HOST_ID, MAX_TERMINAL_SIZE } from './defaults.js'
import { PathSchema } from './scope.js'

/** Activity state, derived from Claude Code hooks. */
export const SessionStateSchema = z.enum(['working', 'waiting', 'error', 'idle'])
export type SessionState = z.infer<typeof SessionStateSchema>

/** Process lifecycle of the tmux-hosted command. */
export const SessionLifecycleSchema = z.enum(['starting', 'running', 'exited'])
export type SessionLifecycle = z.infer<typeof SessionLifecycleSchema>

/** Server-generated ids use the base64url charset, so `pm-<id>` is always a valid tmux name. */
export const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'session id may only contain letters, digits, _ and -')

export const TerminalSizeSchema = z.int().min(1).max(MAX_TERMINAL_SIZE)

/** tmux rejects `.` and `:` in session names; keep to a safe charset. */
export const TmuxSessionNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'tmux session name may only contain letters, digits, _ and -')

export const IsoDateTimeSchema = z.iso.datetime({ offset: true })

/** One Paneful Manager session = one tmux session running one command. */
export const SessionSchema = z
  .strictObject({
    id: SessionIdSchema,
    hostId: z.string().min(1).default(DEFAULT_HOST_ID),
    title: z.string().optional(),
    cwd: PathSchema,
    command: z.string().min(1).default(DEFAULT_COMMAND),
    args: z.array(z.string()).default(() => []),
    tmuxSession: TmuxSessionNameSchema,
    createdAt: IsoDateTimeSchema,
    state: SessionStateSchema,
    lifecycle: SessionLifecycleSchema,
    exitCode: z.int().optional(),
    lastEventAt: IsoDateTimeSchema,
    /** When `state` last changed; optional only so records written before it existed still load. */
    stateSince: IsoDateTimeSchema.optional(),
    cols: TerminalSizeSchema,
    rows: TerminalSizeSchema,
  })
  .refine(session => session.exitCode === undefined || session.lifecycle === 'exited', {
    message: 'exitCode is only allowed when lifecycle is exited',
    path: ['exitCode'],
  })
export type Session = z.infer<typeof SessionSchema>
export type SessionInput = z.input<typeof SessionSchema>
