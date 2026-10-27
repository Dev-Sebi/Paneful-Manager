import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpApproval } from './approval.js'

let base: string
let home: string
let project: string

const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}
const scope = () => ({ kind: 'project', projectPath: project }) as const
const managedDir = (): string => join(base, 'managed')
const approval = (env: Record<string, string> = {}) => createMcpApproval({ env, home, managedDir: managedDir() }).session()
const check = (name = 'srv') => approval().isApproved(scope(), name)

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-hub-approval-'))
  home = join(base, 'home')
  project = join(base, 'project')
  mkdirSync(home)
  mkdirSync(project)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

const trust = (extra: Record<string, unknown> = {}): void =>
  write(join(home, '.claude.json'), { projects: { [project]: { hasTrustDialogAccepted: true, ...extra } } })

describe('MCP approval', () => {
  it('always allows user and local scope', async () => {
    expect(await approval().isApproved({ kind: 'user' }, 'x')).toBe(true)
    expect(await approval().isApproved({ kind: 'local', projectPath: project }, 'x')).toBe(true)
  })

  it('rejects project entries without any approval and with broken files', async () => {
    expect(await check()).toBe(false)
    write(join(home, '.claude', 'settings.json'), { enableAllProjectMcpServers: 'yes' })
    writeFileSync(join(home, '.claude.json'), '{ nope')
    expect(await check()).toBe(false)
  })

  it('approves through the project entry in ~/.claude.json once the trust dialog was accepted', async () => {
    trust({ enabledMcpjsonServers: ['srv'] })
    expect(await check()).toBe(true)
    expect(await check('other')).toBe(false)
    trust({ enableAllProjectMcpServers: true })
    expect(await check('anything')).toBe(true)
  })

  it('approves through user settings without a project entry in ~/.claude.json', async () => {
    write(join(home, '.claude', 'settings.json'), { enabledMcpjsonServers: ['srv'] })
    expect(await check()).toBe(true)
    expect(await check('other')).toBe(false)
    write(join(home, '.claude', 'settings.json'), { enableAllProjectMcpServers: true })
    expect(await check('other')).toBe(true)
  })

  it('needs the trust dialog for approvals stored in the project entry: missing flag, false or a string is not approved', async () => {
    write(join(home, '.claude.json'), { projects: { [project]: { enabledMcpjsonServers: ['srv'] } } })
    expect(await check()).toBe(false)
    write(join(home, '.claude.json'), { projects: { [project]: { hasTrustDialogAccepted: false, enabledMcpjsonServers: ['srv'] } } })
    expect(await check()).toBe(false)
    write(join(home, '.claude.json'), { projects: { [project]: { hasTrustDialogAccepted: 'true', enabledMcpjsonServers: ['srv'] } } })
    expect(await check()).toBe(false)
  })

  it('does not take approvals from project files', async () => {
    trust()
    write(join(project, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['srv'] })
    write(join(project, '.claude', 'settings.json'), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['srv'] })
    expect(await check()).toBe(false)
  })

  it('lets disabledMcpjsonServers win from every file', async () => {
    trust({ enableAllProjectMcpServers: true })
    expect(await check('srv')).toBe(true)
    write(join(project, '.claude', 'settings.local.json'), { disabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(false)
    expect(await check('other')).toBe(true)
    rmSync(join(project, '.claude'), { recursive: true })
    write(join(project, '.claude', 'settings.json'), { disabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(false)
    rmSync(join(project, '.claude'), { recursive: true })
    write(join(home, '.claude', 'settings.json'), { disabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(false)
    write(join(home, '.claude', 'settings.json'), {})
    trust({ enableAllProjectMcpServers: true, disabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(false)
  })

  it('uses CLAUDE_CONFIG_DIR for user settings and the config file', async () => {
    const dir = join(base, 'cfg')
    write(join(dir, 'settings.json'), { enableAllProjectMcpServers: true })
    write(join(dir, '.claude.json'), { projects: { [project]: { hasTrustDialogAccepted: true } } })
    expect(await approval({ CLAUDE_CONFIG_DIR: dir }).isApproved(scope(), 'srv')).toBe(true)
  })

  it('lets managed settings block every scope', async () => {
    trust({ enableAllProjectMcpServers: true })
    write(join(managedDir(), 'managed-settings.json'), { disabledMcpjsonServers: ['a'], deniedMcpServers: [{ serverName: 'b' }, 'c'] })
    write(join(managedDir(), 'managed-settings.d', '10-extra.json'), { deniedMcpServers: [{ serverName: 'd' }] })
    const session = approval()
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(await session.isApproved({ kind: 'user' }, name)).toBe(false)
      expect(await session.isApproved({ kind: 'local', projectPath: project }, name)).toBe(false)
      expect(await session.isApproved(scope(), name)).toBe(false)
    }
    expect(await session.isApproved({ kind: 'user' }, 'free')).toBe(true)
    expect(await session.isApproved(scope(), 'free')).toBe(true)
  })

  it('reads each settings file once per session', async () => {
    trust({ enableAllProjectMcpServers: true })
    const session = approval()
    expect(await session.isApproved(scope(), 'a')).toBe(true)
    rmSync(join(home, '.claude.json'))
    expect(await session.isApproved(scope(), 'b')).toBe(true)
    expect(await approval().isApproved(scope(), 'b')).toBe(false)
  })
})
