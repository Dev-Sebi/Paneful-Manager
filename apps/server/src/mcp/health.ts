import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import {
  MCP_HEALTH_ERROR_MAX,
  z,
  type McpHealthResult,
  type McpHealthStatus,
  type McpServerEntry,
} from '@agent-hub/shared'
import type { BaseLogger } from 'pino'
import { BASE_ENV_KEYS } from '../process/exec.js'
import { scrub } from './cli.js'

export const HEALTH_TIMEOUT_MS = 8000
export const HEALTH_MAX_CONCURRENT = 4
export const HEALTH_MAX_OUTPUT_BYTES = 64 * 1024
const KILL_GRACE_MS = 1000
const MCP_PROTOCOL_VERSION = '2025-06-18'
const INITIALIZE_ID = 1

/** An entry plus whether Claude Code approved it; unapproved entries are never run. */
export type HealthTarget = McpServerEntry & { approved: boolean }

export type HealthEnv = Record<string, string | undefined>

export interface HealthOptions {
  logger?: Pick<BaseLogger, 'warn'>
  timeoutMs?: number
  /** Source of `${VAR}` references and of the base env of stdio servers; defaults to `process.env`. */
  env?: HealthEnv
  /** Working directory of user-scope stdio servers; defaults to the home directory. */
  home?: string
}

type ResolvedOptions = Required<Omit<HealthOptions, 'logger'>> & Pick<HealthOptions, 'logger'> & { missing: Set<string> }

export const NOT_APPROVED_ERROR = 'not approved in Claude Code'

interface Outcome {
  status: McpHealthStatus
  serverInfo?: { name: string; version: string }
  protocolVersion?: string
  error?: string
}

const failure = (error: string): Outcome => ({ status: 'error', error })

const MessageSchema = z.looseObject({
  method: z.string().optional(),
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }).optional(),
})

const InitializeResultSchema = z.looseObject({
  protocolVersion: z.string().min(1),
  serverInfo: z.looseObject({ name: z.string(), version: z.string().optional() }).optional(),
})

const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|KEY|AUTH/i

export interface ExpandOptions {
  /** Credential-named variables (TOKEN, SECRET, PASSWORD, KEY, AUTH) expand to an empty string; used for remote url and headers. */
  blankCredentials?: boolean
  /** Receives the names of unset variables without default, which stay as literal text. */
  missing?: Set<string>
}

/** Replaces `${VAR}` and `${VAR:-default}`; an unset variable without default keeps its literal text. */
export function expandVars(value: string, env: HealthEnv, { blankCredentials = false, missing }: ExpandOptions = {}): string {
  return value.replace(VAR_PATTERN, (match, name: string, fallback: string | undefined) => {
    if (blankCredentials && CREDENTIAL_NAME.test(name)) {
      return ''
    }
    const found = env[name]
    if (found === undefined && fallback === undefined) {
      missing?.add(name)
      return match
    }
    return found !== undefined && found !== '' ? found : (fallback ?? '')
  })
}

function expandMap(values: Record<string, string>, env: HealthEnv, options: ExpandOptions = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandVars(value, env, options)]))
}

const initializeMessage = (): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: INITIALIZE_ID,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'agent-hub', version: '0.0.0' } },
  })

const initializedMessage = (): string => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })

/** `undefined` when the message is not the answer to `initialize` (notification, other id). */
function interpret(value: unknown): Outcome | undefined {
  const message = MessageSchema.safeParse(value)
  if (!message.success) {
    return failure('Invalid JSON-RPC message')
  }
  if (message.data.method !== undefined || message.data.id !== INITIALIZE_ID) {
    return undefined
  }
  const { error, result } = message.data
  if (error) {
    return failure(`JSON-RPC error${error.code === undefined ? '' : ` ${error.code}`}: ${error.message ?? 'unknown'}`)
  }
  const parsed = InitializeResultSchema.safeParse(result)
  if (!parsed.success) {
    return failure('Invalid initialize result')
  }
  const { protocolVersion, serverInfo } = parsed.data
  return {
    status: 'ok',
    protocolVersion,
    ...(serverInfo ? { serverInfo: { name: serverInfo.name, version: serverInfo.version ?? '' } } : {}),
  }
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

// stdio

type StdioConfig = Extract<McpServerEntry['config'], { transport: 'stdio' }>

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/
const DANGEROUS_ENV_KEY = /^(LD_|DYLD_)|^(NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PERL5OPT|RUBYOPT)$/

/** Drops keys that can inject code into the child or are not plain upper-case names. */
export function filterEnv(values: Record<string, string>): { kept: Record<string, string>; dropped: string[] } {
  const kept: Record<string, string> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (ENV_KEY.test(key) && !DANGEROUS_ENV_KEY.test(key)) {
      kept[key] = value
    } else {
      dropped.push(key)
    }
  }
  return { kept, dropped }
}

function baseEnv(env: HealthEnv): Record<string, string> {
  return Object.fromEntries(BASE_ENV_KEYS.flatMap(key => (env[key] === undefined ? [] : [[key, env[key]]])))
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

/** SIGTERM now, SIGKILL after the grace period; the caller does not wait for it. */
function terminateGroup(child: ChildProcess): void {
  child.stdin?.end()
  signalGroup(child.pid, 'SIGTERM')
  const { pid } = child
  setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref()
}

function checkStdio(entry: HealthTarget, config: StdioConfig, options: ResolvedOptions, signal: AbortSignal): Promise<Outcome> {
  const { env, home } = options
  const { kept, dropped } = filterEnv(expandMap(config.env, env, { missing: options.missing }))
  if (dropped.length > 0) {
    options.logger?.warn({ name: entry.name, keys: dropped }, 'Dropped unsafe env keys of MCP server')
  }
  const cwd = entry.scope.kind === 'user' ? home : entry.scope.projectPath
  return new Promise(resolve => {
    let settled = false
    let stdoutBytes = 0
    let pending = ''
    let stderr = ''
    const child = spawn(
      expandVars(config.command, env, { missing: options.missing }),
      config.args.map(arg => expandVars(arg, env, { missing: options.missing })),
      { cwd, env: { ...baseEnv(env), ...kept }, detached: true, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const finish = (outcome: Outcome): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (outcome.status === 'ok' && child.stdin.writable) {
        child.stdin.write(`${initializedMessage()}\n`)
      }
      terminateGroup(child)
      resolve(outcome)
    }
    const onAbort = (): void => finish({ status: 'timeout' })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    child.stdin.on('error', () => undefined)
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < HEALTH_MAX_OUTPUT_BYTES) {
        stderr = (stderr + chunk.toString('utf8')).slice(0, HEALTH_MAX_OUTPUT_BYTES)
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > HEALTH_MAX_OUTPUT_BYTES) {
        finish(failure('Server output exceeded 64 KiB'))
        return
      }
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') {
          continue
        }
        const json = parseJson(line)
        if (!json) {
          finish(failure('Server wrote invalid JSON to stdout'))
          return
        }
        const outcome = interpret(json.value)
        if (outcome) {
          finish(outcome)
          return
        }
      }
    })
    child.once('error', error => finish(failure(`Could not start server: ${error.message}`)))
    child.once('close', (code, exitSignal) => {
      const detail = stderr.trim()
      const how = code === null ? `was killed by ${exitSignal}` : `exited with code ${code}`
      finish(failure(`Server ${how} before answering${detail === '' ? '' : `: ${detail}`}`))
    })
    child.stdin.write(`${initializeMessage()}\n`)
  })
}

// http and sse

interface SseEvent {
  event: string
  data: string
}

/** Yields complete SSE events; ends with the stream and throws when the byte cap is exceeded. */
async function* readEvents(response: Response, signal: AbortSignal): AsyncGenerator<SseEvent> {
  if (!response.body) {
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      total += value.length
      if (total > HEALTH_MAX_OUTPUT_BYTES) {
        throw new Error('Server output exceeded 64 KiB')
      }
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            data.push(line.slice(5).replace(/^ /, ''))
          }
        }
        if (data.length > 0 || event !== 'message') {
          yield { event, data: data.join('\n') }
        }
        end = buffer.indexOf('\n\n')
      }
      signal.throwIfAborted()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function readText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return text + decoder.decode()
      }
      total += value.length
      if (total > HEALTH_MAX_OUTPUT_BYTES) {
        throw new Error('Server output exceeded 64 KiB')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** First `data` event that answers `initialize`; undefined when the stream ends without one. */
async function answerFromEvents(response: Response, signal: AbortSignal): Promise<Outcome | undefined> {
  for await (const event of readEvents(response, signal)) {
    if (event.event !== 'message') {
      continue
    }
    const json = parseJson(event.data)
    if (!json) {
      return failure('Server sent invalid JSON')
    }
    const outcome = interpret(json.value)
    if (outcome) {
      return outcome
    }
  }
  return undefined
}

/** `lenient`: a body that is not an answer (e.g. `Accepted`) means "keep waiting" instead of an error. */
async function answerFromJson(response: Response, lenient = false): Promise<Outcome | undefined> {
  const text = (await readText(response)).trim()
  if (text === '') {
    return undefined
  }
  const json = parseJson(text)
  if (lenient) {
    return json ? interpret(json.value) : undefined
  }
  return json ? (interpret(json.value) ?? failure('Server did not answer initialize')) : failure('Server sent invalid JSON')
}

function requestHeaders(headers: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  return { ...headers, ...extra }
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error) {
      const code = 'code' in cause && typeof cause.code === 'string' ? `${cause.code}: ` : ''
      return `Connection failed (${code}${cause.message})`
    }
    return error.message
  }
  return 'Request failed'
}

async function checkHttp(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Outcome> {
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(headers, { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
    body: initializeMessage(),
    signal,
    redirect: 'manual',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return failure(`HTTP ${response.status}`)
  }
  const sessionId = response.headers.get('mcp-session-id')
  const contentType = response.headers.get('content-type') ?? ''
  const outcome = contentType.includes('text/event-stream') ? await answerFromEvents(response, signal) : await answerFromJson(response)
  if (sessionId !== null) {
    // Politely end the session the check opened; failures do not matter.
    void fetch(url, { method: 'DELETE', headers: requestHeaders(headers, { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': outcome?.protocolVersion ?? MCP_PROTOCOL_VERSION }), signal, redirect: 'manual' }).catch(() => undefined)
  }
  return outcome ?? failure('Server did not answer initialize')
}

async function checkSse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Outcome> {
  const stop = new AbortController()
  const both = AbortSignal.any([signal, stop.signal])
  try {
    const stream = await fetch(url, {
      headers: requestHeaders(headers, { Accept: 'text/event-stream' }),
      signal: both,
      redirect: 'manual',
    })
    if (!stream.ok) {
      return failure(`HTTP ${stream.status}`)
    }
    let post: Promise<void> | undefined
    let posted: Outcome | undefined
    const sendInitialize = async (endpoint: string): Promise<Outcome | undefined> => {
      const target = new URL(endpoint, url)
      if (target.origin !== new URL(url).origin) {
        return failure('SSE endpoint points to another origin')
      }
      const response = await fetch(target, {
        method: 'POST',
        headers: requestHeaders(headers, { 'Content-Type': 'application/json' }),
        body: initializeMessage(),
        signal: both,
        redirect: 'manual',
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return failure(`HTTP ${response.status} from SSE endpoint`)
      }
      return answerFromJson(response, true)
    }
    const result = new Promise<Outcome>((resolve, reject) => {
      const settle = (outcome: Outcome | undefined): void => {
        if (outcome) {
          posted = outcome
          resolve(outcome)
        }
      }
      void (async () => {
        for await (const event of readEvents(stream, both)) {
          if (event.event === 'endpoint' && !post) {
            post = sendInitialize(event.data).then(settle, reject)
          } else if (event.event === 'message') {
            const json = parseJson(event.data)
            const outcome = json ? interpret(json.value) : failure('Server sent invalid JSON')
            if (outcome) {
              settle(outcome)
              return
            }
          }
        }
        // The stream ended; a pending POST may still carry the answer.
        await post
        if (!posted) {
          reject(new Error('SSE stream ended without an answer'))
        }
      })().catch(reject)
    })
    return await result
  } finally {
    stop.abort()
  }
}

// Entry point

function redact(text: string, secrets: readonly string[]): string {
  return scrub(text, secrets).replace(/\s+/g, ' ').trim().slice(0, MCP_HEALTH_ERROR_MAX)
}

/** Raw env and header values plus the value of every `${VAR}` referenced anywhere in the entry. */
function secretsOf(entry: HealthTarget, env: HealthEnv): string[] {
  const { config } = entry
  const values = Object.values(config.transport === 'stdio' ? config.env : config.headers)
  const texts = config.transport === 'stdio' ? [config.command, ...config.args, ...values] : [config.url, ...values]
  const referenced = texts.flatMap(text => [...text.matchAll(VAR_PATTERN)].map(match => env[match[1] ?? '']))
  return [...values, ...values.map(value => expandVars(value, env)), ...referenced.filter((value): value is string => value !== undefined)]
}

async function runCheck(entry: HealthTarget, options: ResolvedOptions, signal: AbortSignal): Promise<Outcome> {
  const { config } = entry
  if (config.transport === 'stdio') {
    return checkStdio(entry, config, options, signal)
  }
  const url = expandVars(config.url, options.env, { blankCredentials: true, missing: options.missing })
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    return { status: 'unsupported', error: 'The URL is not an http(s) URL after expanding variables' }
  }
  const headers = expandMap(config.headers, options.env, { blankCredentials: true, missing: options.missing })
  return config.transport === 'http' ? checkHttp(url, headers, signal) : checkSse(url, headers, signal)
}

/**
 * Performs the MCP `initialize` handshake against one entry and reports how it went; never throws.
 * `${VAR}` / `${VAR:-default}` in command, args, env, url and headers are expanded from `options.env`;
 * credential-named variables expand to an empty string in remote url and headers.
 */
export async function checkMcpHealth(entry: HealthTarget, options: HealthOptions = {}): Promise<McpHealthResult> {
  const resolved: ResolvedOptions = {
    logger: options.logger,
    missing: new Set<string>(),
    timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
    env: options.env ?? process.env,
    home: options.home ?? homedir(),
  }
  if (!entry.approved) {
    return { name: entry.name, scope: entry.scope, status: 'unsupported', error: NOT_APPROVED_ERROR }
  }
  const started = Date.now()
  const signal = AbortSignal.timeout(resolved.timeoutMs)
  let onAbort: (() => void) | undefined
  const deadline = new Promise<Outcome>(resolve => {
    onAbort = () => resolve({ status: 'timeout' })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  let outcome: Outcome
  try {
    outcome = await Promise.race([runCheck(entry, resolved, signal), deadline])
  } catch (error) {
    outcome = signal.aborted ? { status: 'timeout' } : failure(describeFetchError(error))
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const { name, scope } = entry
  if (resolved.missing.size > 0) {
    resolved.logger?.warn({ name, vars: [...resolved.missing] }, 'Unset variables in MCP server config left as literal text')
  }
  const error = outcome.error === undefined ? undefined : redact(outcome.error, secretsOf(entry, resolved.env))
  return {
    name,
    scope,
    status: outcome.status,
    latencyMs: Date.now() - started,
    ...(outcome.serverInfo ? { serverInfo: outcome.serverInfo } : {}),
    ...(outcome.protocolVersion === undefined ? {} : { protocolVersion: outcome.protocolVersion }),
    ...(error === undefined || error === '' ? {} : { error }),
  }
}

// Runner

export interface HealthRunnerOptions extends HealthOptions {
  maxConcurrent?: number
  check?: (entry: HealthTarget, options: HealthOptions) => Promise<McpHealthResult>
}

export interface HealthRunner {
  check: (entry: HealthTarget) => Promise<McpHealthResult>
}

const keyOf = (entry: HealthTarget): string => JSON.stringify([entry.name, entry.scope])

/** At most `maxConcurrent` checks run at once; asking again for an entry that is in flight returns the same promise. */
export function createHealthRunner({ maxConcurrent = HEALTH_MAX_CONCURRENT, check = checkMcpHealth, ...options }: HealthRunnerOptions = {}): HealthRunner {
  const inFlight = new Map<string, Promise<McpHealthResult>>()
  const waiting: (() => void)[] = []
  let active = 0

  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1
      return
    }
    // The releasing check hands its slot over, so `active` stays unchanged.
    await new Promise<void>(resolve => waiting.push(resolve))
  }

  function release(): void {
    const next = waiting.shift()
    if (next) {
      next()
    } else {
      active -= 1
    }
  }

  return {
    check(entry) {
      const key = keyOf(entry)
      const existing = inFlight.get(key)
      if (existing) {
        return existing
      }
      const task = (async () => {
        await acquire()
        try {
          return await check(entry, options)
        } finally {
          release()
        }
      })().finally(() => inFlight.delete(key))
      inFlight.set(key, task)
      return task
    },
  }
}
