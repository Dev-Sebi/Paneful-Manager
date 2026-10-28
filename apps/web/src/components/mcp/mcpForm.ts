import type {
  McpMaskedValue,
  McpScope,
  McpScopeKind,
  McpServerConfigInput,
  McpServerEntryMasked,
  McpTransport,
  UpsertMcpServerRequestInput,
} from '@paneful-manager/shared'
import { McpServerNameSchema, McpUrlSchema, RESERVED_MCP_NAMES } from '@paneful-manager/shared'

export interface KvRow {
  id: number
  key: string
  value: string
  /** Stored secret that is never sent back to the browser; an empty value keeps it. */
  masked: boolean
  clear: boolean
}

export interface McpFormState {
  mode: 'add' | 'edit'
  name: string
  scopeKind: McpScopeKind
  projectPath: string
  transport: McpTransport
  command: string
  argsText: string
  url: string
  rows: KvRow[]
}

export interface McpFormErrors {
  name?: string
  command?: string
  url?: string
  rows: Record<number, string>
}

let nextRowId = 1

export function newRow (key = '', value = '', masked = false): KvRow {
  return { id: nextRowId++, key, value, masked, clear: false }
}

export function emptyForm (scopeKind: McpScopeKind = 'user', projectPath = ''): McpFormState {
  return { mode: 'add', name: '', scopeKind, projectPath, transport: 'stdio', command: '', argsText: '', url: '', rows: [] }
}

function isMasked (value: string | McpMaskedValue): value is McpMaskedValue {
  return typeof value !== 'string'
}

/** Prefills an edit form; masked values stay empty so a secret never reaches an input. */
export function formFromEntry (entry: McpServerEntryMasked): McpFormState {
  const { config, scope } = entry
  const values = config.transport === 'stdio' ? config.env : config.headers
  const rows = Object.entries(values).map(([key, value]) =>
    isMasked(value) ? newRow(key, '', true) : newRow(key, value))
  return {
    mode: 'edit',
    name: entry.name,
    scopeKind: scope.kind,
    projectPath: scope.kind === 'user' ? '' : scope.projectPath,
    transport: config.transport,
    command: config.transport === 'stdio' ? config.command : '',
    argsText: config.transport === 'stdio' ? config.args.join('\n') : '',
    url: config.transport === 'stdio' ? '' : config.url,
    rows,
  }
}

export function nameError (name: string): string | undefined {
  if (name === '') {
    return undefined
  }
  const result = McpServerNameSchema.safeParse(name)
  if (result.success) {
    return undefined
  }
  const reserved = RESERVED_MCP_NAMES.some(item => item.toLowerCase() === name.toLowerCase())
  return reserved
    ? `"${name}" is reserved by Claude Code`
    : 'Use letters, digits, "_" or "-" (max 64 characters), not starting with "-"'
}

export function urlError (url: string): string | undefined {
  if (url === '') {
    return undefined
  }
  return McpUrlSchema.safeParse(url).success ? undefined : 'Enter an http(s) URL or one starting with ${VAR}'
}

export function validateForm (form: McpFormState): McpFormErrors {
  const errors: McpFormErrors = { name: form.name === '' ? 'Name is required' : nameError(form.name), rows: {} }
  if (form.transport === 'stdio') {
    errors.command = form.command.trim() === '' ? 'Command is required' : undefined
  } else {
    errors.url = form.url === '' ? 'URL is required' : urlError(form.url)
  }
  const seen = new Set<string>()
  for (const row of form.rows) {
    const key = row.key.trim()
    if (key === '') {
      if (row.value !== '') {
        errors.rows[row.id] = 'Key is required'
      }
    } else if (seen.has(key)) {
      errors.rows[row.id] = 'Duplicate key'
    }
    seen.add(key)
  }
  return errors
}

export function hasErrors (errors: McpFormErrors): boolean {
  return Boolean(errors.name ?? errors.command ?? errors.url) || Object.keys(errors.rows).length > 0
}

/** Typed value is sent as is, an empty masked value as `{ keep: true }`, a cleared row is left out. */
export function rowsToMap (rows: KvRow[]): Record<string, string | { keep: true }> {
  const map: Record<string, string | { keep: true }> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '' || row.clear) {
      continue
    }
    map[key] = row.value === '' && row.masked ? { keep: true } : row.value
  }
  return map
}

export function toScope (form: McpFormState): McpScope {
  return form.scopeKind === 'user' ? { kind: 'user' } : { kind: form.scopeKind, projectPath: form.projectPath }
}

export function buildRequest (form: McpFormState): UpsertMcpServerRequestInput {
  const map = rowsToMap(form.rows)
  const config: McpServerConfigInput = form.transport === 'stdio'
    ? {
        transport: 'stdio',
        command: form.command.trim(),
        args: form.argsText.split(/\r?\n/).map(line => line.trim()).filter(line => line !== ''),
        env: map,
      }
    : { transport: form.transport, url: form.url.trim(), headers: map }
  return { name: form.name, scope: toScope(form), config }
}

export interface ApiFieldErrors {
  name?: string
  command?: string
  url?: string
  keys: Record<string, string>
}

/** Maps `validation_failed` issues (`path`, `message`) onto form fields; unknown paths are ignored. */
export function errorsFromApi (details: unknown): ApiFieldErrors {
  const result: ApiFieldErrors = { keys: {} }
  if (!Array.isArray(details)) {
    return result
  }
  for (const issue of details as Array<{ path?: unknown, message?: unknown }>) {
    const path = Array.isArray(issue.path) ? issue.path.map(String) : []
    const message = typeof issue.message === 'string' ? issue.message : undefined
    if (!message) {
      continue
    }
    if (path[0] === 'name') {
      result.name ??= message
    } else if (path[0] === 'config' && (path[1] === 'command' || path[1] === 'url')) {
      result[path[1]] ??= message
    } else if (path[0] === 'config' && (path[1] === 'env' || path[1] === 'headers') && path[2]) {
      result.keys[path[2]] ??= message
    }
  }
  return result
}
