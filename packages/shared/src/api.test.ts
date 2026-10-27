import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  API_ROUTES,
  ApiErrorSchema,
  CreateSessionRequestSchema,
  DeletePresetResponseSchema,
  GetConfigResponseSchema,
  HealthResponseSchema,
  KillSessionResponseSchema,
  ListSessionsResponseSchema,
  PatchConfigResponseSchema,
  PresetParamsSchema,
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
  tmuxSession: 'agent-hub-s1',
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
    roundTrip(HealthResponseSchema, { status: 'ok', name: 'Agent Hub', version: '0.0.0', protocolVersion: 1, uptimeSec: 3.5 })
    expect(issuePaths(HealthResponseSchema, { status: 'down', name: 'a', version: '1', protocolVersion: 1, uptimeSec: 0 })).toEqual([
      'status',
    ])
  })
})

describe('sessions API', () => {
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
