import { describe, expect, it } from 'vitest'
import { AppConfigSchema } from './config.js'
import { BIND_HOST, CONFIG_FILE, DEFAULT_CONFIG, DEFAULT_PORT, EXAMPLE_PRESET, WORKSPACES_DIR } from './defaults.js'
import { WorkspacePresetSchema } from './preset.js'

describe('defaults', () => {
  it('uses port 7337 on loopback', () => {
    expect(DEFAULT_PORT).toBe(7337)
    expect(BIND_HOST).toBe('127.0.0.1')
  })

  it('points to the config locations', () => {
    expect(CONFIG_FILE).toBe('~/.config/paneful-manager/config.yaml')
    expect(WORKSPACES_DIR).toBe('~/.config/paneful-manager/workspaces')
  })

  it('DEFAULT_CONFIG equals the schema defaults', () => {
    expect(AppConfigSchema.parse({})).toEqual(DEFAULT_CONFIG)
  })

  it('EXAMPLE_PRESET is valid and unchanged by parsing', () => {
    expect(WorkspacePresetSchema.parse(EXAMPLE_PRESET)).toEqual(EXAMPLE_PRESET)
    expect(EXAMPLE_PRESET.tabs[0]?.panes).toHaveLength(4)
  })
})
