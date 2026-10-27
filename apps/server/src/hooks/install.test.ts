import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_EVENTS, HOOK_NOTIFICATION_MATCHER, hookUrl } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../errors.js'
import { createBackupStore, type BackupStore } from '../files/backups.js'
import { createHookSettings, getHookStatus, hookHandler, installHooks, resolveClaudeSettingsPath, uninstallHooks } from './install.js'

let dir: string
let settingsPath: string
let backupDir: string
let backups: BackupStore
let managedDir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-hooks-install-'))
  settingsPath = join(dir, 'claude', 'settings.json')
  backupDir = join(dir, 'backups')
  managedDir = join(dir, 'managed')
  backups = createBackupStore({ dir: backupDir })
  await mkdir(join(dir, 'claude'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const read = async (): Promise<string> => readFile(settingsPath, 'utf8')
const json = async (): Promise<Record<string, Record<string, unknown[]>>> => JSON.parse(await read()) as Record<string, Record<string, unknown[]>>
const install = (port = 7337) => installHooks({ settingsPath, port, backups })
const uninstall = () => uninstallHooks({ settingsPath, backups })
const status = (port = 7337) => getHookStatus({ settingsPath, port, managedDir })

const USER_SETTINGS = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/bin/check.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:9000/stop",
            "timeout": 30
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": [
      "Bash(npm test)"
    ]
  }
}
`

describe('installHooks', () => {
  it('creates a missing settings file with one http entry per event', async () => {
    expect(await install()).toEqual({ changed: true })
    const settings = await json()
    expect(Object.keys(settings.hooks ?? {})).toEqual([...HOOK_EVENTS])
    expect(settings.hooks?.Stop).toEqual([{ hooks: [hookHandler(7337)] }])
    expect(settings.hooks?.Notification).toEqual([{ matcher: HOOK_NOTIFICATION_MATCHER, hooks: [hookHandler(7337)] }])
    expect(hookHandler(7337)).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7337/api/hooks',
      headers: { 'X-Agent-Hub-Session-Id': '$AGENT_HUB_SESSION_ID', 'X-Agent-Hub-Hook-Token': '$AGENT_HUB_HOOK_TOKEN' },
      allowedEnvVars: ['AGENT_HUB_SESSION_ID', 'AGENT_HUB_HOOK_TOKEN'],
      timeout: 5,
    })
    expect(await readdir(dir)).not.toContain('backups')
  })

  it('keeps user hooks, matchers and keys, backs up, is idempotent and round-trips byte-identical', async () => {
    await writeFile(settingsPath, USER_SETTINGS, { mode: 0o640 })
    await chmod(settingsPath, 0o640)
    const result = await install()
    expect(result.changed).toBe(true)
    expect(await readFile(result.backupPath ?? '', 'utf8')).toBe(USER_SETTINGS)
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o640)

    const settings = await json()
    expect(settings.model).toBe('opus')
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(settings.hooks?.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/check.sh' }] },
      { hooks: [hookHandler(7337)] },
    ])
    expect(settings.hooks?.Stop?.[0]).toEqual({ hooks: [{ type: 'http', url: 'http://localhost:9000/stop', timeout: 30 }] })
    expect(Object.keys(settings)).toEqual(['$schema', 'model', 'hooks', 'permissions'])

    const installed = await read()
    expect(await install()).toEqual({ changed: false })
    expect(await read()).toBe(installed)

    expect((await uninstall()).changed).toBe(true)
    expect(await read()).toBe(USER_SETTINGS)
    expect(await uninstall()).toEqual({ changed: false })
  })

  it('removes the hooks key again when it only held Agent Hub entries', async () => {
    const original = '{\n\t"theme": "dark"\n}'
    await writeFile(settingsPath, original)
    await install()
    expect(await read()).toContain('\n\t"hooks": {')
    await uninstall()
    expect(await read()).toBe(original)
  })

  it('preserves CRLF line endings', async () => {
    const original = '{\r\n    "theme": "dark"\r\n}\r\n'
    await writeFile(settingsPath, original)
    await install()
    expect(await read()).not.toMatch(/[^\r]\n/)
    await uninstall()
    expect(await read()).toBe(original)
  })

  it('updates entries in place after a port change and drops duplicates and stale events', async () => {
    await install(7000)
    const settings = await json()
    const stop = settings.hooks?.Stop as { hooks: unknown[] }[]
    stop[0]?.hooks.push(hookHandler(7000))
    settings.hooks = { ...settings.hooks, SessionStart: [{ hooks: [hookHandler(7000)] }], SubagentStop: [{ hooks: [hookHandler(7000)] }] }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2))

    expect((await install(7337)).changed).toBe(true)
    const updated = await json()
    expect(updated.hooks?.Stop).toEqual([{ hooks: [hookHandler(7337)] }])
    expect(updated.hooks).not.toHaveProperty('SessionStart')
    expect(updated.hooks).not.toHaveProperty('SubagentStop')
    expect(await read()).not.toContain(hookUrl(7000))
  })

  it('moves an entry out of a user group with a foreign matcher', async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: { Notification: [{ matcher: 'auth_success', hooks: [{ type: 'command', command: 'notify' }, hookHandler(7337)] }] } }))
    await install()
    const settings = await json()
    expect(settings.hooks?.Notification).toEqual([
      { matcher: 'auth_success', hooks: [{ type: 'command', command: 'notify' }] },
      { matcher: HOOK_NOTIFICATION_MATCHER, hooks: [hookHandler(7337)] },
    ])
  })

  it.each([
    ['comments', '{\n  // mine\n  "theme": "dark"\n}\n'],
    ['trailing commas', '{ "theme": "dark", }'],
    ['a non-object root', '[]'],
    ['a non-object hooks key', '{ "hooks": [] }'],
    ['a non-array event', '{ "hooks": { "Stop": {} } }'],
  ])('refuses %s with 409 and leaves the file alone', async (_label, content) => {
    await writeFile(settingsPath, content)
    const error = await install().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({ statusCode: 409, code: 'conflict' })
    expect(await read()).toBe(content)
    expect(await readdir(dir)).not.toContain('backups')
  })

  it('writes through a symlinked settings file and keeps the link', async () => {
    const target = join(dir, 'dotfiles-settings.json')
    await writeFile(target, '{}\n')
    await rm(settingsPath, { force: true })
    await symlink(target, settingsPath)
    await install()
    expect((await readFile(target, 'utf8'))).toContain(hookUrl(7337))
    await uninstall()
    expect(await readFile(target, 'utf8')).toBe('{}\n')
  })
})

describe('getHookStatus', () => {
  it('reports missing, installed and wrong-port states', async () => {
    expect(await status()).toMatchObject({ installed: false, portMatches: true, statusAvailable: false, reasons: [{ code: 'not_installed' }] })
    await install()
    expect(await status()).toEqual({ settingsPath, installed: true, portMatches: true, installedEvents: [...HOOK_EVENTS], statusAvailable: true, reasons: [] })
    expect(await status(8000)).toMatchObject({ installed: false, portMatches: false, reasons: [{ code: 'port_mismatch' }] })
  })

  it('reports an unreadable settings file', async () => {
    await writeFile(settingsPath, '{ nope')
    expect((await status()).reasons.map(reason => reason.code)).toEqual(['settings_invalid', 'not_installed'])
  })

  it('finds settings that block the hook requests in user and managed settings', async () => {
    await install()
    const settings = await json()
    await writeFile(settingsPath, JSON.stringify({ ...settings, disableAllHooks: true, allowedHttpHookUrls: ['http://localhost:*'] }))
    await mkdir(join(managedDir, 'managed-settings.d'), { recursive: true })
    await writeFile(join(managedDir, 'managed-settings.json'), JSON.stringify({ allowManagedHooksOnly: true }))
    await writeFile(join(managedDir, 'managed-settings.d', '10-hooks.json'), JSON.stringify({ httpHookAllowedEnvVars: ['AGENT_HUB_SESSION_ID'] }))
    const result = await status()
    expect(result.installed).toBe(true)
    expect(result.statusAvailable).toBe(false)
    expect(result.reasons.map(reason => [reason.code, reason.source])).toEqual([
      ['disable_all_hooks', settingsPath],
      ['managed_hooks_only', join(managedDir, 'managed-settings.json')],
      ['url_not_allowed', settingsPath],
      ['env_vars_not_allowed', join(managedDir, 'managed-settings.d', '10-hooks.json')],
    ])
  })

  it('skips hidden drop-ins and reports invalid managed settings', async () => {
    await install()
    await mkdir(join(managedDir, 'managed-settings.d'), { recursive: true })
    await writeFile(join(managedDir, 'managed-settings.d', '.backup.json'), JSON.stringify({ disableAllHooks: true }))
    expect((await status()).statusAvailable).toBe(true)
    await writeFile(join(managedDir, 'managed-settings.d', '20-broken.json'), '{ nope')
    const result = await status()
    expect(result.statusAvailable).toBe(false)
    expect(result.reasons.map(reason => [reason.code, reason.source])).toEqual([['settings_invalid', join(managedDir, 'managed-settings.d', '20-broken.json')]])
  })

  it('matches allowedHttpHookUrls patterns case-sensitively', async () => {
    await install()
    await writeFile(settingsPath, JSON.stringify({ ...(await json()), allowedHttpHookUrls: ['HTTP://127.0.0.1:*'] }))
    expect((await status()).reasons.map(reason => reason.code)).toEqual(['url_not_allowed'])
  })

  it('accepts allowlists that include the hook URL and both variables', async () => {
    await install()
    const settings = await json()
    await writeFile(settingsPath, JSON.stringify({
      ...settings,
      allowedHttpHookUrls: ['http://127.0.0.1:*'],
      httpHookAllowedEnvVars: ['AGENT_HUB_SESSION_ID', 'AGENT_HUB_HOOK_TOKEN'],
    }))
    expect((await status()).statusAvailable).toBe(true)
  })
})

describe('createHookSettings', () => {
  it('returns the status after install and uninstall', async () => {
    const hooks = createHookSettings({ settingsPath, backups, managedDir })
    expect(await hooks.install(7337)).toMatchObject({ changed: true, status: { installed: true } })
    expect(await hooks.uninstall(7337)).toMatchObject({ changed: true, status: { installed: false } })
  })

  it('resolves the settings path from CLAUDE_CONFIG_DIR', () => {
    expect(resolveClaudeSettingsPath({ CLAUDE_CONFIG_DIR: '/cfg/claude' })).toBe('/cfg/claude/settings.json')
    expect(resolveClaudeSettingsPath({})).toMatch(/\.claude\/settings\.json$/)
  })
})
