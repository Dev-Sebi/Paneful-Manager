import { describe, expect, it } from 'vitest'
import { SessionSchema } from './session.js'
import { issuePaths } from './test-utils.js'

const valid = {
  id: 'a1b2c3',
  cwd: '~/git/project1',
  tmuxSession: 'paneful-manager-a1b2c3',
  createdAt: '2026-10-27T10:00:00.000Z',
  state: 'idle',
  lifecycle: 'running',
  lastEventAt: '2026-10-27T10:00:05+02:00',
  cols: 120,
  rows: 30,
}

describe('SessionSchema', () => {
  it('applies defaults for hostId, command and args', () => {
    const session = SessionSchema.parse(valid)
    expect(session.hostId).toBe('local')
    expect(session.command).toBe('claude')
    expect(session.args).toEqual([])
  })

  it('accepts every state and lifecycle', () => {
    for (const state of ['working', 'waiting', 'error', 'idle']) {
      for (const lifecycle of ['starting', 'running', 'exited']) {
        expect(SessionSchema.safeParse({ ...valid, state, lifecycle }).success).toBe(true)
      }
    }
  })

  it('keeps an optional stateSince timestamp', () => {
    expect(SessionSchema.parse(valid).stateSince).toBeUndefined()
    expect(SessionSchema.parse({ ...valid, stateSince: '2026-10-27T10:00:06.000Z' }).stateSince).toBe('2026-10-27T10:00:06.000Z')
    expect(issuePaths(SessionSchema, { ...valid, stateSince: 'yesterday' })).toEqual(['stateSince'])
  })

  it('allows exitCode only for exited sessions', () => {
    expect(SessionSchema.parse({ ...valid, lifecycle: 'exited', exitCode: 1 }).exitCode).toBe(1)
    expect(issuePaths(SessionSchema, { ...valid, exitCode: 0 })).toEqual(['exitCode'])
  })

  it('rejects invalid fields with their paths', () => {
    expect(issuePaths(SessionSchema, { ...valid, state: 'busy' })).toEqual(['state'])
    expect(issuePaths(SessionSchema, { ...valid, tmuxSession: 'bad:name' })).toEqual(['tmuxSession'])
    expect(issuePaths(SessionSchema, { ...valid, id: 'a.b' })).toEqual(['id'])
    expect(issuePaths(SessionSchema, { ...valid, id: '' })).toEqual(['id'])
    expect(issuePaths(SessionSchema, { ...valid, createdAt: 'yesterday' })).toEqual(['createdAt'])
    expect(issuePaths(SessionSchema, { ...valid, cols: 0, rows: 1.5 })).toEqual(['cols', 'rows'])
  })

  it('rejects unknown keys and missing required fields', () => {
    expect(issuePaths(SessionSchema, { ...valid, pid: 42 })).toEqual([''])
    const { cwd: _cwd, ...withoutCwd } = valid
    expect(issuePaths(SessionSchema, withoutCwd)).toEqual(['cwd'])
  })

  it('round-trips through JSON', () => {
    const session = SessionSchema.parse({ ...valid, lifecycle: 'exited', exitCode: 0, args: ['--resume'] })
    expect(SessionSchema.parse(JSON.parse(JSON.stringify(session)))).toEqual(session)
  })
})
