import { describe, expect, it } from 'vitest'
import { issuePaths } from './test-utils.js'
import {
  ClientMessageSchema,
  parseClientMessage,
  parseServerMessage,
  ServerMessageSchema,
  WS_PROTOCOL_VERSION,
} from './ws.js'

const clientMessages = [
  { type: 'attach', sessionId: 's1', cols: 120, rows: 30, scrollback: false },
  { type: 'detach', sessionId: 's1' },
  { type: 'input', sessionId: 's1', data: 'ls -la\r' },
  { type: 'resize', sessionId: 's1', cols: 80, rows: 24 },
  { type: 'ping' },
]

const serverMessages = [
  { type: 'output', sessionId: 's1', data: '\u001b[32mok\u001b[0m äöü ✓\r\n' },
  { type: 'scrollback', sessionId: 's1', data: 'previous output\r\n' },
  { type: 'state', sessionId: 's1', state: 'waiting', lifecycle: 'running' },
  { type: 'state', sessionId: 's1', state: 'idle', lifecycle: 'exited', exitCode: 0 },
  {
    type: 'session.created',
    session: {
      id: 's1',
      hostId: 'local',
      cwd: '~/git/project1',
      command: 'claude',
      args: [],
      tmuxSession: 'agent-hub-s1',
      createdAt: '2026-10-27T10:00:00.000Z',
      state: 'idle',
      lifecycle: 'starting',
      lastEventAt: '2026-10-27T10:00:00.000Z',
      cols: 120,
      rows: 30,
    },
  },
  { type: 'session.removed', sessionId: 's1' },
  { type: 'error', code: 'bad_message', message: 'frame is not valid JSON' },
  { type: 'error', sessionId: 's1', code: 'unknown_session', message: 'No such session' },
  { type: 'pong' },
]

describe('WS protocol', () => {
  it('has a protocol version', () => {
    expect(WS_PROTOCOL_VERSION).toBe(1)
  })

  it('accepts every client message and round-trips it', () => {
    for (const message of clientMessages) {
      const parsed = ClientMessageSchema.parse(message)
      expect(ClientMessageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    }
  })

  it('accepts every server message and round-trips it', () => {
    for (const message of serverMessages) {
      const parsed = ServerMessageSchema.parse(message)
      expect(ServerMessageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    }
  })

  it('defaults attach scrollback to true', () => {
    expect(ClientMessageSchema.parse({ type: 'attach', sessionId: 's1', cols: 80, rows: 24 })).toMatchObject({
      scrollback: true,
    })
  })

  it('rejects invalid client messages with clear paths', () => {
    expect(issuePaths(ClientMessageSchema, { type: 'explode' })).toEqual(['type'])
    expect(issuePaths(ClientMessageSchema, { type: 'input', sessionId: 's1' })).toEqual(['data'])
    expect(issuePaths(ClientMessageSchema, { type: 'resize', sessionId: 's1', cols: 0, rows: 24 })).toEqual(['cols'])
    expect(issuePaths(ClientMessageSchema, { type: 'ping', extra: 1 })).toEqual([''])
  })

  it('allows exitCode in state messages only for exited sessions', () => {
    expect(
      issuePaths(ServerMessageSchema, { type: 'state', sessionId: 's1', state: 'idle', lifecycle: 'running', exitCode: 1 }),
    ).toEqual(['exitCode'])
  })

  it('rejects invalid server messages', () => {
    expect(issuePaths(ServerMessageSchema, { type: 'output', sessionId: 's1', data: 42 })).toEqual(['data'])
    expect(issuePaths(ServerMessageSchema, { type: 'error', code: 'oops', message: 'x' })).toEqual(['code'])
  })

  it('parses raw frames', () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ success: true, data: { type: 'ping' } })
    expect(parseClientMessage('not json')).toEqual({ success: false, error: 'frame is not valid JSON' })
    const bad = parseServerMessage('{"type":"pong","x":1}')
    expect(bad.success).toBe(false)
  })
})
