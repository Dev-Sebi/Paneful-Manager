import { McpServerConfigSchema, type McpServerConfig } from '@paneful-manager/shared'

/** One entry under `mcpServers` in Claude Code's own format (`type` instead of `transport`). */
export type NativeServer = Record<string, unknown>

const STDIO_KEYS = ['command', 'args', 'env'] as const
const REMOTE_KEYS = ['url', 'headers'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nativeTransport(raw: NativeServer): string | undefined {
  // An entry without `type` is a stdio server for Claude Code; `streamable-http` is an alias of `http`.
  const type = raw.type ?? (raw.command === undefined ? undefined : 'stdio')
  return type === 'streamable-http' ? 'http' : typeof type === 'string' ? type : undefined
}

/** Parses a native entry; `undefined` for transports or shapes Paneful Manager does not manage (e.g. `ws`). */
export function fromNative(raw: unknown): McpServerConfig | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const transport = nativeTransport(raw)
  const candidate = transport === 'stdio'
    ? { transport, command: raw.command, args: raw.args ?? [], env: raw.env ?? {} }
    : { transport, url: raw.url, headers: raw.headers ?? {} }
  const parsed = McpServerConfigSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

/**
 * Builds the native entry for `config`. Keys Paneful Manager does not know (`oauth`, `timeout`, ...) and the key order
 * of `existing` are kept as long as the transport family (stdio vs. remote) stays the same.
 */
export function toNative(config: McpServerConfig, existing?: unknown): NativeServer {
  const stdio = config.transport === 'stdio'
  const sameFamily = isRecord(existing) && (nativeTransport(existing) === 'stdio') === stdio
  const native: NativeServer = sameFamily ? { ...existing } : {}
  for (const key of stdio ? REMOTE_KEYS : STDIO_KEYS) {
    delete native[key]
  }
  native.type = config.transport
  if (config.transport === 'stdio') {
    native.command = config.command
    native.args = config.args
    native.env = config.env
  } else {
    native.url = config.url
    if (Object.keys(config.headers).length > 0) {
      native.headers = config.headers
    } else {
      delete native.headers
    }
  }
  return native
}
