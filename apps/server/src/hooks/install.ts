import { realpath, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  HOOK_ENV,
  HOOK_EVENTS,
  HOOK_NOTIFICATION_MATCHER,
  HOOK_TIMEOUT_SEC,
  HOOK_URL_PATTERN,
  hookUrl,
  type HookBlockReason,
  type HookChangeResponse,
  type HookStatus,
} from '@agent-hub/shared'
import { AppError } from '../errors.js'
import type { BackupStore } from '../files/backups.js'
import { readCurrent } from '../files/read.js'
import { atomicWrite } from '../files/service.js'
import { expandHome } from '../paths.js'

/** Linux and WSL location of managed settings (`managed-settings.json` plus `managed-settings.d/*.json`). */
export const MANAGED_SETTINGS_DIR = '/etc/claude-code'

type Json = null | boolean | number | string | Json[] | JsonObject
interface JsonObject { [key: string]: Json }

export interface InstallHooksOptions {
  settingsPath: string
  port: number
  backups: BackupStore
}

export interface UninstallHooksOptions {
  settingsPath: string
  backups: BackupStore
}

export interface HookChangeResult {
  changed: boolean
  /** Backup of the previous content, when an existing file was rewritten. */
  backupPath?: string
}

export interface HookStatusOptions {
  settingsPath: string
  port: number
  managedDir?: string
}

const HOOK_HEADERS = {
  'X-Agent-Hub-Session-Id': `$${HOOK_ENV.sessionId}`,
  'X-Agent-Hub-Hook-Token': `$${HOOK_ENV.token}`,
} as const

/** `$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`. */
export function resolveClaudeSettingsPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  return join(dir ? resolve(expandHome(dir)) : join(homedir(), '.claude'), 'settings.json')
}

/** The handler Agent Hub installs for every event; extra keys are avoided because Claude Code validates handlers. */
export function hookHandler(port: number): JsonObject {
  return {
    type: 'http',
    url: hookUrl(port),
    headers: { ...HOOK_HEADERS },
    allowedEnvVars: [HOOK_ENV.sessionId, HOOK_ENV.token],
    timeout: HOOK_TIMEOUT_SEC,
  }
}

function matcherFor(event: string): string | undefined {
  return event === 'Notification' ? HOOK_NOTIFICATION_MATCHER : undefined
}

function hookGroup(event: string, port: number): JsonObject {
  const matcher = matcherFor(event)
  return { ...(matcher === undefined ? {} : { matcher }), hooks: [hookHandler(port)] }
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Agent Hub's handlers are identified by their exact URL (any port), never by an extra marker key. */
export function isAgentHubHandler(handler: Json | undefined): boolean {
  return isObject(handler) && handler.type === 'http' && typeof handler.url === 'string' && HOOK_URL_PATTERN.test(handler.url)
}

const same = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b)

const invalid = (message: string): AppError => new AppError(message, 409, 'conflict', { currentHash: null })

interface Format {
  indent: string
  eol: string
  finalNewline: boolean
}

function detectFormat(text: string): Format {
  const indented = /^([ \t]+)\S/m.exec(text)?.[1]
  const indent = indented === undefined ? '  ' : (indented.startsWith('\t') ? '\t' : indented)
  return { indent, eol: text.includes('\r\n') ? '\r\n' : '\n', finalNewline: text.length === 0 || text.endsWith('\n') }
}

function serialize(settings: JsonObject, format: Format): string {
  const body = JSON.stringify(settings, null, format.indent).replaceAll('\n', format.eol)
  return format.finalNewline ? `${body}${format.eol}` : body
}

/** Settings files are strict JSON; comments, trailing commas or a non-object root are refused, never rewritten. */
function parseSettings(text: string): JsonObject {
  if (text.trim() === '') {
    return {}
  }
  let parsed: Json
  try {
    parsed = JSON.parse(text) as Json
  } catch {
    throw invalid('settings.json is not valid JSON; fix it before installing hooks')
  }
  if (!isObject(parsed)) {
    throw invalid('settings.json must contain a JSON object')
  }
  return parsed
}

function hooksOf(settings: JsonObject, create: boolean): JsonObject | undefined {
  const hooks = settings.hooks
  if (hooks === undefined) {
    if (!create) {
      return undefined
    }
    const created: JsonObject = {}
    settings.hooks = created
    return created
  }
  if (!isObject(hooks)) {
    throw invalid('"hooks" in settings.json is not an object')
  }
  return hooks
}

function groupsOf(hooks: JsonObject, event: string): Json[] | undefined {
  const groups = hooks[event]
  if (groups === undefined) {
    return undefined
  }
  if (!Array.isArray(groups)) {
    throw invalid(`"hooks.${event}" in settings.json is not an array`)
  }
  return groups
}

/** Removes Agent Hub handlers from one event; groups and the event key are dropped only when emptied by that. */
function removeHandlers(hooks: JsonObject, event: string, keep?: { group: number, handler: number }): boolean {
  const groups = groupsOf(hooks, event)
  if (groups === undefined) {
    return false
  }
  let changed = false
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      continue
    }
    const handlers = group.hooks
    const before = handlers.length
    const remaining = handlers.filter((handler, h) => !isAgentHubHandler(handler) || (keep?.group === g && keep.handler === h))
    if (remaining.length === before) {
      continue
    }
    changed = true
    if (remaining.length === 0) {
      groups.splice(g, 1)
    } else {
      group.hooks = remaining
    }
  }
  if (changed && groups.length === 0) {
    delete hooks[event]
  }
  return changed
}

function findHandler(groups: Json[]): { group: number, handler: number } | undefined {
  for (const [g, group] of groups.entries()) {
    if (isObject(group) && Array.isArray(group.hooks)) {
      const h = group.hooks.findIndex(handler => isAgentHubHandler(handler))
      if (h !== -1) {
        return { group: g, handler: h }
      }
    }
  }
  return undefined
}

function installEvent(hooks: JsonObject, event: string, port: number): boolean {
  const desired = hookHandler(port)
  const matcher = matcherFor(event)
  const groups = groupsOf(hooks, event)
  if (groups === undefined) {
    hooks[event] = [hookGroup(event, port)]
    return true
  }
  const found = findHandler(groups)
  const group = found === undefined ? undefined : groups[found.group]
  if (found === undefined || !isObject(group) || !Array.isArray(group.hooks)) {
    groups.push(hookGroup(event, port))
    return true
  }
  let changed = removeHandlers(hooks, event, found)
  const handlers = Array.isArray(group.hooks) ? group.hooks : []
  const ownGroup = handlers.length === 1
  if (ownGroup || same(group.matcher, matcher)) {
    if (!same(handlers[found.handler], desired)) {
      handlers[found.handler] = desired
      changed = true
    }
    if (!same(group.matcher, matcher)) {
      if (matcher === undefined) {
        delete group.matcher
      } else {
        group.matcher = matcher
      }
      changed = true
    }
    return changed
  }
  // Our handler shares a group whose matcher is not ours: move it into its own group.
  removeHandlers(hooks, event)
  ;(groupsOf(hooks, event) ?? (hooks[event] = [])).push(hookGroup(event, port))
  return true
}

/** Adds or updates Agent Hub's handlers; returns whether `settings` changed. Never touches other entries. */
export function applyInstall(settings: JsonObject, port: number): boolean {
  const hadHooks = settings.hooks !== undefined
  const hooks = hooksOf(settings, true) ?? {}
  let changed = !hadHooks
  for (const event of Object.keys(hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      changed = removeHandlers(hooks, event) || changed
    }
  }
  for (const event of HOOK_EVENTS) {
    changed = installEvent(hooks, event, port) || changed
  }
  return changed
}

/** Removes only Agent Hub's handlers; returns whether `settings` changed. */
export function applyUninstall(settings: JsonObject): boolean {
  const hooks = hooksOf(settings, false)
  if (hooks === undefined) {
    return false
  }
  let changed = false
  for (const event of Object.keys(hooks)) {
    changed = removeHandlers(hooks, event) || changed
  }
  if (changed && Object.keys(hooks).length === 0) {
    delete settings.hooks
  }
  return changed
}

async function resolveTarget(settingsPath: string): Promise<string> {
  try {
    return await realpath(settingsPath)
  } catch {
    return settingsPath
  }
}

const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(task, task)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  try {
    return await next
  } finally {
    if (locks.get(key) === settled) {
      locks.delete(key)
    }
  }
}

/** Reads, edits and atomically rewrites the settings file (symlinks are followed); backs up before overwriting. */
async function editSettings(settingsPath: string, backups: BackupStore, edit: (settings: JsonObject) => boolean): Promise<HookChangeResult> {
  const target = await resolveTarget(settingsPath)
  return withLock(target, async () => {
    const current = await readCurrent(target)
    const text = current?.content.toString('utf8') ?? ''
    const settings = parseSettings(text)
    if (!edit(settings)) {
      return { changed: false }
    }
    const content = serialize(settings, current === null ? { indent: '  ', eol: '\n', finalNewline: true } : detectFormat(text))
    let backupPath: string | undefined
    if (current === null) {
      await mkdir(dirname(target), { recursive: true })
    } else {
      backupPath = await backups.save(target, current.content)
    }
    await atomicWrite(target, content, current === null ? undefined : current.stats.mode & 0o7777, async () => {
      const latest = await readCurrent(target)
      if ((latest?.hash ?? null) !== (current?.hash ?? null)) {
        throw new AppError('settings.json changed while installing hooks', 409, 'conflict', { currentHash: latest?.hash ?? null })
      }
    })
    return { changed: true, ...(backupPath === undefined ? {} : { backupPath }) }
  })
}

export function installHooks({ settingsPath, port, backups }: InstallHooksOptions): Promise<HookChangeResult> {
  return editSettings(settingsPath, backups, settings => applyInstall(settings, port))
}

export function uninstallHooks({ settingsPath, backups }: UninstallHooksOptions): Promise<HookChangeResult> {
  return editSettings(settingsPath, backups, applyUninstall)
}

async function readSettingsFile(path: string): Promise<{ settings?: JsonObject, error?: string }> {
  try {
    const current = await readCurrent(await resolveTarget(path))
    return current === null ? {} : { settings: parseSettings(current.content.toString('utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'unreadable' }
  }
}

async function managedFiles(dir: string): Promise<string[]> {
  const dropIns = join(dir, 'managed-settings.d')
  const names = await readdir(dropIns).catch(() => [] as string[])
  return [join(dir, 'managed-settings.json'), ...names.filter(name => name.endsWith('.json')).toSorted().map(name => join(dropIns, name))]
}

function wildcardMatches(pattern: string, url: string): boolean {
  const source = pattern.split('*').map(part => part.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`, 'i').test(url)
}

function stringList(value: Json | undefined): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

/** Events whose Agent Hub handler matches the current port exactly, and whether no handler points elsewhere. */
function installedState(settings: JsonObject | undefined, port: number): { installedEvents: string[], portMatches: boolean } {
  const installedEvents: string[] = []
  let portMatches = true
  const hooks = settings?.hooks
  for (const [event, groups] of isObject(hooks) ? Object.entries(hooks) : []) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        continue
      }
      for (const handler of group.hooks.filter(entry => isAgentHubHandler(entry))) {
        if (!same(handler, hookHandler(port))) {
          portMatches &&= isObject(handler) && handler.url === hookUrl(port)
        } else if (same(group.matcher, matcherFor(event)) && !installedEvents.includes(event)) {
          installedEvents.push(event)
        }
      }
    }
  }
  return { installedEvents, portMatches }
}

/**
 * Installed state plus every setting found in the user and managed settings that would block the hook requests.
 * Project settings depend on the session's directory and are not checked.
 */
export async function getHookStatus({ settingsPath, port, managedDir = MANAGED_SETTINGS_DIR }: HookStatusOptions): Promise<HookStatus> {
  const url = hookUrl(port)
  const reasons: HookBlockReason[] = []
  const user = await readSettingsFile(settingsPath)
  if (user.error !== undefined) {
    reasons.push({ code: 'settings_invalid', source: settingsPath, message: user.error })
  }
  const { installedEvents, portMatches } = installedState(user.settings, port)
  const installed = HOOK_EVENTS.every(event => installedEvents.includes(event))
  if (!installed) {
    reasons.push(portMatches
      ? { code: 'not_installed', source: settingsPath, message: 'Agent Hub hooks are not installed' }
      : { code: 'port_mismatch', source: settingsPath, message: `Agent Hub hooks point at another port; reinstall them for port ${port}` })
  }

  const sources: { path: string, managed: boolean }[] = [
    { path: settingsPath, managed: false },
    ...(await managedFiles(managedDir)).map(path => ({ path, managed: true })),
  ]
  let urlRule: { source: string, patterns: string[] } | undefined
  let envRule: { source: string, names: string[] } | undefined
  for (const source of sources) {
    const { settings } = source.managed ? await readSettingsFile(source.path) : user
    if (settings === undefined) {
      continue
    }
    if (settings.disableAllHooks === true) {
      reasons.push({ code: 'disable_all_hooks', source: source.path, message: 'disableAllHooks is set' })
    }
    if (source.managed && settings.allowManagedHooksOnly === true) {
      reasons.push({ code: 'managed_hooks_only', source: source.path, message: 'allowManagedHooksOnly blocks user hooks' })
    }
    const patterns = stringList(settings.allowedHttpHookUrls)
    if (patterns !== undefined) {
      urlRule = { source: urlRule?.source ?? source.path, patterns: [...(urlRule?.patterns ?? []), ...patterns] }
    }
    const names = stringList(settings.httpHookAllowedEnvVars)
    if (names !== undefined) {
      envRule = { source: envRule?.source ?? source.path, names: [...(envRule?.names ?? []), ...names] }
    }
  }
  if (urlRule !== undefined && !urlRule.patterns.some(pattern => wildcardMatches(pattern, url))) {
    reasons.push({ code: 'url_not_allowed', source: urlRule.source, message: `allowedHttpHookUrls does not allow ${url}` })
  }
  const required = [HOOK_ENV.sessionId, HOOK_ENV.token]
  if (envRule !== undefined && !required.every(name => envRule.names.includes(name))) {
    reasons.push({ code: 'env_vars_not_allowed', source: envRule.source, message: `httpHookAllowedEnvVars must list ${required.join(' and ')}` })
  }
  return { settingsPath, installed, portMatches, installedEvents, statusAvailable: installed && reasons.length === 0, reasons }
}

export interface HookSettings {
  settingsPath: string
  install: (port: number) => Promise<HookChangeResponse>
  uninstall: (port: number) => Promise<HookChangeResponse>
  status: (port: number) => Promise<HookStatus>
}

export interface HookSettingsOptions {
  settingsPath: string
  backups: BackupStore
  managedDir?: string
}

/** Install, uninstall and status for one settings file, as used by the REST routes. */
export function createHookSettings({ settingsPath, backups, managedDir }: HookSettingsOptions): HookSettings {
  const status = (port: number): Promise<HookStatus> => getHookStatus({ settingsPath, port, ...(managedDir === undefined ? {} : { managedDir }) })
  return {
    settingsPath,
    async install(port) {
      const { changed } = await installHooks({ settingsPath, port, backups })
      return { changed, status: await status(port) }
    },
    async uninstall(port) {
      const { changed } = await uninstallHooks({ settingsPath, backups })
      return { changed, status: await status(port) }
    },
    status,
  }
}
