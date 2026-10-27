import { describe, expect, it } from 'vitest'
import { assertBackupDirOutsideScopes } from './state-dir.js'

describe('backup dir', () => {
  it('rejects a backup dir inside a scope', () => {
    const scopes = [{ kind: 'global', path: '/nonexistent/claude' }, { kind: 'project', path: '/nonexistent/app' }] as const
    expect(() => assertBackupDirOutsideScopes('/nonexistent/state/backups', [...scopes])).not.toThrow()
    expect(() => assertBackupDirOutsideScopes('/nonexistent/app/.state/backups', [...scopes])).toThrow(/outside the scope/)
    expect(() => assertBackupDirOutsideScopes('/nonexistent/claude', [...scopes])).toThrow()
  })
})
