import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  API_ROUTES,
  ApiErrorSchema,
  CreateSessionRequestSchema,
  DevicePublicKeySchema,
  deviceSignatureMessage,
  RegisterDeviceRequestSchema,
  DeletePresetResponseSchema,
  LaunchPresetResponseSchema,
  GetConfigResponseSchema,
  HealthResponseSchema,
  KillSessionResponseSchema,
  ListSessionsResponseSchema,
  PatchConfigResponseSchema,
  PresetParamsSchema,
  SessionTokenResponseSchema,
  ScopesResponseSchema,
  isZodError,
  toValidationError,
  UpsertPresetRequestSchema,
} from './api.js'
import { DEFAULT_CONFIG, EXAMPLE_PRESET } from './defaults.js'
import { issuePaths } from './test-utils.js'

const session = {
  id: 's1',
  hostId: 'local',
  cwd: '~/git/project1',
  command: 'claude',
  args: [],
  tmuxSession: 'paneful-manager-s1',
  createdAt: '2026-10-27T10:00:00.000Z',
  state: 'working',
  lifecycle: 'running',
  lastEventAt: '2026-10-27T10:00:01.000Z',
  cols: 120,
  rows: 30,
}

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown) => {
  const parsed = schema.parse(value)
  expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
}

describe('API routes', () => {
  it('live under /api', () => {
    for (const route of Object.values(API_ROUTES)) {
      expect(route.startsWith('/api/')).toBe(true)
    }
  })
})

describe('ApiErrorSchema', () => {
  it('accepts plain errors and validation errors', () => {
    expect(ApiErrorSchema.parse({ code: 'not_found', message: 'No such session' }).code).toBe('not_found')
    const error = ApiErrorSchema.parse({ code: 'validation_failed', message: 'bad', details: [{ path: ['cwd'], message: 'x' }] })
    expect(error.code === 'validation_failed' && error.details[0]?.path).toEqual(['cwd'])
  })

  it('accepts tmux_unavailable', () => {
    expect(ApiErrorSchema.parse({ code: 'tmux_unavailable', message: 'tmux server not running' }).code).toBe('tmux_unavailable')
  })

  it('requires details for validation errors and rejects unknown codes and keys', () => {
    expect(issuePaths(ApiErrorSchema, { code: 'validation_failed', message: 'bad' })).toEqual(['details'])
    expect(issuePaths(ApiErrorSchema, { code: 'teapot', message: 'x' })).toEqual(['code'])
    expect(issuePaths(ApiErrorSchema, { code: 'internal', message: 'x', stack: '...' })).toEqual([''])
  })

  it('is produced by toValidationError', () => {
    const result = CreateSessionRequestSchema.safeParse({ cwd: '', cols: 0 })
    if (result.success) {
      throw new Error('expected failure')
    }
    const error = ApiErrorSchema.parse(toValidationError(result.error))
    expect(error.code === 'validation_failed' && error.details.map(d => d.path.join('.'))).toEqual(['cwd', 'cols'])
  })
})

describe('health', () => {
  it('parses and round-trips', () => {
    roundTrip(HealthResponseSchema, { status: 'ok', name: 'Paneful Manager', version: '0.0.0', protocolVersion: 1, uptimeSec: 3.5, tmux: 'available' })
    expect(issuePaths(HealthResponseSchema, { status: 'down', name: 'a', version: '1', protocolVersion: 1, uptimeSec: 0, tmux: 'gone' })).toEqual([
      'status',
      'tmux',
    ])
  })
})

describe('sessions API', () => {
  it('rejects NUL in command and args and = in command', () => {
    const base = { cwd: '~/git/p1' }
    expect(issuePaths(CreateSessionRequestSchema, { ...base, command: 'cla\0ude' })).toEqual(['command'])
    expect(issuePaths(CreateSessionRequestSchema, { ...base, command: 'FOO=bar' })).toEqual(['command'])
    expect(issuePaths(CreateSessionRequestSchema, { ...base, command: '' })).toEqual(['command'])
    expect(issuePaths(CreateSessionRequestSchema, { ...base, args: ['ok', 'a\0b'] })).toEqual(['args.1'])
    expect(CreateSessionRequestSchema.parse({ ...base, command: 'sh', args: ['-c', 'X=1 env'] }).args).toEqual(['-c', 'X=1 env'])
  })

  it('applies create defaults', () => {
    expect(CreateSessionRequestSchema.parse({ cwd: '~/git/project1' })).toEqual({
      cwd: '~/git/project1',
      command: 'claude',
      args: [],
      cols: 120,
      rows: 30,
    })
  })

  it('rejects unknown keys in create requests', () => {
    expect(issuePaths(CreateSessionRequestSchema, { cwd: '~', shell: 'bash' })).toEqual([''])
  })

  it('round-trips list and kill responses', () => {
    roundTrip(ListSessionsResponseSchema, { sessions: [session] })
    roundTrip(KillSessionResponseSchema, { id: 's1', killed: true })
    expect(issuePaths(ListSessionsResponseSchema, { sessions: [{ ...session, state: 'x' }] })).toEqual(['sessions.0.state'])
  })
})

describe('presets API', () => {
  it('validates names and bodies', () => {
    expect(PresetParamsSchema.parse({ name: 'project1' })).toEqual({ name: 'project1' })
    expect(issuePaths(PresetParamsSchema, { name: 'a/b' })).toEqual(['name'])
    roundTrip(UpsertPresetRequestSchema, { preset: EXAMPLE_PRESET })
    expect(issuePaths(UpsertPresetRequestSchema, { preset: EXAMPLE_PRESET, force: true })).toEqual([''])
    roundTrip(DeletePresetResponseSchema, { name: 'project1', deleted: true })
  })

  it('describes a launch as tabs without ids', () => {
    const tab = { title: 'one', layout: { kind: 'row' }, panes: [{ sessionId: 'a' }, { sessionId: 'b', size: 2 }] }
    roundTrip(LaunchPresetResponseSchema, { name: 'project1', tabs: [tab] })
    expect(issuePaths(LaunchPresetResponseSchema, { name: 'project1', tabs: [] })).toEqual(['tabs'])
    expect(issuePaths(LaunchPresetResponseSchema, { name: 'project1', tabs: [{ ...tab, id: 'x' }] })).toEqual(['tabs.0'])
    expect(API_ROUTES.presetLaunch).toBe('/api/presets/:name/launch')
  })
})

describe('config API', () => {
  it('round-trips get and patch responses', () => {
    roundTrip(GetConfigResponseSchema, { config: DEFAULT_CONFIG })
    roundTrip(PatchConfigResponseSchema, { config: { ...DEFAULT_CONFIG, port: 8000 }, restartRequired: true })
    expect(issuePaths(PatchConfigResponseSchema, { config: DEFAULT_CONFIG })).toEqual(['restartRequired'])
  })
})

describe('isZodError', () => {
  it('detects zod errors only', () => {
    const result = z.string().safeParse(1)
    expect(!result.success && isZodError(result.error)).toBe(true)
    expect(isZodError(new Error('x'))).toBe(false)
  })
})

describe('session token', () => {
  it('parses and rejects empty or extra keys', () => {
    roundTrip(SessionTokenResponseSchema, { token: 'abc_-123' })
    expect(issuePaths(SessionTokenResponseSchema, { token: '' })).toEqual(['token'])
    expect(issuePaths(SessionTokenResponseSchema, { token: 'a', extra: 1 })).toEqual([''])
  })

  it('has fixed routes for the token bootstrap and hooks', () => {
    expect(API_ROUTES.sessionToken).toBe('/api/session-token')
    expect(API_ROUTES.hooks).toBe('/api/hooks')
    expect(API_ROUTES.hooksInstall).toBe('/api/hooks/install')
    expect(API_ROUTES.hooksUninstall).toBe('/api/hooks/uninstall')
    expect(API_ROUTES.hooksStatus).toBe('/api/hooks/status')
  })

  it('knows the auth error codes', () => {
    for (const code of ['unauthorized', 'forbidden']) {
      expect(ApiErrorSchema.parse({ code, message: 'x' }).code).toBe(code)
    }
  })
})

describe('scopes API', () => {
  it('parses all scope kinds and rejects unknown keys', () => {
    roundTrip(ScopesResponseSchema, {
      scopes: [
        { kind: 'global', path: '~/.claude' },
        { kind: 'project', path: '/p' },
        { kind: 'worktree', path: '/p-wt', branch: 'feat', projectPath: '/p' },
      ],
    })
    expect(ScopesResponseSchema.safeParse({ scopes: [], extra: 1 }).success).toBe(false)
  })
})

describe('device login', () => {
  const publicKey = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }

  it('accepts only a minimal P-256 public key', () => {
    expect(DevicePublicKeySchema.safeParse(publicKey).success).toBe(true)
    for (const bad of [{ ...publicKey, crv: 'P-384' }, { ...publicKey, kty: 'RSA' }, { ...publicKey, x: 'x' }, { ...publicKey, d: 'd'.repeat(43) }]) {
      expect(DevicePublicKeySchema.safeParse(bad).success).toBe(false)
    }
  })

  it('needs a long random login code', () => {
    expect(RegisterDeviceRequestSchema.safeParse({ code: 'c'.repeat(43), publicKey }).success).toBe(true)
    expect(RegisterDeviceRequestSchema.safeParse({ code: 'short', publicKey }).success).toBe(false)
  })

  it('binds signatures to the session context', () => {
    expect(deviceSignatureMessage('abc')).toBe('paneful-manager.session.v1\nabc')
  })
})
