import { describe, expect, it } from 'vitest'
import * as shared from './index.js'

describe('index', () => {
  it('re-exports the app name, schemas and constants', () => {
    expect(shared.APP_NAME).toBe('Agent Hub')
    expect(shared.DEFAULT_PORT).toBe(7337)
    expect(shared.WS_PROTOCOL_VERSION).toBe(1)
    for (const name of [
      'AppConfigSchema',
      'WorkspacePresetSchema',
      'SessionSchema',
      'LayoutSchema',
      'McpServerEntrySchema',
      'UpsertMcpServerRequestSchema',
      'ScopeSchema',
      'ApiErrorSchema',
      'ClientMessageSchema',
      'ServerMessageSchema',
      'FileEntrySchema',
      'FileChangedMessageSchema',
    ]) {
      expect(shared).toHaveProperty(name)
    }
  })
})
