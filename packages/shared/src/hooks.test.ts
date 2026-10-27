import { describe, expect, it } from 'vitest'
import {
  HOOK_EVENTS,
  HOOK_NOTIFICATION_MATCHER,
  HOOK_URL_PATTERN,
  HookChangeResponseSchema,
  HookPayloadSchema,
  hookTriggersPoll,
  hookUrl,
  mapHookEvent,
} from './hooks.js'

describe('mapHookEvent', () => {
  it.each([
    ['SessionStart', null],
    ['UserPromptSubmit', 'working'],
    ['PreToolUse', 'working'],
    ['PostToolUse', 'working'],
    ['PostToolUseFailure', 'working'],
    ['PermissionRequest', 'waiting'],
    ['Stop', 'idle'],
    ['SubagentStop', null],
    ['StopFailure', 'error'],
    ['SessionEnd', 'idle'],
    ['SubagentStart', null],
    ['PreCompact', null],
    ['TeammateIdle', null],
    ['toString', null],
    ['', null],
  ])('%s -> %s', (event, state) => {
    expect(mapHookEvent(event, {})).toBe(state)
  })

  it.each([
    ['permission_prompt', 'waiting'],
    ['idle_prompt', 'idle'],
    ['elicitation_dialog', 'waiting'],
    ['elicitation_url_dialog', 'waiting'],
    ['auth_success', null],
    ['agent_completed', null],
  ])('Notification %s -> %s', (type, state) => {
    expect(mapHookEvent('Notification', { notification_type: type })).toBe(state)
  })

  it('ignores a Notification without a string type', () => {
    expect(mapHookEvent('Notification')).toBeNull()
    expect(mapHookEvent('Notification', { notification_type: 1 })).toBeNull()
  })

  it('polls only after SessionEnd', () => {
    expect(HOOK_EVENTS.filter(event => hookTriggersPoll(event))).toEqual(['SessionEnd'])
  })
})

describe('hook constants', () => {
  it('installs every mapped event plus Notification', () => {
    expect(HOOK_EVENTS).toContain('Notification')
    expect(HOOK_EVENTS).not.toContain('SessionStart')
    expect(HOOK_EVENTS).not.toContain('SubagentStop')
    for (const event of HOOK_EVENTS.filter(name => name !== 'Notification')) {
      expect(mapHookEvent(event)).not.toBeNull()
    }
  })

  it('uses an exact-match notification matcher', () => {
    expect(HOOK_NOTIFICATION_MATCHER).toBe('permission_prompt|elicitation_dialog|elicitation_url_dialog|idle_prompt')
  })

  it('builds the loopback hook URL that the pattern recognizes for any port', () => {
    expect(hookUrl(7337)).toBe('http://127.0.0.1:7337/api/hooks')
    expect(HOOK_URL_PATTERN.test(hookUrl(1))).toBe(true)
    expect(HOOK_URL_PATTERN.test('http://localhost:7337/api/hooks')).toBe(false)
    expect(HOOK_URL_PATTERN.test('http://127.0.0.1:7337/api/hooks/x')).toBe(false)
  })
})

describe('HookPayloadSchema', () => {
  it('needs hook_event_name and keeps unknown fields', () => {
    const payload = HookPayloadSchema.parse({ hook_event_name: 'Stop', session_id: 'abc', stop_hook_active: false })
    expect(payload).toEqual({ hook_event_name: 'Stop', session_id: 'abc', stop_hook_active: false })
    expect(HookPayloadSchema.safeParse({ session_id: 'abc' }).success).toBe(false)
    expect(HookPayloadSchema.safeParse({ hook_event_name: '' }).success).toBe(false)
  })
})

describe('HookChangeResponseSchema', () => {
  it('accepts a status with reasons and rejects unknown codes', () => {
    const status = {
      settingsPath: '/home/u/.claude/settings.json',
      installed: false,
      portMatches: true,
      installedEvents: [],
      statusAvailable: false,
      reasons: [{ code: 'not_installed', source: '/home/u/.claude/settings.json', message: 'Hooks are not installed' }],
    }
    expect(HookChangeResponseSchema.safeParse({ changed: true, status }).success).toBe(true)
    const bad = { ...status, reasons: [{ ...status.reasons[0], code: 'nope' }] }
    expect(HookChangeResponseSchema.safeParse({ changed: true, status: bad }).success).toBe(false)
  })
})
