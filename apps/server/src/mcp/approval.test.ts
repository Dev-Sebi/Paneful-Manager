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
const check = (name = 'srv') => createMcpApproval({ env: {}, home }).isApproved(scope(), name)

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

describe('MCP approval', () => {
  it('always allows user and local scope', async () => {
    const approval = createMcpApproval({ env: {}, home })
    expect(await approval.isApproved({ kind: 'user' }, 'x')).toBe(true)
    expect(await approval.isApproved({ kind: 'local', projectPath: project }, 'x')).toBe(true)
  })

  it('rejects project entries without any approval and with broken files', async () => {
    expect(await check()).toBe(false)
    write(join(project, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: 'yes' })
    writeFileSync(join(home, '.claude.json'), '{ nope')
    expect(await check()).toBe(false)
  })

  it('approves through enableAllProjectMcpServers and enabledMcpjsonServers', async () => {
    write(join(project, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true })
    expect(await check('anything')).toBe(true)
    write(join(project, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(true)
    expect(await check('other')).toBe(false)
    write(join(home, '.claude', 'settings.json'), { enabledMcpjsonServers: ['other'] })
    expect(await check('other')).toBe(true)
  })

  it('reads the approval of the project in ~/.claude.json', async () => {
    write(join(home, '.claude.json'), { projects: { [project]: { enabledMcpjsonServers: ['srv'] } } })
    expect(await check()).toBe(true)
  })

  it('lets disabledMcpjsonServers win', async () => {
    write(join(project, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true, disabledMcpjsonServers: ['srv'] })
    expect(await check('srv')).toBe(false)
    expect(await check('other')).toBe(true)
  })

  it('ignores approvals in the committed settings but honors its disabled list', async () => {
    write(join(project, '.claude', 'settings.json'), { enableAllProjectMcpServers: true, enabledMcpjsonServers: ['srv'] })
    expect(await check()).toBe(false)
    write(join(home, '.claude', 'settings.json'), { enableAllProjectMcpServers: true })
    write(join(project, '.claude', 'settings.json'), { disabledMcpjsonServers: ['srv'] })
    expect(await check()).toBe(false)
  })

  it('uses CLAUDE_CONFIG_DIR for user settings', async () => {
    const dir = join(base, 'cfg')
    write(join(dir, 'settings.json'), { enableAllProjectMcpServers: true })
    expect(await createMcpApproval({ env: { CLAUDE_CONFIG_DIR: dir }, home }).isApproved(scope(), 'srv')).toBe(true)
  })
})
