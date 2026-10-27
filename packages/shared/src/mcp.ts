import { z } from 'zod'
import { ScopeKindSchema } from './scope.js'

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof McpTransportSchema>

const base = {
  name: z.string().min(1),
  scope: ScopeKindSchema,
}

const remote = {
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
}

/** MCP server entry; stdio servers are spawned, http/sse servers are reached by URL. */
export const McpServerSchema = z.discriminatedUnion('transport', [
  z.looseObject({
    ...base,
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default(() => []),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.looseObject({ ...base, transport: z.literal('http'), ...remote }),
  z.looseObject({ ...base, transport: z.literal('sse'), ...remote }),
])
export type McpServer = z.infer<typeof McpServerSchema>
