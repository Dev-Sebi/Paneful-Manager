import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { AppConfigSchema, applyConfigPatch, ConfigPatchSchema, resolveConfigDir, resolvePort } from './config.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { issuePaths } from './test-utils.js'

describe('AppConfigSchema', () => {
  it('applies all defaults to an empty file', () => {
    expect(AppConfigSchema.parse({})).toEqual({
      port: 7337,
      experimental: { agentTeams: false },
      confirmCloseTab: true,
      projects: [],
      logLevel: 'info',
      theme: 'dark',
    })
  })

  it('fills nested defaults when experimental is partially set', () => {
    expect(AppConfigSchema.parse({ experimental: {} }).experimental).toEqual({ agentTeams: false })
  })

  it('parses a full YAML config', () => {
    const config = AppConfigSchema.parse(
      parse(`
port: 8080
experimental:
  agentTeams: true
confirmCloseTab: false
projects:
  - ~/git/project1
logLevel: debug
theme: system
`),
    )
    expect(config).toMatchObject({ port: 8080, experimental: { agentTeams: true }, theme: 'system' })
    expect(config.projects).toEqual(['~/git/project1'])
  })

  it('keeps unknown keys from the user file', () => {
    expect(AppConfigSchema.parse({ futureOption: 1 })).toMatchObject({ futureOption: 1 })
  })

  it('rejects invalid values with their paths', () => {
    expect(issuePaths(AppConfigSchema, { port: 70000 })).toEqual(['port'])
    expect(issuePaths(AppConfigSchema, { theme: 'blue' })).toEqual(['theme'])
    expect(issuePaths(AppConfigSchema, { logLevel: 'loud' })).toEqual(['logLevel'])
    expect(issuePaths(AppConfigSchema, { experimental: { agentTeams: 'on' } })).toEqual(['experimental.agentTeams'])
    expect(issuePaths(AppConfigSchema, { projects: [''] })).toEqual(['projects.0'])
  })

  it('round-trips through YAML', () => {
    const config = AppConfigSchema.parse({ port: 9000, projects: ['~/git/project1'] })
    expect(AppConfigSchema.parse(parse(stringify(config)))).toEqual(config)
  })
})

describe('ConfigPatchSchema', () => {
  it('accepts partial patches and rejects unknown keys', () => {
    expect(ConfigPatchSchema.parse({ theme: 'light' })).toEqual({ theme: 'light' })
    expect(issuePaths(ConfigPatchSchema, { colour: 'red' })).toEqual([''])
    expect(issuePaths(ConfigPatchSchema, { experimental: { other: true } })).toEqual(['experimental'])
  })

  it('merges into a config without mutating it', () => {
    const base = structuredClone(DEFAULT_CONFIG)
    const next = applyConfigPatch(base, { experimental: { agentTeams: true }, port: 8000 })
    expect(next).toMatchObject({ port: 8000, experimental: { agentTeams: true }, theme: 'dark' })
    expect(base).toEqual(DEFAULT_CONFIG)
  })
})

describe('resolvePort', () => {
  it('prefers a valid env value', () => {
    expect(resolvePort(7337, undefined)).toBe(7337)
    expect(resolvePort(7337, '')).toBe(7337)
    expect(resolvePort(7337, '9000')).toBe(9000)
  })

  it('throws a clear error on invalid env values', () => {
    for (const value of ['0', '70000', '80.5', '1e3', 'abc']) {
      expect(() => resolvePort(7337, value)).toThrow(`Invalid AGENT_HUB_PORT "${value}": expected an integer between 1 and 65535`)
    }
  })

  it('accepts the bounds', () => {
    expect(resolvePort(7337, '1')).toBe(1)
    expect(resolvePort(7337, '65535')).toBe(65535)
  })
})

describe('resolveConfigDir', () => {
  it('falls back to ~/.config without XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({})).toBe('~/.config/agent-hub')
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '  ' })).toBe('~/.config/agent-hub')
  })

  it('respects XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/home/dev/.cfg' })).toBe('/home/dev/.cfg/agent-hub')
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/home/dev/.cfg/' })).toBe('/home/dev/.cfg/agent-hub')
  })
})
