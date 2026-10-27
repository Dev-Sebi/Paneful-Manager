import { z } from 'zod'
import { FileChangeEventSchema, FileHashSchema } from './files.js'
import { PathSchema } from './scope.js'
import { IsoDateTimeSchema, SessionIdSchema, SessionLifecycleSchema, SessionSchema, SessionStateSchema, TerminalSizeSchema } from './session.js'

/** Bump on any breaking change; clients connect to `WS_PATH?v=<version>`. */
export const WS_PROTOCOL_VERSION = 1

export const WS_PATH = '/ws'

/** Terminal data is a UTF-8 string, never base64; the server decodes pty bytes with a streaming decoder. */
export const TerminalDataSchema = z.string()

// Client -> server

export const AttachMessageSchema = z.strictObject({
  type: z.literal('attach'),
  sessionId: SessionIdSchema,
  cols: TerminalSizeSchema,
  rows: TerminalSizeSchema,
  scrollback: z.boolean().default(true),
})

export const DetachMessageSchema = z.strictObject({
  type: z.literal('detach'),
  sessionId: SessionIdSchema,
})

export const InputMessageSchema = z.strictObject({
  type: z.literal('input'),
  sessionId: SessionIdSchema,
  data: TerminalDataSchema,
})

export const ResizeMessageSchema = z.strictObject({
  type: z.literal('resize'),
  sessionId: SessionIdSchema,
  cols: TerminalSizeSchema,
  rows: TerminalSizeSchema,
})

export const PingMessageSchema = z.strictObject({ type: z.literal('ping') })

export const ClientMessageSchema = z.discriminatedUnion('type', [
  AttachMessageSchema,
  DetachMessageSchema,
  InputMessageSchema,
  ResizeMessageSchema,
  PingMessageSchema,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type ClientMessageInput = z.input<typeof ClientMessageSchema>
export type ClientMessageType = ClientMessage['type']

// Server -> client

export const OutputMessageSchema = z.strictObject({
  type: z.literal('output'),
  sessionId: SessionIdSchema,
  data: TerminalDataSchema,
})

/** Sent once after `attach` when scrollback was requested, before any `output`. */
export const ScrollbackMessageSchema = z.strictObject({
  type: z.literal('scrollback'),
  sessionId: SessionIdSchema,
  data: TerminalDataSchema,
})

export const StateMessageSchema = z
  .strictObject({
    type: z.literal('state'),
    sessionId: SessionIdSchema,
    state: SessionStateSchema,
    lifecycle: SessionLifecycleSchema,
    exitCode: z.int().optional(),
    /** When `state` last changed; the UI derives its elapsed timer from it. */
    stateSince: IsoDateTimeSchema.optional(),
  })
  .refine(message => message.exitCode === undefined || message.lifecycle === 'exited', {
    message: 'exitCode is only allowed when lifecycle is exited',
    path: ['exitCode'],
  })

export const SessionCreatedMessageSchema = z.strictObject({
  type: z.literal('session.created'),
  session: SessionSchema,
})

export const SessionRemovedMessageSchema = z.strictObject({
  type: z.literal('session.removed'),
  sessionId: SessionIdSchema,
})

export const WsErrorCodeSchema = z.enum([
  'bad_message',
  'protocol_mismatch',
  'unknown_session',
  'not_attached',
  'tmux_unavailable',
  'internal',
])
export type WsErrorCode = z.infer<typeof WsErrorCodeSchema>

export const ErrorMessageSchema = z.strictObject({
  type: z.literal('error'),
  sessionId: SessionIdSchema.optional(),
  code: WsErrorCodeSchema,
  message: z.string(),
})

export const PongMessageSchema = z.strictObject({ type: z.literal('pong') })

/** A managed file changed on disk; `hash` is set for `add`/`change` when the file could be read. */
export const FileChangedMessageSchema = z
  .strictObject({
    type: z.literal('file.changed'),
    path: PathSchema,
    event: FileChangeEventSchema,
    hash: FileHashSchema.optional(),
  })
  .refine(message => message.hash === undefined || message.event !== 'unlink', {
    message: 'hash is not allowed for unlink',
    path: ['hash'],
  })
export type FileChangedMessage = z.infer<typeof FileChangedMessageSchema>

export const ServerMessageSchema = z.discriminatedUnion('type', [
  OutputMessageSchema,
  ScrollbackMessageSchema,
  StateMessageSchema,
  SessionCreatedMessageSchema,
  SessionRemovedMessageSchema,
  ErrorMessageSchema,
  PongMessageSchema,
  FileChangedMessageSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
export type ServerMessageType = ServerMessage['type']

export type WsParseResult<T> = { success: true; data: T } | { success: false; error: string }

function parseFrame<T>(schema: z.ZodType<T>, raw: string): WsParseResult<T> {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { success: false, error: 'frame is not valid JSON' }
  }
  const result = schema.safeParse(json)
  return result.success ? { success: true, data: result.data } : { success: false, error: z.prettifyError(result.error) }
}

/** Parses one text frame received by the server. */
export function parseClientMessage(raw: string): WsParseResult<ClientMessage> {
  return parseFrame(ClientMessageSchema, raw)
}

/** Parses one text frame received by the client. */
export function parseServerMessage(raw: string): WsParseResult<ServerMessage> {
  return parseFrame(ServerMessageSchema, raw)
}
