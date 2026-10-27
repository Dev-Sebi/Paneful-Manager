import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertBackupDirOutsideScopes, resolveBackupDir } from './state-dir.js'

describe('backup dir', () => {
  it('follows XDG_STATE_HOME and falls back to ~/.local/state', () => {
    expect(resolveBackupDir({ XDG_STATE_HOME: '/x/state' })).toBe('/x/state/agent-hub/backups')
    expect(resolveBackupDir({ XDG_STATE_HOME: 'relative' })).toBe(join(homedir(), '.local/state/agent-hub/backups'))
    expect(resolveBackupDir({})).toBe(join(homedir(), '.local/state/agent-hub/backups'))
  })

  it('rejects a backup dir inside a scope', () => {
    const scopes = [{ kind: 'global', path: '/nonexistent/claude' }, { kind: 'project', path: '/nonexistent/app' }] as const
    expect(() => assertBackupDirOutsideScopes('/nonexistent/state/backups', [...scopes])).not.toThrow()
    expect(() => assertBackupDirOutsideScopes('/nonexistent/app/.state/backups', [...scopes])).toThrow(/outside the scope/)
    expect(() => assertBackupDirOutsideScopes('/nonexistent/claude', [...scopes])).toThrow()
  })
})
