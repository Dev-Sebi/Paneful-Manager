import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@agent-hub/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './load-config.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-hub-config-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when the file is missing', async () => {
    const messages: string[] = []
    const config = await loadConfig({ env: {}, configDir: dir, logger: { info: (m: string) => void messages.push(m) } })
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(messages[0]).toContain('using defaults')
  })

  it('reads values from the file and keeps unknown keys', async () => {
    await writeFile(join(dir, 'config.yaml'), 'port: 8000\ntheme: light\nextra: 1\n')
    const config = await loadConfig({ env: {}, configDir: dir })
    expect(config).toMatchObject({ port: 8000, theme: 'light', extra: 1 })
  })

  it('throws a ConfigError naming the file for invalid YAML', async () => {
    const file = join(dir, 'config.yaml')
    await writeFile(file, 'port: [unclosed\n')
    const error = await loadConfig({ env: {}, configDir: dir }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toContain(file)
  })

  it('lists the issue path for schema violations', async () => {
    await writeFile(join(dir, 'config.yaml'), 'port: 99999\nexperimental:\n  agentTeams: maybe\n')
    const error = await loadConfig({ env: {}, configDir: dir }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as Error).message
    expect(message).toContain('port:')
    expect(message).toContain('experimental.agentTeams:')
    expect(message).toContain('config.yaml')
  })

  it('lets AGENT_HUB_PORT win over the file', async () => {
    await writeFile(join(dir, 'config.yaml'), 'port: 8000\n')
    const config = await loadConfig({ env: { AGENT_HUB_PORT: '9000' }, configDir: dir })
    expect(config.port).toBe(9000)
  })

  it('rejects an invalid AGENT_HUB_PORT with a ConfigError', async () => {
    await expect(loadConfig({ env: { AGENT_HUB_PORT: 'abc' }, configDir: dir })).rejects.toBeInstanceOf(ConfigError)
  })

  it('respects XDG_CONFIG_HOME', async () => {
    await mkdir(join(dir, 'agent-hub'))
    await writeFile(join(dir, 'agent-hub', 'config.yaml'), 'port: 8123\n')
    const config = await loadConfig({ env: { XDG_CONFIG_HOME: dir } })
    expect(config.port).toBe(8123)
  })
})
